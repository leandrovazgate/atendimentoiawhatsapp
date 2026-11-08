/**
 * Loop do agente: envia o histórico ao Claude, executa as ferramentas pedidas
 * e devolve os textos a serem enviados ao cliente no WhatsApp.
 *
 * O histórico é append-only (nunca se edita uma mensagem antiga): isso mantém
 * o cache de prompt válido e preserva os blocos de raciocínio do modelo.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { AppConfig } from "../config.js";
import { buildSystemPrompt } from "./prompt.js";
import { TOOLS, runTool, type ToolContext } from "./tools.js";
import { formatNow, isBusinessHours } from "../util.js";

type Msg = Anthropic.Beta.BetaMessageParam;

const MAX_STEPS = 8;

/** Modelos que aceitam o fallback automático do servidor (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"]);

export const FALLBACK_REPLY =
  "Desculpe, tive um problema técnico agora. Já avisei a nossa equipe e um técnico vai continuar o seu atendimento por aqui.";

export interface AgentTurn {
  replies: string[];
  handoff: boolean;
}

export class SupportAgent {
  /** Prompt de sistema por nome de agente (cada número pode ter a sua persona). */
  private readonly systems = new Map<string, Anthropic.Beta.BetaTextBlockParam[]>();

  constructor(
    private readonly client: Anthropic,
    private readonly config: AppConfig,
  ) {}

  private systemFor(agentName: string): Anthropic.Beta.BetaTextBlockParam[] {
    let system = this.systems.get(agentName);
    if (!system) {
      const text = buildSystemPrompt({ ...this.config.agent, agentName });
      system = [{ type: "text", text, cache_control: { type: "ephemeral" } }];
      this.systems.set(agentName, system);
    }
    return system;
  }

  /** Contexto do turno (muda a cada mensagem) — vai como mensagem de sistema, depois do cache. */
  private turnContext(ctx: ToolContext): string {
    const contact = ctx.store.getContact(ctx.channel.phoneNumberId, ctx.waId);
    const open = isBusinessHours(this.config.businessHours, this.config.timezone);
    const lines = [
      `Agora: ${formatNow(this.config.timezone)} (${open ? "dentro" : "FORA"} do horário de atendimento: ${this.config.businessHours}).`,
      `WhatsApp do cliente: +${ctx.waId}${ctx.profileName ? ` (nome no perfil: ${ctx.profileName})` : ""}.`,
    ];
    if (contact) {
      lines.push(
        `Cliente já identificado: ${contact.name ?? "-"} <${contact.email}>, empresa: ${contact.organization ?? "não informada"}. ` +
          `WhatsApp ${contact.phoneVerified ? "confere" : "NÃO confere"} com o cadastro.`,
      );
    } else {
      lines.push("Cliente ainda não identificado.");
    }
    return lines.join("\n");
  }

  async handle(userText: string, ctx: ToolContext): Promise<AgentTurn> {
    const history = ctx.session.messages as Msg[];
    const startLength = history.length;
    try {
      return await this.runTurn(userText, ctx, history);
    } catch (err) {
      // Descarta o turno incompleto (só o final do histórico, nunca mensagens já respondidas),
      // para a próxima mensagem não herdar uma sequência inválida.
      history.length = startLength;
      throw err;
    }
  }

  private async runTurn(userText: string, ctx: ToolContext, history: Msg[]): Promise<AgentTurn> {
    history.push({ role: "user", content: userText });
    history.push({ role: "system", content: this.turnContext(ctx) });

    const replies: string[] = [];
    const model = this.config.anthropic.model;
    const useFallbacks = FALLBACK_MODELS.has(model);

    for (let step = 0; step < MAX_STEPS; step++) {
      const response = await this.client.beta.messages.create({
        model,
        max_tokens: 4096,
        system: this.systemFor(ctx.channel.agentName ?? this.config.agent.name),
        tools: TOOLS,
        messages: history,
        cache_control: { type: "ephemeral" },
        output_config: { effort: this.config.anthropic.effort },
        ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });

      if (response.stop_reason === "refusal") {
        ctx.log("recusa do modelo", { stop_details: response.stop_details });
        await runTool(
          "transferir_para_humano",
          { motivo: "O assistente não conseguiu responder", resumo: userText.slice(0, 500), urgente: false, protocolo: null },
          ctx,
        );
        return { replies: [FALLBACK_REPLY], handoff: true };
      }

      history.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });

      for (const block of response.content) {
        if (block.type === "text" && block.text.trim()) replies.push(block.text.trim());
      }

      if (response.stop_reason === "pause_turn") continue;
      if (response.stop_reason !== "tool_use") break;

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        let result: unknown;
        let isError = false;
        try {
          result = await runTool(block.name, block.input as Record<string, any>, ctx);
        } catch (err) {
          ctx.log("erro na ferramenta", { tool: block.name, error: String(err) });
          result = { ok: false, erro: "Falha ao acessar o sistema de chamados. Tente de novo ou ofereça acionar um técnico." };
          isError = true;
        }
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
          ...(isError ? { is_error: true } : {}),
        });
      }
      history.push({ role: "user", content: results });
    }

    if (replies.length === 0) replies.push(FALLBACK_REPLY);
    return { replies, handoff: ctx.session.handoffUntil !== undefined && ctx.session.handoffUntil > Date.now() };
  }
}
