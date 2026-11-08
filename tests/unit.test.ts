import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWebhook, splitMessage, verifySignature } from "../src/channels/whatsapp.js";
import { ChannelRegistry } from "../src/channels/registry.js";
import { isBusinessHours, phoneKey, samePhone } from "../src/util.js";
import { sign, webhookPayload } from "./helpers.js";

test("assinatura do webhook: aceita a correta e rejeita a errada", () => {
  const body = JSON.stringify({ a: 1 });
  assert.equal(verifySignature(Buffer.from(body), sign(body), "app-secret"), true);
  assert.equal(verifySignature(Buffer.from(body), sign(body, "outro"), "app-secret"), false);
  assert.equal(verifySignature(Buffer.from(body), undefined, "app-secret"), false);
  assert.equal(verifySignature(Buffer.from(body), "sha256=abc", "app-secret"), false);
});

test("parseWebhook extrai número, remetente, nome e texto", () => {
  const [m] = parseWebhook(webhookPayload("Oi, minha impressora parou"));
  assert.equal(m.phoneNumberId, "PNID-1");
  assert.equal(m.from, "551188887777");
  assert.equal(m.profileName, "Maria");
  assert.equal(m.text, "Oi, minha impressora parou");
});

test("parseWebhook ignora atualizações de status de entrega", () => {
  const payload = {
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "X" }, statuses: [{ id: "s" }] } }] }],
  };
  assert.deepEqual(parseWebhook(payload), []);
});

test("telefone: compara com e sem o nono dígito e com/sem +55", () => {
  assert.equal(phoneKey("+55 (11) 98888-7777"), "1188887777");
  assert.equal(samePhone("5511988887777", "551188887777"), true);
  assert.equal(samePhone("(11) 98888-7777", "5511988887777"), true);
  assert.equal(samePhone("(21) 98888-7777", "5511988887777"), false);
  assert.equal(samePhone("", "5511988887777"), false);
});

test("horário comercial", () => {
  // 2026-11-09 é segunda-feira. 13:00 UTC = 10:00 em São Paulo.
  assert.equal(isBusinessHours("seg-sex 08:00-18:00", "America/Sao_Paulo", new Date("2026-11-09T13:00:00Z")), true);
  // 22:00 UTC = 19:00 em São Paulo.
  assert.equal(isBusinessHours("seg-sex 08:00-18:00", "America/Sao_Paulo", new Date("2026-11-09T22:00:00Z")), false);
  // domingo
  assert.equal(isBusinessHours("seg-sex 08:00-18:00", "America/Sao_Paulo", new Date("2026-11-08T13:00:00Z")), false);
  assert.equal(
    isBusinessHours("seg-sex 08:00-18:00; sab 08:00-12:00", "America/Sao_Paulo", new Date("2026-11-07T13:00:00Z")),
    true,
  );
});

test("divide mensagens longas", () => {
  const parts = splitMessage("palavra ".repeat(1000), 4000);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.length <= 4000));
});

test("registro de canais: um número ou vários", () => {
  const single = ChannelRegistry.fromEnv({ WHATSAPP_PHONE_NUMBER_ID: "111", WHATSAPP_ACCESS_TOKEN: "t" });
  assert.equal(single.get("111")?.accessToken, "t");

  const multi = ChannelRegistry.fromEnv({
    WHATSAPP_CHANNELS: JSON.stringify([
      { phone_number_id: "111", label: "Suporte" },
      { phone_number_id: "222", label: "Cliente X", access_token_env: "TOKEN_X", tomticket_department_id: "dep-9" },
    ]),
    WHATSAPP_ACCESS_TOKEN: "t1",
    TOKEN_X: "t2",
  });
  assert.equal(multi.list().length, 2);
  assert.equal(multi.get("222")?.accessToken, "t2");
  assert.equal(multi.get("222")?.tomticketDepartmentId, "dep-9");
});
