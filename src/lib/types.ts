// Shared shapes between server and client.

export type SourceTier = "official" | "primary" | "news" | "community" | "listicle" | "other";

export interface Source {
  id: string; // "S7" — stable for the whole conversation, cited inline as [S7]
  url: string;
  title: string;
  domain: string;
  tier: SourceTier;
  publishedDate: string | null; // ISO date if the page has one
  retrievedAt: string; // ISO timestamp we fetched it
  excerpt: string; // text the model actually saw (used for the number check)
  query: string; // search that surfaced it
}

export interface MemoryRecord {
  id: string; // "M3" — cited inline as [M3]
  conversationId: string;
  conversationTitle: string;
  createdAt: string; // ISO
  role: "user" | "assistant";
  text: string;
}

export interface MemoryReport {
  dateRefs: { phrase: string; from: string; to: string; label: string }[];
  searchedTerms: string[];
  records: MemoryRecord[];
  totalConversations: number;
  note: string; // human-readable summary shown in the UI ("memory used")
}

export interface CheckResult {
  uncitedSentences: string[];
  unknownCitations: string[];
  unsupportedNumbers: { value: string; cited: string[] }[];
}

export interface TraceStep {
  step: "model" | "search" | "repair" | "guard";
  detail: string;
  ms: number;
  firstMs?: number; // time to first streamed chunk (model calls)
}

// Events streamed to the browser (one JSON object per SSE "data:" line).
export type AgentEvent =
  | { type: "conversation"; id: string; title: string }
  | { type: "memory"; report: MemoryReport }
  | { type: "search_start"; query: string; options: Record<string, unknown> }
  | { type: "search_done"; query: string; sources: Source[]; error?: string }
  | { type: "text"; delta: string }
  | { type: "notice"; message: string }
  | { type: "checks"; result: CheckResult }
  | { type: "revision"; text: string; result: CheckResult; note: string }
  | { type: "done"; messageId: string; ms: number; trace: TraceStep[] }
  | { type: "error"; message: string };

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  sources: Source[];
  memory: MemoryRecord[];
  checks: CheckResult | null;
}
