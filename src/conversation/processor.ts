/**
 * Orquestra cada mensagem recebida:
 * deduplicação → junta mensagens enviadas em sequência (debounce) → fila por conversa
 * → agente → resposta no WhatsApp.
 */
import type { AppConfig } from "../config.js";
import type { ChannelRegistry } from "../channels/registry.js";
import type { IncomingMessage, WhatsAppClient } from "../channels/whatsapp.js";
import type { Store } from "../store/db.js";
import type { TomTicketClient } from "../integrations/tomticket.js";
import { FALLBACK_REPLY, type SupportAgent } from "../agent/agent.js";
import { notifyTeam } from "../handoff/notify.js";

type Log = (msg: string, data?: unknown) => void;

interface Pending {
  texts: string[];
  last: IncomingMessage;
  timer: NodeJS.Timeout;
}

const UNSUPPORTED_MEDIA =
  "Por enquanto consigo ler apenas mensagens de texto 🙂. Pode me descrever por escrito o que está acontecendo?";

export class MessageProcessor {
  private readonly pending = new Map<string, Pending>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: {
      config: AppConfig;
      channels: ChannelRegistry;
      whatsapp: WhatsAppClient;
      store: Store;
      tomticket: TomTicketClient;
      agent: SupportAgent;
      log: Log;
      fetchImpl?: typeof fetch;
    },
  ) {}

  /** Chamado pelo webhook para cada mensagem. Retorna rápido; o trabalho é assíncrono. */
  receive(msg: IncomingMessage): void {
    const { channels, store, log, whatsapp, config } = this.deps;
    const channel = channels.get(msg.phoneNumberId);
    if (!channel) {
      log("mensagem para número não cadastrado — ignorada", { phoneNumberId: msg.phoneNumberId });
      return;
    }
    if (!store.markProcessed(msg.messageId)) return; // reenvio da Meta

    void whatsapp.markReadAndTyping(channel.phoneNumberId, channel.accessToken, msg.messageId);

    const text = msg.text?.trim();
    if (!text) {
      if (msg.type === "reaction" || msg.type === "unsupported") return;
      this.enqueue(`${channel.phoneNumberId}:${msg.from}`, async () => {
        const session = store.getOrCreateSession(channel.phoneNumberId, msg.from, config.agent.sessionTtlHours * 3600_000);
        if (session.handoffUntil && session.handoffUntil > Date.now()) return;
        await whatsapp.sendText(channel.phoneNumberId, channel.accessToken, msg.from, UNSUPPORTED_MEDIA);
      });
      return;
    }

    const key = `${channel.phoneNumberId}:${msg.from}`;
    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.texts.push(text);
      existing.last = msg;
    }
    const entry: Pending = existing ?? { texts: [text], last: msg, timer: undefined as unknown as NodeJS.Timeout };
    entry.timer = setTimeout(() => {
      this.pending.delete(key);
      this.enqueue(key, () => this.process(entry.last, entry.texts.join("\n")));
    }, config.agent.debounceMs);
    this.pending.set(key, entry);
  }

  /** Garante que mensagens da mesma conversa sejam processadas uma de cada vez. */
  private enqueue(key: string, job: () => Promise<void>): void {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev
      .then(job)
      .catch((err) => this.deps.log("erro no processamento", { key, error: String(err) }))
      .finally(() => {
        if (this.queues.get(key) === next) this.queues.delete(key);
      });
    this.queues.set(key, next);
  }

  /** Aguarda todas as filas (usado nos testes e no desligamento). */
  async drain(): Promise<void> {
    while (this.pending.size || this.queues.size) {
      for (const [key, p] of this.pending) {
        clearTimeout(p.timer);
        this.pending.delete(key);
        this.enqueue(key, () => this.process(p.last, p.texts.join("\n")));
      }
      await Promise.all([...this.queues.values()]);
    }
  }

  private async process(msg: IncomingMessage, text: string): Promise<void> {
    const { config, channels, whatsapp, store, tomticket, agent, log } = this.deps;
    const channel = channels.get(msg.phoneNumberId)!;
    const session = store.getOrCreateSession(channel.phoneNumberId, msg.from, config.agent.sessionTtlHours * 3600_000);

    if (session.handoffUntil && session.handoffUntil > Date.now()) {
      log("conversa com técnico — robô em silêncio", { waId: msg.from });
      return;
    }
    session.handoffUntil = undefined;

    const ctx = {
      config,
      channel,
      waId: msg.from,
      profileName: msg.profileName,
      store,
      tomticket,
      session,
      log,
      fetchImpl: this.deps.fetchImpl,
    };

    let replies: string[];
    try {
      replies = (await agent.handle(text, ctx)).replies;
    } catch (err) {
      log("falha no agente", { error: String(err) });
      replies = [FALLBACK_REPLY];
      session.handoffUntil = Date.now() + config.agent.handoffPauseHours * 3600_000;
      await notifyTeam(
        config.handoff.webhookUrl,
        {
          channelLabel: channel.label,
          customerPhone: msg.from,
          customerName: msg.profileName,
          reason: "Falha técnica no assistente virtual",
          summary: text.slice(0, 500),
          urgent: false,
        },
        log,
        this.deps.fetchImpl,
      );
    } finally {
      store.saveSession(session);
    }

    for (const reply of replies) {
      await whatsapp.sendText(channel.phoneNumberId, channel.accessToken, msg.from, reply);
    }
  }
}
