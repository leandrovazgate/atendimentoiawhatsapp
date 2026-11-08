/**
 * Ferramentas que o Claude pode chamar. Toda regra de segurança é aplicada aqui,
 * no código — o modelo só enxerga dados do cliente identificado nesta conversa.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { AppConfig } from "../config.js";
import type { Channel } from "../channels/registry.js";
import type { Contact, Session, Store } from "../store/db.js";
import { PRIORITY, type PriorityName, type TomTicketClient, summarizeTicket } from "../integrations/tomticket.js";
import { notifyTeam } from "../handoff/notify.js";
import { samePhone } from "../util.js";

export interface ToolContext {
  config: AppConfig;
  channel: Channel;
  waId: string;
  profileName?: string;
  store: Store;
  tomticket: TomTicketClient;
  session: Session;
  log: (msg: string, data?: unknown) => void;
  fetchImpl?: typeof fetch;
}

const MAX_IDENTIFY_ATTEMPTS = 3;

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "identificar_cliente",
    description:
      "Procura o cliente no TomTicket pelo e-mail cadastrado e o vincula a este WhatsApp. Use antes de abrir ou consultar chamados quando não houver cliente identificado.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { email: { type: "string", description: "E-mail informado pelo cliente." } },
      required: ["email"],
      additionalProperties: false,
    },
  },
  {
    name: "abrir_chamado",
    description:
      "Abre um chamado no TomTicket para o cliente identificado. Só chame depois de mostrar o resumo e o cliente confirmar.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        assunto: { type: "string", description: "Título curto e objetivo (até ~80 caracteres)." },
        descricao: {
          type: "string",
          description:
            "Descrição estruturada para o técnico: problema, desde quando, pessoas afetadas, mensagens de erro, equipamento/sistema, o que já foi tentado.",
        },
        prioridade: { type: "string", enum: Object.keys(PRIORITY) },
        confirmado_pelo_cliente: {
          type: "boolean",
          description: "true somente se o cliente confirmou explicitamente o resumo.",
        },
      },
      required: ["assunto", "descricao", "prioridade", "confirmado_pelo_cliente"],
      additionalProperties: false,
    },
  },
  {
    name: "listar_chamados",
    description: "Lista os chamados do cliente identificado (mais recentes primeiro).",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        apenas_abertos: { type: "boolean", description: "true para listar só chamados em andamento." },
      },
      required: ["apenas_abertos"],
      additionalProperties: false,
    },
  },
  {
    name: "consultar_chamado",
    description: "Consulta a situação e o último andamento de um chamado do cliente pelo número do protocolo.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { protocolo: { type: "integer", description: "Número do protocolo do chamado." } },
      required: ["protocolo"],
      additionalProperties: false,
    },
  },
  {
    name: "complementar_chamado",
    description: "Adiciona uma informação nova enviada pelo cliente a um chamado dele que esteja em aberto.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        protocolo: { type: "integer" },
        mensagem: { type: "string", description: "Complemento, redigido de forma clara para o técnico." },
      },
      required: ["protocolo", "mensagem"],
      additionalProperties: false,
    },
  },
  {
    name: "transferir_para_humano",
    description:
      "Aciona um técnico humano para continuar este atendimento pelo WhatsApp. O robô para de responder esta conversa por algumas horas.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        motivo: { type: "string", description: "Por que está transferindo." },
        resumo: { type: "string", description: "Resumo do atendimento até aqui, para o técnico." },
        urgente: { type: "boolean" },
        protocolo: { type: ["integer", "null"], description: "Protocolo relacionado, se houver." },
      },
      required: ["motivo", "resumo", "urgente", "protocolo"],
      additionalProperties: false,
    },
  },
];

type Result = { ok: boolean; [k: string]: unknown };

function countToolUses(messages: unknown[], name: string): number {
  let n = 0;
  for (const m of messages as Array<{ role?: string; content?: unknown }>) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content as Array<{ type?: string; name?: string }>) {
      if (b.type === "tool_use" && b.name === name) n++;
    }
  }
  return n;
}

function requireContact(ctx: ToolContext): Contact | Result {
  const contact = ctx.store.getContact(ctx.channel.phoneNumberId, ctx.waId);
  if (!contact) return { ok: false, erro: "Cliente ainda não identificado. Peça o e-mail cadastrado e use identificar_cliente." };
  return contact;
}

function canLookup(ctx: ToolContext, contact: Contact): Result | null {
  if (contact.phoneVerified || !ctx.config.tomticket.requirePhoneMatchForLookup) return null;
  return {
    ok: false,
    erro:
      "Por segurança, a consulta de chamados só é liberada quando este WhatsApp consta no cadastro do cliente no TomTicket. " +
      "Explique isso ao cliente, informe que ele recebe as atualizações dos chamados no e-mail cadastrado e ofereça acionar um técnico.",
  };
}

async function findOwnTicket(ctx: ToolContext, contact: Contact, protocol: number) {
  const list = await ctx.tomticket.listCustomerTickets(contact.email, { protocol });
  return list.find((t) => t.protocol === String(protocol)) ?? null;
}

export async function runTool(name: string, input: Record<string, any>, ctx: ToolContext): Promise<Result> {
  const { config, channel, waId, store, tomticket } = ctx;

  switch (name) {
    case "identificar_cliente": {
      // conta a chamada atual, que já está no histórico
      if (countToolUses(ctx.session.messages, "identificar_cliente") > MAX_IDENTIFY_ATTEMPTS) {
        return { ok: false, erro: "Limite de tentativas de identificação atingido. Transfira para um humano." };
      }
      const email = String(input.email ?? "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, erro: "E-mail em formato inválido." };
      const customer = await tomticket.findCustomerByEmail(email);
      if (!customer) return { ok: false, encontrado: false, erro: "Nenhum cliente cadastrado com este e-mail." };
      const phoneVerified = customer.phones.some((p) => samePhone(p, waId));
      store.saveContact({
        channelId: channel.phoneNumberId,
        waId,
        email: customer.email.toLowerCase(),
        name: customer.name,
        organization: customer.organization,
        phoneVerified,
      });
      return {
        ok: true,
        encontrado: true,
        nome: customer.name,
        email: customer.email,
        empresa: customer.organization ?? "não informada no cadastro",
        whatsapp_confere_com_cadastro: phoneVerified,
      };
    }

    case "abrir_chamado": {
      const contact = requireContact(ctx);
      if ("ok" in contact) return contact;
      if (input.confirmado_pelo_cliente !== true) {
        return { ok: false, erro: "Mostre o resumo e aguarde a confirmação do cliente antes de abrir o chamado." };
      }
      const priority = String(input.prioridade) as PriorityName;
      if (!(priority in PRIORITY)) return { ok: false, erro: "Prioridade inválida." };
      const message =
        `${String(input.descricao).trim()}\n\n` +
        `---\nAberto pelo assistente virtual via WhatsApp (${channel.label}).\n` +
        `Contato: ${contact.name ?? ctx.profileName ?? "-"} — +${waId}` +
        `${contact.phoneVerified ? "" : " (número não consta no cadastro)"}`;
      const created = await tomticket.createTicket({
        customerEmail: contact.email,
        departmentId: channel.tomticketDepartmentId ?? config.tomticket.departmentId,
        categoryId: channel.tomticketCategoryId ?? config.tomticket.categoryId,
        subject: String(input.assunto),
        message,
        priority,
      });
      store.auditTicket({
        channelId: channel.phoneNumberId,
        waId,
        email: contact.email,
        ticketId: created.id,
        protocol: created.protocol,
        subject: String(input.assunto),
        priority,
      });
      ctx.log("chamado aberto", { protocol: created.protocol, id: created.id, priority });
      return {
        ok: true,
        protocolo: created.protocol ?? null,
        observacao: created.protocol
          ? undefined
          : "Chamado criado, mas a API não retornou o protocolo. Diga ao cliente que ele recebe o número no e-mail.",
      };
    }

    case "listar_chamados": {
      const contact = requireContact(ctx);
      if ("ok" in contact) return contact;
      const denied = canLookup(ctx, contact);
      if (denied) return denied;
      const list = await tomticket.listCustomerTickets(contact.email, { onlyOpen: input.apenas_abertos === true });
      return {
        ok: true,
        total: list.length,
        chamados: list.slice(0, 10).map(({ id: _id, ...rest }) => rest),
      };
    }

    case "consultar_chamado": {
      const contact = requireContact(ctx);
      if ("ok" in contact) return contact;
      const denied = canLookup(ctx, contact);
      if (denied) return denied;
      const ticket = await findOwnTicket(ctx, contact, Number(input.protocolo));
      if (!ticket) return { ok: false, erro: "Não há chamado com este protocolo no cadastro deste cliente." };
      let ultimoAndamento: string | undefined;
      if (ticket.id) {
        const detail = await tomticket.getTicketDetail(ticket.id);
        Object.assign(ticket, { ...summarizeTicket(detail), ...stripEmpty(ticket) });
        ultimoAndamento = lastReply(detail);
      }
      const { id: _id, ...rest } = ticket;
      return { ok: true, chamado: { ...rest, ultimo_andamento: ultimoAndamento } };
    }

    case "complementar_chamado": {
      const contact = requireContact(ctx);
      if ("ok" in contact) return contact;
      const ticket = await findOwnTicket(ctx, contact, Number(input.protocolo));
      if (!ticket?.id) return { ok: false, erro: "Não há chamado com este protocolo no cadastro deste cliente." };
      await tomticket.replyAsCustomer(ticket.id, `${String(input.mensagem).trim()}\n\n(enviado pelo WhatsApp +${waId})`);
      return { ok: true };
    }

    case "transferir_para_humano": {
      const contact = store.getContact(channel.phoneNumberId, waId);
      ctx.session.handoffUntil = Date.now() + config.agent.handoffPauseHours * 3600_000;
      const notified = await notifyTeam(
        config.handoff.webhookUrl,
        {
          channelLabel: channel.label,
          customerPhone: waId,
          customerName: contact?.name ?? ctx.profileName,
          customerEmail: contact?.email,
          organization: contact?.organization,
          reason: String(input.motivo),
          summary: String(input.resumo),
          urgent: input.urgente === true,
          ticketProtocol: input.protocolo ? String(input.protocolo) : undefined,
        },
        ctx.log,
        ctx.fetchImpl,
      );
      return { ok: true, equipe_notificada: notified };
    }

    default:
      return { ok: false, erro: `Ferramenta desconhecida: ${name}` };
  }
}

function stripEmpty<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Tenta extrair o texto da última resposta do detalhe do chamado (formato varia). */
function lastReply(detail: Record<string, unknown>): string | undefined {
  for (const key of ["replies", "answers", "messages", "interactions"]) {
    const arr = detail[key];
    if (Array.isArray(arr) && arr.length) {
      const last = arr[arr.length - 1] as Record<string, unknown>;
      const text = String(last.message ?? last.body ?? last.text ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const when = last.date ?? last.creation_date ?? "";
      if (text) return `${when ? `${when}: ` : ""}${text.slice(0, 600)}`;
    }
  }
  return undefined;
}
