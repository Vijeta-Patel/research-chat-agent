import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import type { CheckResult, MemoryRecord, Source, StoredMessage, TraceStep } from "@/lib/types";

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

    -- Turn ledger: how each answer was produced (session metadata + trace).
    CREATE TABLE IF NOT EXISTS turns (
      message_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      time_zone TEXT,
      total_ms INTEGER,
      first_token_ms INTEGER,
      searches INTEGER,
      revised INTEGER NOT NULL DEFAULT 0,
      notices_json TEXT NOT NULL DEFAULT '[]',
      trace_json TEXT NOT NULL DEFAULT '[]'
    );

    -- Semantic memory per conversation: rolling summary + topics + entities.
    CREATE TABLE IF NOT EXISTS conversation_memory (
      conversation_id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      topics_json TEXT NOT NULL DEFAULT '[]',
      entities_json TEXT NOT NULL DEFAULT '[]',
      message_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      aliases_json TEXT NOT NULL DEFAULT '[]',   -- other words the user might use for this chat later
      decisions_json TEXT NOT NULL DEFAULT '[]', -- what the user decided
      open_json TEXT NOT NULL DEFAULT '[]'       -- what was left unresolved
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS conversation_memory_fts USING fts5(
      conversation_id UNINDEXED, text, tokenize = 'porter unicode61'
    );

    -- Claims ledger: versioned facts. Never updated in place: a new observation
    -- is a new row, so "what changed since X?" is a diff over observed_at.
    CREATE TABLE IF NOT EXISTS claims (
      id TEXT PRIMARY KEY,
      entity TEXT NOT NULL,
      attribute TEXT NOT NULL,
      value TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      attribute_key TEXT NOT NULL,
      source_url TEXT,
      source_title TEXT,
      observed_at TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_claims_key ON claims(entity_key, attribute_key, observed_at);
    CREATE VIRTUAL TABLE IF NOT EXISTS claims_fts USING fts5(
      claim_id UNINDEXED, text, tokenize = 'porter unicode61'
    );

    -- User profile: stable facts the user stated about themselves (latest wins).
    CREATE TABLE IF NOT EXISTS profile (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      conversation_id TEXT NOT NULL
    );
  `);
  // Databases created before a column existed get it added (additive only).
  const columns = new Set(db.prepare("PRAGMA table_info(conversation_memory)").all().map((r) => r.name as string));
  for (const c of ["aliases_json", "decisions_json", "open_json"]) {
    if (!columns.has(c)) db.exec(`ALTER TABLE conversation_memory ADD COLUMN ${c} TEXT NOT NULL DEFAULT '[]'`);
  }
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
    memory: (JSON.parse((r.memory_json as string) || "[]") as MemoryRecord[]).map((m) => ({ ...m, kind: m.kind ?? "message" })),
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

export function getMessages(conversationId: string, withTurns = false): StoredMessage[] {
  const msgs = getDb()
    .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC")
    .all(conversationId)
    .map(toMessage);
  if (!withTurns) return msgs;
  const turns = turnsForConversation(conversationId);
  return msgs.map((m) => {
    const t = turns.get(m.id);
    return t ? { ...m, turn: { provider: t.provider, model: t.model, totalMs: t.totalMs, firstTokenMs: t.firstTokenMs,
      searches: t.searches, revised: t.revised, notices: t.notices, trace: t.trace } } : m;
  });
}

// "Forget this conversation" removes everything derived from it too:
// transcript, index, summary, claims, profile facts it contributed, turn ledger.
export function deleteConversation(id: string): void {
  const d = getDb();
  const ids = d.prepare("SELECT id FROM messages WHERE conversation_id = ?").all(id).map((r) => r.id as string);
  for (const mid of ids) d.prepare("DELETE FROM messages_fts WHERE message_id = ?").run(mid);
  const claimIds = d.prepare("SELECT id FROM claims WHERE conversation_id = ?").all(id).map((r) => r.id as string);
  for (const cid of claimIds) d.prepare("DELETE FROM claims_fts WHERE claim_id = ?").run(cid);
  d.prepare("DELETE FROM claims WHERE conversation_id = ?").run(id);
  d.prepare("DELETE FROM conversation_memory_fts WHERE conversation_id = ?").run(id);
  d.prepare("DELETE FROM conversation_memory WHERE conversation_id = ?").run(id);
  d.prepare("DELETE FROM profile WHERE conversation_id = ?").run(id);
  d.prepare("DELETE FROM turns WHERE conversation_id = ?").run(id);
  d.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
  d.prepare("DELETE FROM conversations WHERE id = ?").run(id);
}

// ---- Turn ledger ----

export interface TurnRecord {
  messageId: string;
  conversationId: string;
  provider: string;
  model: string;
  timeZone: string;
  totalMs: number;
  firstTokenMs: number | null;
  searches: number;
  revised: boolean;
  notices: string[];
  trace: TraceStep[];
}

export function saveTurn(t: TurnRecord): void {
  getDb()
    .prepare(`INSERT OR REPLACE INTO turns (message_id, conversation_id, created_at, provider, model, time_zone, total_ms,
              first_token_ms, searches, revised, notices_json, trace_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(t.messageId, t.conversationId, now().toISOString(), t.provider, t.model, t.timeZone, t.totalMs,
      t.firstTokenMs, t.searches, t.revised ? 1 : 0, JSON.stringify(t.notices), JSON.stringify(t.trace));
}

export function turnsForConversation(conversationId: string): Map<string, TurnRecord> {
  const rows = getDb().prepare("SELECT * FROM turns WHERE conversation_id = ?").all(conversationId);
  return new Map(rows.map((r) => [r.message_id as string, {
    messageId: r.message_id as string,
    conversationId: r.conversation_id as string,
    provider: r.provider as string,
    model: r.model as string,
    timeZone: (r.time_zone as string) ?? "",
    totalMs: Number(r.total_ms),
    firstTokenMs: r.first_token_ms == null ? null : Number(r.first_token_ms),
    searches: Number(r.searches),
    revised: Number(r.revised) === 1,
    notices: JSON.parse((r.notices_json as string) || "[]"),
    trace: JSON.parse((r.trace_json as string) || "[]"),
  }]));
}

// ---- Distilled memory ----

export interface ConversationMemory {
  conversationId: string;
  title: string;
  createdAt: string;
  summary: string;
  topics: string[];
  entities: string[];
  aliases: string[];
  decisions: string[];
  open: string[];
  messageCount: number;
  updatedAt: string;
}

function toConvMemory(r: Row): ConversationMemory {
  return {
    conversationId: r.conversation_id as string,
    title: (r.title as string) ?? "",
    createdAt: (r.created_at as string) ?? "",
    summary: r.summary as string,
    topics: JSON.parse((r.topics_json as string) || "[]"),
    entities: JSON.parse((r.entities_json as string) || "[]"),
    aliases: JSON.parse((r.aliases_json as string) || "[]"),
    decisions: JSON.parse((r.decisions_json as string) || "[]"),
    open: JSON.parse((r.open_json as string) || "[]"),
    messageCount: Number(r.message_count),
    updatedAt: r.updated_at as string,
  };
}

const CM_SELECT = `SELECT cm.*, c.title, c.created_at FROM conversation_memory cm JOIN conversations c ON c.id = cm.conversation_id`;

export function getConversationMemory(conversationId: string): ConversationMemory | null {
  const r = getDb().prepare(`${CM_SELECT} WHERE cm.conversation_id = ?`).get(conversationId);
  return r ? toConvMemory(r as Row) : null;
}

/**
 * The timeline: the most recent conversations, newest first, each with its
 * distilled memory if it has one yet. A conversation whose distillation is
 * still running (or failed) is still listed — the raw log is the truth, the
 * distilled memory is derived from it.
 */
export function recentConversations(excludeConversation?: string, limit = 30): (ConversationMemory & { firstMessage: string })[] {
  return getDb()
    .prepare(`SELECT c.id AS conversation_id, c.title, c.created_at, c.updated_at AS conv_updated_at, cm.summary, cm.topics_json,
                cm.entities_json, cm.aliases_json, cm.decisions_json, cm.open_json, cm.message_count, cm.updated_at,
                (SELECT text FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user' ORDER BY m.created_at ASC LIMIT 1) AS first_message
              FROM conversations c LEFT JOIN conversation_memory cm ON cm.conversation_id = c.id
              WHERE c.id != ? ORDER BY c.updated_at DESC LIMIT ?`)
    .all(excludeConversation ?? "", limit)
    .map((r) => ({
      ...toConvMemory({ ...r, summary: r.summary ?? "", message_count: r.message_count ?? 0, updated_at: r.updated_at ?? r.conv_updated_at } as Row),
      firstMessage: (r.first_message as string) ?? "",
    }));
}

export function saveConversationMemory(m: Omit<ConversationMemory, "title" | "createdAt">): void {
  const d = getDb();
  d.prepare(`INSERT OR REPLACE INTO conversation_memory
             (conversation_id, summary, topics_json, entities_json, aliases_json, decisions_json, open_json, message_count, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(m.conversationId, m.summary, JSON.stringify(m.topics), JSON.stringify(m.entities), JSON.stringify(m.aliases),
      JSON.stringify(m.decisions), JSON.stringify(m.open), m.messageCount, m.updatedAt);
  // Everything a later question might match on, in one searchable document.
  d.prepare("DELETE FROM conversation_memory_fts WHERE conversation_id = ?").run(m.conversationId);
  d.prepare("INSERT INTO conversation_memory_fts (conversation_id, text) VALUES (?, ?)")
    .run(m.conversationId, [m.summary, m.topics.join(", "), m.entities.join(", "), m.aliases.join(", "), m.decisions.join(". "), m.open.join(". ")].join("\n"));
}

export function searchConversationMemory(ftsQuery: string, excludeConversation?: string, limit = 8): string[] {
  if (!ftsQuery) return [];
  try {
    return getDb()
      .prepare(`SELECT conversation_id FROM conversation_memory_fts WHERE conversation_memory_fts MATCH ? AND conversation_id != ?
                ORDER BY bm25(conversation_memory_fts) LIMIT ?`)
      .all(ftsQuery, excludeConversation ?? "", limit)
      .map((r) => r.conversation_id as string);
  } catch {
    return [];
  }
}

export interface Claim {
  id: string;
  entity: string;
  attribute: string;
  value: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  observedAt: string;
  conversationId: string;
  messageId: string;
}

export const claimKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function toClaim(r: Row): Claim {
  return {
    id: r.id as string,
    entity: r.entity as string,
    attribute: r.attribute as string,
    value: r.value as string,
    sourceUrl: (r.source_url as string) ?? null,
    sourceTitle: (r.source_title as string) ?? null,
    observedAt: r.observed_at as string,
    conversationId: r.conversation_id as string,
    messageId: r.message_id as string,
  };
}

/** Insert a claim unless it repeats the latest value for the same entity+attribute. */
export function addClaim(c: Omit<Claim, "id">): boolean {
  const d = getDb();
  const ek = claimKey(c.entity), ak = claimKey(c.attribute);
  const latest = d.prepare("SELECT value FROM claims WHERE entity_key = ? AND attribute_key = ? ORDER BY observed_at DESC LIMIT 1").get(ek, ak) as Row | undefined;
  if (latest && claimKey(latest.value as string) === claimKey(c.value)) return false;
  const id = randomUUID();
  d.prepare(`INSERT INTO claims (id, entity, attribute, value, entity_key, attribute_key, source_url, source_title, observed_at, conversation_id, message_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, c.entity, c.attribute, c.value, ek, ak, c.sourceUrl, c.sourceTitle, c.observedAt, c.conversationId, c.messageId);
  d.prepare("INSERT INTO claims_fts (claim_id, text) VALUES (?, ?)").run(id, `${c.entity} ${c.attribute} ${c.value}`);
  return true;
}

/** "Entity · attribute" names already in the ledger for entities mentioned in `text`. */
export function knownClaimKeys(text: string, limit = 30): string[] {
  const t = claimKey(text);
  const rows = getDb().prepare("SELECT DISTINCT entity, attribute, entity_key FROM claims ORDER BY observed_at DESC LIMIT 500").all() as Row[];
  return rows
    .filter((r) => (r.entity_key as string).split(" ").filter((w) => w.length > 2).some((w) => t.includes(w)))
    .slice(0, limit)
    .map((r) => `${r.entity} · ${r.attribute}`);
}

export function claimsForConversations(conversationIds: string[]): Claim[] {
  if (!conversationIds.length) return [];
  return getDb()
    .prepare(`SELECT * FROM claims WHERE conversation_id IN (${conversationIds.map(() => "?").join(",")}) ORDER BY observed_at ASC`)
    .all(...conversationIds)
    .map((r) => toClaim(r as Row));
}

/** Full history (all versions) of claims whose entity/attribute/value match the query. */
export function searchClaimHistory(ftsQuery: string, limit = 12): Claim[] {
  if (!ftsQuery) return [];
  try {
    const hits = getDb()
      .prepare(`SELECT c.entity_key, c.attribute_key FROM claims_fts f JOIN claims c ON c.id = f.claim_id
                WHERE claims_fts MATCH ? ORDER BY bm25(claims_fts) LIMIT ?`)
      .all(ftsQuery, limit) as Row[];
    const keys = [...new Map(hits.map((h) => [`${h.entity_key}|${h.attribute_key}`, h])).values()].slice(0, 6);
    return keys.flatMap((k) =>
      getDb()
        .prepare("SELECT * FROM claims WHERE entity_key = ? AND attribute_key = ? ORDER BY observed_at ASC")
        .all(k.entity_key as string, k.attribute_key as string)
        .map((r) => toClaim(r as Row)),
    );
  } catch {
    return [];
  }
}

/** The whole ledger, grouped by fact, newest fact first — for the "what I remember" panel. */
export function listFacts(limit = 200): Claim[] {
  return getDb().prepare("SELECT * FROM claims ORDER BY observed_at DESC LIMIT ?").all(limit).map((r) => toClaim(r as Row));
}

/** Forget a fact: every recorded version of this entity + attribute. */
export function deleteFact(entity: string, attribute: string): void {
  const d = getDb();
  const ids = d.prepare("SELECT id FROM claims WHERE entity_key = ? AND attribute_key = ?").all(claimKey(entity), claimKey(attribute)).map((r) => r.id as string);
  for (const id of ids) {
    d.prepare("DELETE FROM claims_fts WHERE claim_id = ?").run(id);
    d.prepare("DELETE FROM claims WHERE id = ?").run(id);
  }
}

export function deleteProfileFact(key: string): void {
  getDb().prepare("DELETE FROM profile WHERE key = ?").run(claimKey(key));
}

export interface ProfileFact { key: string; value: string; updatedAt: string; conversationId: string }

export function getProfile(): ProfileFact[] {
  return getDb()
    .prepare("SELECT * FROM profile ORDER BY updated_at DESC LIMIT 12")
    .all()
    .map((r) => ({ key: r.key as string, value: r.value as string, updatedAt: r.updated_at as string, conversationId: r.conversation_id as string }));
}

export function upsertProfileFact(key: string, value: string, conversationId: string): void {
  getDb()
    .prepare("INSERT OR REPLACE INTO profile (key, value, updated_at, conversation_id) VALUES (?, ?, ?, ?)")
    .run(claimKey(key), value, now().toISOString(), conversationId);
}

export function countMessages(conversationId: string): number {
  return Number((getDb().prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id = ?").get(conversationId) as Row).n);
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

/** Each hit plus up to `before`/`after` neighbouring messages in its conversation, in order, deduped. */
export function withNeighbours(hits: MessageHit[], before = 2, after = 1): MessageHit[] {
  const out: MessageHit[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    const prev = getDb()
      .prepare(`${HIT_SELECT} WHERE m.conversation_id = ? AND m.created_at < ? ORDER BY m.created_at DESC LIMIT ?`)
      .all(h.conversationId, h.createdAt, before).map(toHit).reverse();
    const next = getDb()
      .prepare(`${HIT_SELECT} WHERE m.conversation_id = ? AND m.created_at > ? ORDER BY m.created_at ASC LIMIT ?`)
      .all(h.conversationId, h.createdAt, after).map(toHit);
    for (const m of [...prev, h, ...next]) if (!seen.has(m.id)) { seen.add(m.id); out.push(m); }
  }
  return out;
}

export function historyStats(excludeConversation?: string): { count: number; first: string | null; last: string | null } {
  const r = getDb()
    .prepare("SELECT COUNT(*) n, MIN(created_at) a, MAX(updated_at) b FROM conversations WHERE id != ?")
    .get(excludeConversation ?? "") as Row;
  return { count: Number(r.n), first: (r.a as string) ?? null, last: (r.b as string) ?? null };
}
