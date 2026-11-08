/**
 * Persistência em SQLite (node:sqlite, nativo do Node 22).
 * Guarda: contatos identificados, sessões de conversa (histórico para o Claude),
 * mensagens já processadas (deduplicação) e auditoria de chamados abertos.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Contact {
  channelId: string;
  waId: string;
  email: string;
  name?: string;
  organization?: string;
  /** Telefone do WhatsApp confere com o cadastro do TomTicket. */
  phoneVerified: boolean;
  updatedAt: number;
}

export interface Session {
  id: number;
  channelId: string;
  waId: string;
  /** Histórico no formato da API (append-only — nunca editar mensagens antigas). */
  messages: unknown[];
  handoffUntil?: number;
  lastActivityAt: number;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS contacts (
        channel_id TEXT NOT NULL,
        wa_id TEXT NOT NULL,
        email TEXT NOT NULL,
        name TEXT,
        organization TEXT,
        phone_verified INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, wa_id)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        wa_id TEXT NOT NULL,
        messages TEXT NOT NULL DEFAULT '[]',
        handoff_until INTEGER,
        last_activity_at INTEGER NOT NULL,
        closed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_open ON sessions (channel_id, wa_id, closed);
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tickets_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        wa_id TEXT NOT NULL,
        email TEXT NOT NULL,
        ticket_id TEXT,
        protocol TEXT,
        subject TEXT,
        priority TEXT,
        created_at INTEGER NOT NULL
      );
    `);
  }

  /** Retorna true na primeira vez que vê o id (a Meta reenvia webhooks). */
  markProcessed(messageId: string): boolean {
    const r = this.db
      .prepare("INSERT OR IGNORE INTO processed_messages (message_id, received_at) VALUES (?, ?)")
      .run(messageId, Date.now());
    return Number(r.changes) > 0;
  }

  getContact(channelId: string, waId: string): Contact | undefined {
    const row = this.db
      .prepare("SELECT * FROM contacts WHERE channel_id = ? AND wa_id = ?")
      .get(channelId, waId) as Record<string, any> | undefined;
    if (!row) return undefined;
    return {
      channelId: row.channel_id,
      waId: row.wa_id,
      email: row.email,
      name: row.name ?? undefined,
      organization: row.organization ?? undefined,
      phoneVerified: row.phone_verified === 1,
      updatedAt: row.updated_at,
    };
  }

  saveContact(c: Omit<Contact, "updatedAt">): void {
    this.db
      .prepare(
        `INSERT INTO contacts (channel_id, wa_id, email, name, organization, phone_verified, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (channel_id, wa_id) DO UPDATE SET
           email = excluded.email, name = excluded.name, organization = excluded.organization,
           phone_verified = excluded.phone_verified, updated_at = excluded.updated_at`,
      )
      .run(c.channelId, c.waId, c.email, c.name ?? null, c.organization ?? null, c.phoneVerified ? 1 : 0, Date.now());
  }

  /** Sessão aberta mais recente; abre uma nova se expirou por inatividade. */
  getOrCreateSession(channelId: string, waId: string, ttlMs: number): Session {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE channel_id = ? AND wa_id = ? AND closed = 0 ORDER BY id DESC LIMIT 1")
      .get(channelId, waId) as Record<string, any> | undefined;
    const now = Date.now();
    if (row && now - row.last_activity_at < ttlMs) return toSession(row);
    if (row) this.db.prepare("UPDATE sessions SET closed = 1 WHERE id = ?").run(row.id);
    const r = this.db
      .prepare("INSERT INTO sessions (channel_id, wa_id, messages, last_activity_at) VALUES (?, ?, '[]', ?)")
      .run(channelId, waId, now);
    return { id: Number(r.lastInsertRowid), channelId, waId, messages: [], lastActivityAt: now };
  }

  saveSession(s: Session): void {
    this.db
      .prepare("UPDATE sessions SET messages = ?, handoff_until = ?, last_activity_at = ? WHERE id = ?")
      .run(JSON.stringify(s.messages), s.handoffUntil ?? null, Date.now(), s.id);
  }

  /** Encerra a pausa de handoff (o robô volta a responder). */
  resumeBot(channelId: string, waId: string): number {
    const r = this.db
      .prepare("UPDATE sessions SET handoff_until = NULL WHERE channel_id = ? AND wa_id = ? AND closed = 0")
      .run(channelId, waId);
    return Number(r.changes);
  }

  auditTicket(a: {
    channelId: string;
    waId: string;
    email: string;
    ticketId?: string;
    protocol?: string;
    subject: string;
    priority: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO tickets_audit (channel_id, wa_id, email, ticket_id, protocol, subject, priority, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.channelId, a.waId, a.email, a.ticketId ?? null, a.protocol ?? null, a.subject, a.priority, Date.now());
  }
}

function toSession(row: Record<string, any>): Session {
  return {
    id: row.id,
    channelId: row.channel_id,
    waId: row.wa_id,
    messages: JSON.parse(row.messages),
    handoffUntil: row.handoff_until ?? undefined,
    lastActivityAt: row.last_activity_at,
  };
}
