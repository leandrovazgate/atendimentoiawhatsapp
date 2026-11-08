/**
 * Servidor HTTP:
 *   GET  /webhook/whatsapp   verificação do webhook pela Meta
 *   POST /webhook/whatsapp   mensagens recebidas (assinatura X-Hub-Signature-256 obrigatória)
 *   GET  /health             verificação de saúde
 *   POST /admin/resume       devolve a conversa ao robô depois de um handoff (Bearer ADMIN_TOKEN)
 */
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { AppConfig } from "./config.js";
import type { Store } from "./store/db.js";
import { parseWebhook, verifySignature } from "./channels/whatsapp.js";
import type { MessageProcessor } from "./conversation/processor.js";

export function buildServer(deps: { config: AppConfig; store: Store; processor: MessageProcessor; logger?: boolean }): FastifyInstance {
  const { config, store, processor } = deps;
  const app = Fastify({ logger: deps.logger ?? true, bodyLimit: 1_000_000 });

  // Mantém o corpo bruto: a assinatura da Meta é calculada sobre os bytes exatos.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.get("/health", async () => ({ ok: true }));

  app.get("/webhook/whatsapp", async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === config.whatsapp.verifyToken) {
      return reply.type("text/plain").send(q["hub.challenge"] ?? "");
    }
    return reply.code(403).send();
  });

  app.post("/webhook/whatsapp", async (req, reply) => {
    const raw = req.body as Buffer;
    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    if (!Buffer.isBuffer(raw) || !verifySignature(raw, signature, config.whatsapp.appSecret)) {
      req.log.warn("assinatura inválida no webhook");
      return reply.code(401).send();
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return reply.code(400).send();
    }
    for (const msg of parseWebhook(payload as Record<string, unknown>)) processor.receive(msg);
    // Responde 200 imediatamente; a Meta reenvia se demorar.
    return reply.code(200).send();
  });

  app.post("/admin/resume", async (req, reply) => {
    const auth = req.headers.authorization ?? "";
    const expected = `Bearer ${config.adminToken ?? ""}`;
    const authorized =
      !!config.adminToken && auth.length === expected.length && timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
    if (!authorized) return reply.code(401).send();
    let body: { channel_id?: string; wa_id?: string } = {};
    try {
      body = JSON.parse((req.body as Buffer).toString("utf8"));
    } catch {
      return reply.code(400).send();
    }
    if (!body.channel_id || !body.wa_id) return reply.code(400).send({ erro: "Informe channel_id e wa_id." });
    return { conversas_reativadas: store.resumeBot(body.channel_id, body.wa_id.replace(/\D/g, "")) };
  });

  return app;
}
