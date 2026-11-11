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
  read?: ReadMode; // how we got the text
  readMs?: number; // how long reading this page took
  readNote?: string; // what happened, in words: "12,430 characters read" / "HTTP 403 — used the search snippet"
}

// How a page's text was obtained: our own reader, a JavaScript render, or
// (when the page couldn't be read) the search provider's snippet.
export type ReadMode = "full" | "rendered" | "snippet";

// Live progress of one page inside a search, streamed to the UI as it happens.
export interface PageProgress {
  url: string;
  title: string;
  domain: string;
  tier?: SourceTier;
  status: "fetching" | "rendering" | ReadMode; // the ReadMode values are final
  ms?: number;
  note?: string;
}

export interface MemoryRecord {
  id: string; // "M3" — cited inline as [M3]
  kind: "message" | "summary" | "claims" | "profile";
  conversationId: string; // "" for the profile
  conversationTitle: string;
  createdAt: string; // ISO
  role?: "user" | "assistant"; // for kind "message"
  text: string;
}

export interface MemoryReport {
  aboutOurPast: boolean; // the message asks about our earlier conversations
  recalled: string[]; // titles of the conversations recall selected for this message (best first)
  // alternative: a second reading of an ambiguous phrase ("last Tuesday" → this week's or last week's)
  dateRefs: { phrase: string; from: string; to: string; label: string; alternative?: boolean }[];
  searchedTerms: string[];
  records: MemoryRecord[];
  totalConversations: number;
  note: string; // human-readable summary shown in the UI ("memory used")
  retrievers?: { dates: number; keywords: number; topics: number; facts: number };
}

export interface CheckResult {
  uncitedSentences: string[];
  unknownCitations: string[];
  unsupportedNumbers: { value: string; cited: string[] }[];
}

export interface TraceStep {
  step: "model" | "search" | "repair" | "guard" | "memory";
  detail: string;
  ms: number;
  firstMs?: number; // time to first streamed chunk (model calls)
}

// Events streamed to the browser (one JSON object per SSE "data:" line).
export type AgentEvent =
  | { type: "conversation"; id: string; title: string }
  | { type: "memory"; report: MemoryReport }
  | { type: "search_start"; searchId: string; query: string; options: Record<string, unknown> }
  | { type: "search_pages"; searchId: string; provider: string; pages: PageProgress[] } // discovery finished: the URLs found
  | { type: "search_page"; searchId: string; page: PageProgress } // one page changed state
  | { type: "search_done"; searchId: string; query: string; sources: Source[]; error?: string }
  | { type: "text"; delta: string }
  | { type: "notice"; message: string }
  | { type: "checks"; result: CheckResult }
  | { type: "revision"; text: string; result: CheckResult; note: string }
  | { type: "done"; messageId: string; ms: number; trace: TraceStep[]; turn: TurnMeta }
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
  turn?: TurnMeta; // how this answer was produced (assistant messages)
}

export interface TurnMeta {
  provider: string;
  model: string;
  totalMs: number;
  firstTokenMs: number | null;
  searches: number;
  revised: boolean;
  notices: string[];
  trace: TraceStep[];
}
