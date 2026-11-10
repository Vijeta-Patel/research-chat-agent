import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import type { CheckResult, MemoryRecord, Source, StoredMessage } from "@/lib/types";

// Storage: Node's built-in SQLite (no native build step during `npm install`).
// One file holds the raw log of every conversation plus a full-text index.

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(config.dbPath), { recursive: true });
  db = new DatabaseSync(config.dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sources_json TEXT NOT NULL DEFAULT '[]',
      memory_json TEXT NOT NULL DEFAULT '[]',
      checks_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      message_id UNINDEXED, text, tokenize = 'porter unicode61'
    );
  `);
  return db;
}

// Allows tests/evals to freeze the clock (e.g. AGENT_NOW=2026-11-10T09:00:00Z).
export function now(): Date {
  return process.env.AGENT_NOW ? new Date(process.env.AGENT_NOW) : new Date();
}

type Row = Record<string, unknown>;

function toMessage(r: Row): StoredMessage {
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    role: r.role as "user" | "assistant",
    text: r.text as string,
    createdAt: r.created_at as string,
    sources: JSON.parse((r.sources_json as string) || "[]") as Source[],
    memory: JSON.parse((r.memory_json as string) || "[]") as MemoryRecord[],
    checks: r.checks_json ? (JSON.parse(r.checks_json as string) as CheckResult) : null,
  };
}

export function createConversation(title: string, at = now()): string {
  const id = randomUUID();
  const ts = at.toISOString();
  getDb()
    .prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(id, title.slice(0, 80), ts, ts);
  return id;
}

export function conversationExists(id: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM conversations WHERE id = ?").get(id);
}

export function addMessage(m: {
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  sources?: Source[];
  memory?: MemoryRecord[];
  checks?: CheckResult | null;
  at?: Date;
}): string {
  const id = randomUUID();
  const ts = (m.at ?? now()).toISOString();
  const d = getDb();
  d.prepare(
    `INSERT INTO messages (id, conversation_id, role, text, created_at, sources_json, memory_json, checks_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, m.conversationId, m.role, m.text, ts,
    JSON.stringify(m.sources ?? []), JSON.stringify(m.memory ?? []),
    m.checks ? JSON.stringify(m.checks) : null,
  );
  d.prepare("INSERT INTO messages_fts (message_id, text) VALUES (?, ?)").run(id, m.text);
  d.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(ts, m.conversationId);
  return id;
}

export function listConversations(): { id: string; title: string; createdAt: string; updatedAt: string }[] {
  return getDb()
    .prepare("SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 200")
    .all()
    .map((r) => ({
      id: r.id as string,
      title: r.title as string,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    }));
}

export function getMessages(conversationId: string): StoredMessage[] {
  return getDb()
    .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC")
    .all(conversationId)
    .map(toMessage);
}

export function deleteConversation(id: string): void {
  const d = getDb();
  const ids = d.prepare("SELECT id FROM messages WHERE conversation_id = ?").all(id).map((r) => r.id as string);
  for (const mid of ids) d.prepare("DELETE FROM messages_fts WHERE message_id = ?").run(mid);
  d.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
  d.prepare("DELETE FROM conversations WHERE id = ?").run(id);
}

// ---- Queries used by memory retrieval ----

export interface MessageHit {
  id: string;
  conversationId: string;
  conversationTitle: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

const HIT_SELECT = `SELECT m.id, m.conversation_id, c.title, m.role, m.text, m.created_at
  FROM messages m JOIN conversations c ON c.id = m.conversation_id`;

function toHit(r: Row): MessageHit {
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    conversationTitle: r.title as string,
    role: r.role as "user" | "assistant",
    text: r.text as string,
    createdAt: r.created_at as string,
  };
}

export function messagesBetween(fromIso: string, toIso: string, excludeConversation?: string): MessageHit[] {
  return getDb()
    .prepare(`${HIT_SELECT} WHERE m.created_at >= ? AND m.created_at < ? AND m.conversation_id != ?
              ORDER BY m.created_at ASC LIMIT 60`)
    .all(fromIso, toIso, excludeConversation ?? "")
    .map(toHit);
}

export function searchMessages(ftsQuery: string, excludeConversation?: string, limit = 12): MessageHit[] {
  if (!ftsQuery) return [];
  try {
    return getDb()
      .prepare(`${HIT_SELECT} JOIN messages_fts f ON f.message_id = m.id
                WHERE messages_fts MATCH ? AND m.conversation_id != ?
                ORDER BY bm25(messages_fts) LIMIT ?`)
      .all(ftsQuery, excludeConversation ?? "", limit)
      .map(toHit);
  } catch {
    return []; // malformed FTS query — treat as no match rather than failing the turn
  }
}

export function recentConversationMessages(limitConversations: number, excludeConversation?: string): MessageHit[] {
  const convs = getDb()
    .prepare("SELECT id FROM conversations WHERE id != ? ORDER BY updated_at DESC LIMIT ?")
    .all(excludeConversation ?? "", limitConversations)
    .map((r) => r.id as string);
  if (!convs.length) return [];
  return getDb()
    .prepare(`${HIT_SELECT} WHERE m.conversation_id IN (${convs.map(() => "?").join(",")})
              ORDER BY m.created_at ASC`)
    .all(...convs)
    .map(toHit);
}

export function historyStats(excludeConversation?: string): { count: number; first: string | null; last: string | null } {
  const r = getDb()
    .prepare("SELECT COUNT(*) n, MIN(created_at) a, MAX(updated_at) b FROM conversations WHERE id != ?")
    .get(excludeConversation ?? "") as Row;
  return { count: Number(r.n), first: (r.a as string) ?? null, last: (r.b as string) ?? null };
}
