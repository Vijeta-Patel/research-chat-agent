import { config } from "@/lib/config";
import type { Source, StoredMessage, TraceStep } from "@/lib/types";
import { citedIds } from "@/lib/util";

// What both model runtimes share: the shape of a call, and how the earlier
// turns of a conversation are replayed. Neither runtime touches storage or the
// web directly — they call hooks.search(), which applies every search guardrail.

export interface GenerateInput {
  history: StoredMessage[]; // earlier turns of this conversation (plain text + cited sources)
  userText: string; // this turn: context/memory preamble + the user's message
  // Optional second pass: the model's own draft plus an instruction about it
  // (used by the freshness check and the citation repair pass).
  continuation?: { draft: string; instruction: string };
  allowTools: boolean;
}

export interface GenerateHooks {
  /** Streamed answer text. Omit for silent passes (verification, repair). */
  onText?: (delta: string) => void;
  /** Runs one guarded web search; returns the tool result object for the model. */
  search: (rawArgs: unknown) => Promise<Record<string, unknown>>;
  trace: (step: TraceStep) => void;
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  blocked: string | null; // human explanation if the model declined to answer
  model: string;
}

export interface Runtime {
  name: string; // shown in "how i got this"
  generate(input: GenerateInput, hooks: GenerateHooks): Promise<GenerateResult>;
  /** One cheap, tool-free completion on the small model (background memory distillation). */
  complete(system: string, prompt: string): Promise<string>;
  describeError(err: unknown): string;
}

export const DECLINED = "I can't help with that request — the model declined it. If this seems wrong, try rephrasing what you need.";

// One past assistant turn as text, with a compact list of the sources it cited,
// so follow-ups ("what about the second one?") still resolve. Raw search
// results are NOT replayed — they are the biggest token cost.
export function historyText(m: StoredMessage): string {
  if (m.role !== "assistant") return m.text;
  const cited = new Set(citedIds(m.text, "S"));
  const list = m.sources
    .filter((s: Source) => cited.has(s.id))
    .map((s) => `[${s.id}] ${s.title} — ${s.domain}${s.publishedDate ? `, ${s.publishedDate.slice(0, 10)}` : ""}`);
  return list.length ? `${m.text}\n\n(Sources cited above: ${list.join("; ")})` : m.text;
}

/** The last turns that are replayed verbatim (older ones reach the model through memory). */
export const recentHistory = (input: GenerateInput) => input.history.slice(-config.historyWindow);

/** This turn's user content: context + message, plus the draft and instruction on a second pass. */
export function turnText(input: GenerateInput): string {
  return input.continuation
    ? `${input.userText}\n\n<your_draft_answer>\n${input.continuation.draft}\n</your_draft_answer>\n\n${input.continuation.instruction}`
    : input.userText;
}
