import type { StoredMessage, TraceStep } from "@/lib/types";

// The boundary between "the agent" (memory, search tool, guardrails, checks —
// all ours, in run.ts) and "the model" (a provider that runs the model ⇄ tool
// loop). Providers never touch storage or the web directly: they call
// hooks.search(), which applies every search guardrail.

export interface GenerateInput {
  history: StoredMessage[]; // earlier turns of this conversation (plain text + cited sources)
  userText: string; // this turn: context/memory preamble + the user's message
  // Optional second pass: the model's own draft plus an instruction about it
  // (used by the freshness check and the citation repair pass).
  continuation?: { draft: string; instruction: string };
  allowTools: boolean;
  silent: boolean; // don't stream text to the user (verification passes)
  maxRounds: number; // model ⇄ tool round-trips
}

export interface GenerateHooks {
  onText: (delta: string) => void;
  /** Runs one guarded web search; returns the tool result object for the model. */
  search: (rawArgs: unknown) => Promise<Record<string, unknown>>;
  trace: (step: TraceStep) => void;
  notice: (message: string) => void;
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  blocked: string | null; // human explanation if the provider's safety system stopped the answer
  model: string;
}

export interface Provider {
  name: string;
  generate(input: GenerateInput, hooks: GenerateHooks): Promise<GenerateResult>;
  describeError(err: unknown): string;
}

// One past assistant turn as text, with a compact list of the sources it cited,
// so follow-ups ("what about the second one?") still resolve. Raw search
// results are NOT replayed — they are the biggest token cost.
export function historyText(m: StoredMessage): string {
  if (m.role !== "assistant") return m.text;
  const cited = new Set(m.text.match(/S\d+/g) ?? []);
  const list = m.sources
    .filter((s) => cited.has(s.id))
    .map((s) => `[${s.id}] ${s.title} — ${s.domain}${s.publishedDate ? `, ${s.publishedDate.slice(0, 10)}` : ""}`);
  return list.length ? `${m.text}\n\n(Sources cited above: ${list.join("; ")})` : m.text;
}

export const SEARCH_TOOL_DESCRIPTION =
  "Search the web. Returns results with an ID (cite as [S#]), title, domain, reliability tier, published date and relevant page text. " +
  "Call several times in parallel for independent sub-questions.";
