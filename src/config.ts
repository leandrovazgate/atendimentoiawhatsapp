/**
 * Configuração lida das variáveis de ambiente.
 * Segredos (tokens) nunca ficam no código nem no git — veja .env.example.
 */

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "sim", "yes"].includes(value);
}

function int(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

function effort(value: string): (typeof EFFORTS)[number] {
  if (!(EFFORTS as readonly string[]).includes(value)) {
    throw new Error(`LLM_EFFORT inválido: ${value} (use ${EFFORTS.join(", ")})`);
  }
  return value as (typeof EFFORTS)[number];
}

export interface AppConfig {
  port: number;
  databasePath: string;
  adminToken?: string;
  timezone: string;
  /** Ex.: "seg-sex 08:00-18:00" */
  businessHours: string;

  anthropic: {
    model: string;
    effort: "low" | "medium" | "high" | "xhigh" | "max";
  };

  whatsapp: {
    appSecret: string;
    verifyToken: string;
    graphApiVersion: string;
  };

  tomticket: {
    baseUrl: string;
    token: string;
    departmentId: string;
    categoryId?: string;
    /** Exige que o WhatsApp bata com o telefone do cadastro para consultar chamados. */
    requirePhoneMatchForLookup: boolean;
  };

  agent: {
    name: string;
    companyName: string;
    /** Horas sem mensagem até iniciar uma nova sessão de conversa. */
    sessionTtlHours: number;
    /** Horas que o robô fica em silêncio depois de transferir para humano. */
    handoffPauseHours: number;
    /** Espera (ms) para juntar mensagens enviadas em sequência. */
    debounceMs: number;
    slaText: string;
  };

  handoff: {
    webhookUrl?: string;
  };
}

export function loadConfig(): AppConfig {
  return {
    port: int("PORT", 3000),
    databasePath: optional("DATABASE_PATH", "./data/atendimento.db"),
    adminToken: process.env.ADMIN_TOKEN?.trim() || undefined,
    timezone: optional("TIMEZONE", "America/Sao_Paulo"),
    businessHours: optional("BUSINESS_HOURS", "seg-sex 08:00-18:00"),

    anthropic: {
      model: optional("LLM_MODEL", "claude-opus-5-5"),
      effort: effort(optional("LLM_EFFORT", "low")),
    },

    whatsapp: {
      appSecret: required("WHATSAPP_APP_SECRET"),
      verifyToken: required("WHATSAPP_VERIFY_TOKEN"),
      graphApiVersion: optional("WHATSAPP_GRAPH_VERSION", "v23.0"),
    },

    tomticket: {
      baseUrl: optional("TOMTICKET_BASE_URL", "https://api.tomticket.com/v2.0").replace(/\/$/, ""),
      token: required("TOMTICKET_TOKEN"),
      departmentId: required("TOMTICKET_DEPARTMENT_ID"),
      categoryId: process.env.TOMTICKET_CATEGORY_ID?.trim() || undefined,
      requirePhoneMatchForLookup: bool("REQUIRE_PHONE_MATCH_FOR_LOOKUP", true),
    },

    agent: {
      name: optional("AGENT_NAME", "Gate"),
      companyName: optional("COMPANY_NAME", "GateIT"),
      sessionTtlHours: int("SESSION_TTL_HOURS", 12),
      handoffPauseHours: int("HANDOFF_PAUSE_HOURS", 4),
      debounceMs: int("DEBOUNCE_MS", 4000),
      slaText: optional(
        "SLA_TEXT",
        "Urgente: retorno em até 1h útil; Alta: até 4h úteis; Normal: até 1 dia útil; Baixa: até 3 dias úteis.",
      ),
    },

    handoff: {
      webhookUrl: process.env.HANDOFF_WEBHOOK_URL?.trim() || undefined,
    },
  };
}
