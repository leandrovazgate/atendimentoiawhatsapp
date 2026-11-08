import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelRegistry } from "../src/channels/registry.js";
import { WhatsAppClient } from "../src/channels/whatsapp.js";
import { Store } from "../src/store/db.js";
import { TomTicketClient } from "../src/integrations/tomticket.js";
import { SupportAgent } from "../src/agent/agent.js";
import { MessageProcessor } from "../src/conversation/processor.js";
import { buildServer } from "../src/server.js";
import { fakeAnthropic, fakeFetch, sign, testConfig, webhookPayload } from "./helpers.js";

const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const text = (t: string) => ({ type: "text", text: t });

function setup(script: Parameters<typeof fakeAnthropic>[0], opts: { customerPhone?: string } = {}) {
  const config = testConfig();
  const tt = fakeFetch({
    "customer/details": () => ({
      error: false,
      data: {
        id: "c1",
        name: "Maria Souza",
        email: "maria@cliente.com.br",
        phone: opts.customerPhone ?? "(11) 98888-7777",
        organization: { name: "Cliente Ltda" },
      },
    }),
    "ticket/new": () => ({ error: false, data: { id: "t-99", protocol: 1234 } }),
    "ticket/list": () => ({
      error: false,
      data: [{ id: "t-1", protocol: 1200, subject: "VPN não conecta", situation: 2, priority: 3 }],
      size: 1,
    }),
    "ticket/detail": () => ({
      error: false,
      data: { id: "t-1", protocol: 1200, subject: "VPN não conecta", replies: [{ date: "2026-11-07", message: "<p>Aguardando teste</p>" }] },
    }),
  });
  const wa = fakeFetch({ "graph.facebook.com": () => ({ messages: [{ id: "out" }] }) });
  const hooks = fakeFetch({ "hooks.test": () => ({}) });
  const routeFetch = (async (input: string | URL, init?: RequestInit) =>
    String(input).includes("hooks.test") ? hooks.impl(input, init) : wa.impl(input, init)) as typeof fetch;

  const channels = ChannelRegistry.fromEnv({ WHATSAPP_PHONE_NUMBER_ID: "PNID-1", WHATSAPP_ACCESS_TOKEN: "wa-token" });
  const store = new Store(":memory:");
  const tomticket = new TomTicketClient(config.tomticket.baseUrl, config.tomticket.token, tt.impl);
  const whatsapp = new WhatsAppClient("v23.0", routeFetch);
  const { client, requests } = fakeAnthropic(script);
  const agent = new SupportAgent(client, config);
  const logs: string[] = [];
  const processor = new MessageProcessor({
    config,
    channels,
    whatsapp,
    store,
    tomticket,
    agent,
    log: (m) => logs.push(m),
    fetchImpl: routeFetch,
  });
  const app = buildServer({ config, store, processor, logger: false });

  const sent = () =>
    wa.calls.filter((c) => c.json?.type === "text").map((c) => c.json.text.body as string);

  async function send(textBody: string, id: string) {
    const body = JSON.stringify(webhookPayload(textBody, { id }));
    const res = await app.inject({
      method: "POST",
      url: "/webhook/whatsapp",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
      payload: body,
    });
    assert.equal(res.statusCode, 200);
    await processor.drain();
  }

  return { app, store, tt, wa, hooks, requests, sent, send, logs };
}

test("fluxo completo: identifica pelo e-mail, confirma e abre o chamado", async () => {
  const s = setup([
    { content: [text("Olá! Sou o Gate. Qual o seu e-mail cadastrado?")], stop_reason: "end_turn" },
    { content: [toolUse("tu1", "identificar_cliente", { email: "Maria@Cliente.com.br" })], stop_reason: "tool_use" },
    { content: [text("Obrigado, Maria! O que está acontecendo?")], stop_reason: "end_turn" },
    { content: [text("*Resumo do chamado* ... Posso abrir o chamado?")], stop_reason: "end_turn" },
    {
      content: [
        toolUse("tu2", "abrir_chamado", {
          assunto: "Impressora do financeiro não imprime",
          descricao: "Impressora HP do financeiro parou desde hoje cedo. 3 pessoas afetadas.",
          prioridade: "alta",
          confirmado_pelo_cliente: true,
        }),
      ],
      stop_reason: "tool_use",
    },
    { content: [text("Pronto! Chamado #1234 aberto.")], stop_reason: "end_turn" },
  ]);

  await s.send("Oi", "w1");
  await s.send("maria@cliente.com.br", "w2");
  await s.send("A impressora do financeiro parou", "w3");
  await s.send("Sim, pode abrir", "w4");

  assert.deepEqual(s.sent(), [
    "Olá! Sou o Gate. Qual o seu e-mail cadastrado?",
    "Obrigado, Maria! O que está acontecendo?",
    "*Resumo do chamado* ... Posso abrir o chamado?",
    "Pronto! Chamado #1234 aberto.",
  ]);

  const lookup = s.tt.calls.find((c) => c.url.includes("customer/details"))!;
  assert.match(lookup.url, /customer_id=maria%40cliente\.com\.br/);
  assert.match(lookup.url, /customer_type_id=E/);

  const created = s.tt.calls.find((c) => c.url.includes("ticket/new"))!;
  assert.equal(created.method, "POST");
  assert.equal(created.form!.customer_id, "maria@cliente.com.br");
  assert.equal(created.form!.customer_id_type, "E");
  assert.equal(created.form!.department_id, "dep-1");
  assert.equal(created.form!.priority, "3");
  assert.match(created.form!.message, /Aberto pelo assistente virtual via WhatsApp/);

  const toolResult = JSON.parse(s.requests[5].messages.at(-1).content[0].content);
  assert.deepEqual(toolResult, { ok: true, protocolo: "1234" });

  const contact = s.store.getContact("PNID-1", "551188887777")!;
  assert.equal(contact.phoneVerified, true);
  assert.equal(contact.organization, "Cliente Ltda");
});

test("requisição ao Claude: cache, effort, fallback e contexto do turno", async () => {
  const s = setup([{ content: [text("Olá!")], stop_reason: "end_turn" }]);
  await s.send("Oi", "w1");
  const req = s.requests[0];
  assert.equal(req.model, "claude-opus-5-5");
  assert.deepEqual(req.output_config, { effort: "low" });
  assert.equal(req.fallbacks, "default");
  assert.deepEqual(req.betas, ["server-side-fallback-2026-07-01"]);
  assert.deepEqual(req.cache_control, { type: "ephemeral" });
  assert.equal(req.system[0].cache_control.type, "ephemeral");
  assert.equal(req.messages[0].role, "user");
  assert.equal(req.messages[1].role, "system");
  assert.match(req.messages[1].content, /Cliente ainda não identificado/);
});

test("não abre chamado sem confirmação do cliente", async () => {
  const s = setup([
    { content: [toolUse("a", "identificar_cliente", { email: "maria@cliente.com.br" })], stop_reason: "tool_use" },
    {
      content: [toolUse("b", "abrir_chamado", { assunto: "x", descricao: "y", prioridade: "baixa", confirmado_pelo_cliente: false })],
      stop_reason: "tool_use",
    },
    { content: [text("Antes, confirme o resumo.")], stop_reason: "end_turn" },
  ]);
  await s.send("maria@cliente.com.br, preciso de ajuda", "w1");
  assert.equal(s.tt.calls.some((c) => c.url.includes("ticket/new")), false);
  const result = JSON.parse(s.requests[2].messages.at(-1).content[0].content);
  assert.equal(result.ok, false);
});

test("não abre chamado sem cliente identificado", async () => {
  const s = setup([
    {
      content: [toolUse("b", "abrir_chamado", { assunto: "x", descricao: "y", prioridade: "baixa", confirmado_pelo_cliente: true })],
      stop_reason: "tool_use",
    },
    { content: [text("Qual o seu e-mail?")], stop_reason: "end_turn" },
  ]);
  await s.send("abre um chamado", "w1");
  assert.equal(s.tt.calls.some((c) => c.url.includes("ticket/new")), false);
});

test("consulta de chamado só do próprio cliente e com WhatsApp conferido", async () => {
  const s = setup([
    { content: [toolUse("a", "identificar_cliente", { email: "maria@cliente.com.br" })], stop_reason: "tool_use" },
    { content: [toolUse("b", "consultar_chamado", { protocolo: 1200 })], stop_reason: "tool_use" },
    { content: [text("Seu chamado #1200 está aguardando sua resposta.")], stop_reason: "end_turn" },
  ]);
  await s.send("maria@cliente.com.br — como está o chamado 1200?", "w1");
  const list = s.tt.calls.find((c) => c.url.includes("ticket/list"))!;
  assert.match(list.url, /customer_id=maria%40cliente\.com\.br/);
  assert.match(list.url, /min_protocol=1200/);
  const result = JSON.parse(s.requests[2].messages.at(-1).content[0].content);
  assert.equal(result.ok, true);
  assert.equal(result.chamado.protocol, "1200");
  assert.equal(result.chamado.situation, "Aguardando resposta do cliente");
  assert.equal(result.chamado.ultimo_andamento, "2026-11-07: Aguardando teste");
  assert.equal(result.chamado.id, undefined);
});

test("bloqueia consulta quando o WhatsApp não consta no cadastro", async () => {
  const s = setup(
    [
      { content: [toolUse("a", "identificar_cliente", { email: "maria@cliente.com.br" })], stop_reason: "tool_use" },
      { content: [toolUse("b", "listar_chamados", { apenas_abertos: true })], stop_reason: "tool_use" },
      { content: [text("Por segurança não consigo consultar por aqui.")], stop_reason: "end_turn" },
    ],
    { customerPhone: "(21) 3333-4444" },
  );
  await s.send("maria@cliente.com.br quero ver meus chamados", "w1");
  assert.equal(s.tt.calls.some((c) => c.url.includes("ticket/list")), false);
  const result = JSON.parse(s.requests[2].messages.at(-1).content[0].content);
  assert.equal(result.ok, false);
});

test("transferência para humano avisa a equipe e silencia o robô", async () => {
  const s = setup([
    {
      content: [toolUse("h", "transferir_para_humano", { motivo: "Cliente pediu", resumo: "Quer falar com técnico", urgente: false, protocolo: null })],
      stop_reason: "tool_use",
    },
    { content: [text("Certo! Um técnico vai continuar por aqui.")], stop_reason: "end_turn" },
  ]);
  await s.send("quero falar com uma pessoa", "w1");
  await s.send("alô?", "w2"); // robô em silêncio: o roteiro acabou e não deve ser chamado
  assert.equal(s.hooks.calls.length, 1);
  assert.match(s.hooks.calls[0].json.text, /precisa de um técnico/);
  assert.deepEqual(s.sent(), ["Certo! Um técnico vai continuar por aqui."]);
  assert.equal(s.requests.length, 2);

  // técnico devolve a conversa ao robô
  const res = await s.app.inject({
    method: "POST",
    url: "/admin/resume",
    headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    payload: JSON.stringify({ channel_id: "PNID-1", wa_id: "551188887777" }),
  });
  assert.equal(res.json().conversas_reativadas, 1);
});

test("webhook: rejeita assinatura inválida, ignora reenvio e verifica token", async () => {
  const s = setup([{ content: [text("Olá!")], stop_reason: "end_turn" }]);
  const body = JSON.stringify(webhookPayload("Oi", { id: "dup" }));
  const bad = await s.app.inject({
    method: "POST",
    url: "/webhook/whatsapp",
    headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00" },
    payload: body,
  });
  assert.equal(bad.statusCode, 401);

  await s.send("Oi", "dup");
  await s.send("Oi", "dup"); // mesmo id: a Meta reenviou
  assert.equal(s.requests.length, 1);

  const ok = await s.app.inject({ method: "GET", url: "/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42" });
  assert.equal(ok.body, "42");
  const no = await s.app.inject({ method: "GET", url: "/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=42" });
  assert.equal(no.statusCode, 403);
});

test("falha do Claude: pede desculpas, avisa a equipe e não perde a conversa", async () => {
  const s = setup([]); // roteiro vazio => create() lança erro
  await s.send("Oi", "w1");
  assert.equal(s.sent().length, 1);
  assert.match(s.sent()[0], /problema técnico/);
  assert.equal(s.hooks.calls.length, 1);
});

test("depois de uma falha do Claude, a conversa continua funcionando", async () => {
  const s = setup([new Error("API indisponível"), { content: [text("Olá de novo!")], stop_reason: "end_turn" }]);
  await s.send("Oi", "w1");
  assert.match(s.sent()[0], /problema técnico/);

  // técnico devolve a conversa ao robô; a próxima mensagem deve funcionar normalmente
  await s.app.inject({
    method: "POST",
    url: "/admin/resume",
    headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    payload: JSON.stringify({ channel_id: "PNID-1", wa_id: "551188887777" }),
  });
  await s.send("Tudo bem?", "w2");
  assert.equal(s.sent()[1], "Olá de novo!");
  const msgs = s.requests[1].messages;
  assert.deepEqual(
    msgs.map((m: any) => m.role),
    ["user", "system"],
    "o turno que falhou não pode ficar no histórico",
  );
  assert.equal(msgs[0].content, "Tudo bem?");
});
