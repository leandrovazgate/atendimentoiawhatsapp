import { createHmac } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { AppConfig } from "../src/config.js";

export function testConfig(overrides: Partial<AppConfig["tomticket"]> = {}): AppConfig {
  return {
    port: 0,
    databasePath: ":memory:",
    adminToken: "admin-secret",
    timezone: "America/Sao_Paulo",
    businessHours: "seg-sex 08:00-18:00",
    anthropic: { model: "claude-opus-5-5", effort: "low" },
    whatsapp: { appSecret: "app-secret", verifyToken: "verify-me", graphApiVersion: "v23.0" },
    tomticket: {
      baseUrl: "https://api.tomticket.test/v2.0",
      token: "tt-token",
      departmentId: "dep-1",
      categoryId: undefined,
      requirePhoneMatchForLookup: true,
      ...overrides,
    },
    agent: {
      name: "Gate",
      companyName: "GateIT",
      sessionTtlHours: 12,
      handoffPauseHours: 4,
      debounceMs: 10,
      slaText: "Alta: 4h",
    },
    handoff: { webhookUrl: "https://hooks.test/equipe" },
  };
}

export interface FetchCall {
  url: string;
  method: string;
  form?: Record<string, string>;
  json?: any;
}

/** fetch falso que registra as chamadas e responde por rota. */
export function fakeFetch(routes: Record<string, (call: FetchCall) => unknown>) {
  const calls: FetchCall[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: FetchCall = { url: url.toString(), method: init?.method ?? "GET" };
    if (init?.body instanceof FormData) {
      call.form = Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, String(v)]));
    } else if (typeof init?.body === "string") {
      call.json = JSON.parse(init.body);
    }
    calls.push(call);
    const key = Object.keys(routes).find((r) => url.toString().includes(r));
    const body = key ? routes[key](call) : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

type Block = Record<string, unknown>;

/** Cliente Anthropic falso com respostas roteirizadas. */
export function fakeAnthropic(script: Array<{ content: Block[]; stop_reason: string } | Error>) {
  const requests: any[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: unknown) => {
          requests.push(structuredClone(params));
          const next = script.shift();
          if (!next) throw new Error("roteiro do teste acabou");
          if (next instanceof Error) throw next;
          return { id: "msg", model: "claude-opus-5-5", ...next };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

export function sign(body: string, secret = "app-secret"): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

export function webhookPayload(text: string, opts: { from?: string; id?: string; phoneNumberId?: string } = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "5511999990000", phone_number_id: opts.phoneNumberId ?? "PNID-1" },
              contacts: [{ profile: { name: "Maria" }, wa_id: opts.from ?? "551188887777" }],
              messages: [
                {
                  from: opts.from ?? "551188887777",
                  id: opts.id ?? "wamid.1",
                  timestamp: "1762650000",
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}
