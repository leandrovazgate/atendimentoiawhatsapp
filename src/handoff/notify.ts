/**
 * Aviso à equipe quando o agente transfere o atendimento para um humano.
 * HANDOFF_WEBHOOK_URL recebe um POST JSON — funciona com fluxos do Teams/Power Automate,
 * Slack, n8n, Make etc. Sem URL configurada, o aviso só vai para o log.
 */

export interface HandoffNotice {
  channelLabel: string;
  customerPhone: string;
  customerName?: string;
  customerEmail?: string;
  organization?: string;
  reason: string;
  summary: string;
  urgent: boolean;
  ticketProtocol?: string;
}

export async function notifyTeam(
  webhookUrl: string | undefined,
  notice: HandoffNotice,
  log: (msg: string, data?: unknown) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const text =
    `${notice.urgent ? "🚨 URGENTE — " : ""}Atendimento WhatsApp precisa de um técnico\n` +
    `Canal: ${notice.channelLabel}\n` +
    `Cliente: ${notice.customerName ?? "?"} (${notice.customerEmail ?? "e-mail não identificado"})` +
    `${notice.organization ? ` — ${notice.organization}` : ""}\n` +
    `WhatsApp: +${notice.customerPhone}\n` +
    `${notice.ticketProtocol ? `Chamado: #${notice.ticketProtocol}\n` : ""}` +
    `Motivo: ${notice.reason}\n` +
    `Resumo: ${notice.summary}`;

  log("handoff", { ...notice });
  if (!webhookUrl) return false;
  try {
    const res = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, ...notice }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch (err) {
    log("falha ao notificar equipe", { error: String(err) });
    return false;
  }
}
