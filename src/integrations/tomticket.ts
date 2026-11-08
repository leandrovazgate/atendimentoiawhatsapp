/**
 * Cliente da API TomTicket v2.0.
 * Autenticação: Authorization: Bearer <token> (Administração → Configurações da Conta → API).
 * As requisições POST usam multipart/form-data, como a API exige.
 */

export class TomTicketError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "TomTicketError";
  }
}

export const PRIORITY = { baixa: 1, normal: 2, alta: 3, urgente: 4 } as const;
export type PriorityName = keyof typeof PRIORITY;

/** Situações consideradas "em aberto" (exclui 4 cancelada e 5 finalizada). */
export const OPEN_SITUATIONS = "0,1,2,3,6,7,8,9,10,11";

export const SITUATION_LABELS: Record<string, string> = {
  "0": "Aguardando atendente",
  "1": "Não iniciado",
  "2": "Aguardando resposta do cliente",
  "3": "Respondido pelo cliente",
  "4": "Cancelado",
  "5": "Finalizado",
  "6": "Atendente modificado",
  "7": "Em apoio",
  "8": "Aguardando aprovação",
  "9": "Aguardando aprovação",
  "10": "Aprovação",
  "11": "Aprovação",
};

type Params = Record<string, string | number | undefined>;
type Json = Record<string, unknown>;

export interface TomTicketCustomer {
  id?: string;
  name?: string;
  email: string;
  phones: string[];
  organization?: string;
  raw: Json;
}

export interface TomTicketSummary {
  id?: string;
  protocol?: string;
  subject?: string;
  situation?: string;
  priority?: string;
  createdAt?: string;
  updatedAt?: string;
  operator?: string;
}

export interface CreatedTicket {
  id?: string;
  protocol?: string;
  raw: unknown;
}

const MIN_INTERVAL_MS = 350;

function asRecord(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function str(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object") {
    const rec = asRecord(value);
    return str(rec.name ?? rec.description ?? rec.label ?? rec.id);
  }
  return String(value);
}

function pick(obj: Json, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = str(obj[key]);
    if (v) return v;
  }
  return undefined;
}

export class TomTicketClient {
  private lastRequestAt = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  async request(method: "GET" | "POST", path: string, params: Params = {}): Promise<Json> {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\//, "")}`);
    let body: FormData | undefined;
    const clean = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
    if (method === "GET") {
      for (const [k, v] of clean) url.searchParams.set(k, String(v));
    } else {
      body = new FormData();
      for (const [k, v] of clean) body.append(k, String(v));
    }

    await this.throttle();
    const response = await this.fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
      body,
      signal: AbortSignal.timeout(30_000),
    });

    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    const rec = asRecord(parsed);
    if (!response.ok || rec.error === true) {
      throw new TomTicketError(
        str(rec.message) ?? `HTTP ${response.status} na API TomTicket`,
        response.status,
        parsed,
      );
    }
    return rec;
  }

  /** Busca cliente pelo e-mail. Retorna null se não existir. */
  async findCustomerByEmail(email: string): Promise<TomTicketCustomer | null> {
    let res: Json;
    try {
      res = await this.request("GET", "customer/details", {
        customer_id: email,
        customer_type_id: "E",
      });
    } catch (err) {
      // A API responde "não encontrado" com 404/400 ou com HTTP 200 + error:true.
      if (err instanceof TomTicketError && [200, 400, 404].includes(err.status ?? 0)) {
        return null;
      }
      throw err;
    }
    const data = asRecord(res.data ?? res);
    if (Object.keys(data).length === 0) return null;

    const phones: string[] = [];
    for (const key of ["phone", "phones", "cellphone", "mobile", "telephone", "whatsapp"]) {
      const v = data[key];
      if (Array.isArray(v)) v.forEach((p) => str(p) && phones.push(str(p)!));
      else if (str(v)) phones.push(str(v)!);
    }
    const org = asRecord(data.organization);
    return {
      id: pick(data, "id", "customer_id"),
      name: pick(data, "name"),
      email: pick(data, "email") ?? email,
      phones,
      organization: str(org.name) ?? pick(data, "organization_name", "organization"),
      raw: data,
    };
  }

  async createTicket(input: {
    customerEmail: string;
    departmentId: string;
    categoryId?: string;
    subject: string;
    message: string;
    priority: PriorityName;
  }): Promise<CreatedTicket> {
    const res = await this.request("POST", "ticket/new", {
      customer_id: input.customerEmail,
      customer_id_type: "E",
      department_id: input.departmentId,
      category_id: input.categoryId,
      subject: input.subject.slice(0, 250),
      message: input.message,
      priority: PRIORITY[input.priority],
    });
    const data = asRecord(res.data);
    return {
      id: pick(data, "id", "ticket_id") ?? pick(res, "ticket_id", "id"),
      protocol: pick(data, "protocol") ?? pick(res, "protocol"),
      raw: res,
    };
  }

  async listCustomerTickets(
    customerEmail: string,
    opts: { onlyOpen?: boolean; protocol?: number } = {},
  ): Promise<TomTicketSummary[]> {
    const res = await this.request("GET", "ticket/list", {
      customer_id: customerEmail,
      customer_type_id: "E",
      situation: opts.onlyOpen ? OPEN_SITUATIONS : undefined,
      min_protocol: opts.protocol,
      max_protocol: opts.protocol,
      order: "DESC",
      page: 1,
    });
    const items = Array.isArray(res.data) ? res.data : [];
    return items.map((item) => summarizeTicket(asRecord(item)));
  }

  async getTicketDetail(ticketId: string): Promise<Json> {
    const res = await this.request("GET", "ticket/detail", { ticket_id: ticketId });
    return asRecord(res.data ?? res);
  }

  /** Resposta no chamado em nome do cliente (complemento enviado pelo WhatsApp). */
  async replyAsCustomer(ticketId: string, message: string): Promise<void> {
    await this.request("POST", "ticket/reply/customer", { ticket_id: ticketId, message });
  }

  /** Comentário interno (não visível ao cliente). */
  async commentTicket(ticketId: string, comment: string): Promise<void> {
    await this.request("POST", "ticket/comment", { ticket_id: ticketId, comment });
  }
}

export function situationLabel(value: unknown): string | undefined {
  const rec = asRecord(value);
  const raw = str(rec.id ?? rec.value ?? value);
  const named = str(rec.description ?? rec.name);
  if (named && Object.keys(rec).length) return named;
  return raw ? (SITUATION_LABELS[raw] ?? raw) : undefined;
}

export function summarizeTicket(t: Json): TomTicketSummary {
  const operator = asRecord(t.operator);
  return {
    id: pick(t, "id", "ticket_id"),
    protocol: pick(t, "protocol"),
    subject: pick(t, "subject"),
    situation: situationLabel(t.situation),
    priority: pick(t, "priority"),
    createdAt: pick(t, "creation_date", "created_at"),
    updatedAt: pick(t, "last_update", "last_situation_date", "updated_at"),
    operator: str(operator.name) ?? pick(t, "operator_name"),
  };
}
