/**
 * WhatsApp Cloud API (Meta): validação de assinatura, leitura do webhook e envio.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface IncomingMessage {
  /** Número da empresa que recebeu (phone_number_id). */
  phoneNumberId: string;
  /** Telefone do cliente (wa_id), só dígitos. */
  from: string;
  /** Nome do perfil do WhatsApp, quando informado. */
  profileName?: string;
  messageId: string;
  timestamp: number;
  type: string;
  /** Texto (para mensagens de texto, botões e respostas interativas). */
  text?: string;
}

/** Confere o cabeçalho X-Hub-Signature-256 com o App Secret. */
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const received = header.slice("sha256=".length);
  if (received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(expected, "hex"));
}

type Json = Record<string, any>;

/** Extrai as mensagens recebidas de um payload de webhook (ignora status de entrega). */
export function parseWebhook(payload: Json): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== "messages") continue;
      const value = change.value ?? {};
      const phoneNumberId = String(value.metadata?.phone_number_id ?? "");
      const names = new Map<string, string>();
      for (const c of value.contacts ?? []) {
        if (c?.wa_id) names.set(String(c.wa_id), c.profile?.name);
      }
      for (const m of value.messages ?? []) {
        const from = String(m.from ?? "");
        let text: string | undefined;
        if (m.type === "text") text = m.text?.body;
        else if (m.type === "button") text = m.button?.text;
        else if (m.type === "interactive") {
          text = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title;
        } else if (["image", "document", "video"].includes(m.type)) {
          text = m[m.type]?.caption;
        }
        out.push({
          phoneNumberId,
          from,
          profileName: names.get(from),
          messageId: String(m.id),
          timestamp: Number(m.timestamp ?? 0),
          type: String(m.type),
          text,
        });
      }
    }
  }
  return out;
}

export class WhatsAppClient {
  constructor(
    private readonly graphApiVersion: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async post(phoneNumberId: string, accessToken: string, body: Json): Promise<Json> {
    const url = `https://graph.facebook.com/${this.graphApiVersion}/${phoneNumberId}/messages`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) {
      throw new Error(`WhatsApp API ${res.status}: ${json?.error?.message ?? "erro desconhecido"}`);
    }
    return json;
  }

  async sendText(phoneNumberId: string, accessToken: string, to: string, text: string): Promise<void> {
    // Limite da Meta: 4096 caracteres por mensagem de texto.
    for (const chunk of splitMessage(text, 4000)) {
      await this.post(phoneNumberId, accessToken, {
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: false, body: chunk },
      });
    }
  }

  /** Marca como lida e mostra "digitando…" (melhor esforço — falhas são ignoradas). */
  async markReadAndTyping(phoneNumberId: string, accessToken: string, messageId: string): Promise<void> {
    try {
      await this.post(phoneNumberId, accessToken, {
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      });
    } catch {
      /* ignorado */
    }
  }
}

export function splitMessage(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
