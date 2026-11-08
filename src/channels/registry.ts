/**
 * Cadastro de números (canais) de WhatsApp.
 *
 * A v1 usa um único número de suporte, mas cada mensagem é roteada pelo
 * `phone_number_id` que a Meta informa no webhook — adicionar outro número
 * é só incluir mais um item em WHATSAPP_CHANNELS.
 */

export interface Channel {
  /** phone_number_id da Meta (identifica o número que recebeu a mensagem). */
  phoneNumberId: string;
  /** Rótulo para logs e painel, ex.: "Suporte GateIT". */
  label: string;
  /** Token de acesso (System User) da conta WhatsApp Business. */
  accessToken: string;
  /** Sobrescritas opcionais por número. */
  agentName?: string;
  tomticketDepartmentId?: string;
  tomticketCategoryId?: string;
}

interface RawChannel {
  phone_number_id: string;
  label?: string;
  /** Nome da variável de ambiente que guarda o token (não o token em si). */
  access_token_env?: string;
  agent_name?: string;
  tomticket_department_id?: string;
  tomticket_category_id?: string;
}

export class ChannelRegistry {
  private readonly byId = new Map<string, Channel>();

  constructor(channels: Channel[]) {
    for (const ch of channels) this.byId.set(ch.phoneNumberId, ch);
  }

  get(phoneNumberId: string): Channel | undefined {
    return this.byId.get(phoneNumberId);
  }

  list(): Channel[] {
    return [...this.byId.values()];
  }

  /**
   * Lê os canais do ambiente:
   * - WHATSAPP_CHANNELS: JSON com vários números (multi-número), ou
   * - WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_ACCESS_TOKEN: um único número.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): ChannelRegistry {
    const channels: Channel[] = [];
    const json = env.WHATSAPP_CHANNELS?.trim();
    if (json) {
      const raw = JSON.parse(json) as RawChannel[];
      for (const r of raw) {
        const tokenEnv = r.access_token_env ?? "WHATSAPP_ACCESS_TOKEN";
        const token = env[tokenEnv]?.trim();
        if (!token) throw new Error(`Token do canal ${r.phone_number_id} ausente em ${tokenEnv}`);
        channels.push({
          phoneNumberId: String(r.phone_number_id),
          label: r.label ?? String(r.phone_number_id),
          accessToken: token,
          agentName: r.agent_name,
          tomticketDepartmentId: r.tomticket_department_id,
          tomticketCategoryId: r.tomticket_category_id,
        });
      }
    } else {
      const id = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
      const token = env.WHATSAPP_ACCESS_TOKEN?.trim();
      if (!id || !token) {
        throw new Error("Configure WHATSAPP_PHONE_NUMBER_ID e WHATSAPP_ACCESS_TOKEN (ou WHATSAPP_CHANNELS).");
      }
      channels.push({ phoneNumberId: id, label: env.WHATSAPP_CHANNEL_LABEL ?? "Suporte", accessToken: token });
    }
    return new ChannelRegistry(channels);
  }
}
