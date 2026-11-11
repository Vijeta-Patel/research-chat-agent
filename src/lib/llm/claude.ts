import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";
import { config } from "@/lib/config";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";
import { SEARCH_TOOL_DESCRIPTION, SEARCH_TOOL_NAME, searchToolShape } from "@/lib/search/tool";
import type { Source, StoredMessage, TraceStep } from "@/lib/types";
import { citedIds, errorMessage } from "@/lib/util";

// The model: Claude via the Claude Agent SDK. This is the boundary between "the
// agent" (memory, search tool, guardrails, checks — ours, in src/lib/agent) and
// "the model". The SDK runs the model ⇄ tool loop; we configure it down to
// exactly what the brief allows:
//   - tools: []            → every built-in tool (files, shell, web) is OFF
//   - one MCP tool         → our web_search, whose handler is hooks.search()
//                            (all search guardrails apply)
//   - settingSources: []   → no CLAUDE.md / user settings leak into the agent
//   - persistSession:false → the SDK keeps no history of its own; our SQLite
//                            store is the single source of memory
// Auth: ANTHROPIC_API_KEY if set, otherwise the local Claude Code login.

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

const SERVER = "agent";
// Everything off except the one tool; the same for every call we make.
const LOCKED_DOWN = { tools: [], settingSources: [], persistSession: false, cwd: tmpdir() }; // no business with the project directory

// One past assistant turn as text, with a compact list of the sources it cited,
// so follow-ups ("what about the second one?") still resolve. Raw search
// results are NOT replayed — they are the biggest token cost.
function historyText(m: StoredMessage): string {
  if (m.role !== "assistant") return m.text;
  const cited = new Set(citedIds(m.text, "S"));
  const list = m.sources
    .filter((s: Source) => cited.has(s.id))
    .map((s) => `[${s.id}] ${s.title} — ${s.domain}${s.publishedDate ? `, ${s.publishedDate.slice(0, 10)}` : ""}`);
  return list.length ? `${m.text}\n\n(Sources cited above: ${list.join("; ")})` : m.text;
}

// History is replayed as a plain-text transcript (stateless calls; our DB is
// the memory), followed by this turn's context + message.
function buildPrompt(input: GenerateInput): string {
  const past = input.history.slice(-config.historyWindow);
  const transcript = past.length
    ? `<conversation_so_far>\n${past.map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${historyText(m)}`).join("\n\n")}\n</conversation_so_far>\n\n`
    : "";
  let prompt = transcript + input.userText;
  if (input.continuation) {
    prompt += `\n\n<your_draft_answer>\n${input.continuation.draft}\n</your_draft_answer>\n\n${input.continuation.instruction}`;
  }
  return prompt;
}

/** One answer: the model ⇄ web_search loop, streamed. */
export async function generate(input: GenerateInput, hooks: GenerateHooks): Promise<GenerateResult> {
  let toolCalls = 0;
  const webSearch = tool(SEARCH_TOOL_NAME, SEARCH_TOOL_DESCRIPTION, searchToolShape, async (args) => {
    toolCalls++;
    return { content: [{ type: "text" as const, text: JSON.stringify(await hooks.search(args)) }] };
  });

  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  hooks.signal?.addEventListener("abort", onAbort);

  const t0 = Date.now();
  let firstMs = -1;
  let text = "";
  let lastBlockWasText = false;
  let model = config.claudeModel;
  let blocked: string | null = null;
  let error: string | null = null;
  const write = (delta: string) => { text += delta; hooks.onText?.(delta); };

  try {
    for await (const m of query({
      prompt: buildPrompt(input),
      options: {
        ...LOCKED_DOWN,
        model: config.claudeModel,
        effort: config.claudeEffort,
        systemPrompt: SYSTEM_PROMPT,
        allowedTools: input.allowTools ? [`mcp__${SERVER}__${SEARCH_TOOL_NAME}`] : [],
        mcpServers: input.allowTools ? { [SERVER]: createSdkMcpServer({ name: SERVER, version: "1.0.0", tools: [webSearch] }) } : {},
        maxTurns: input.allowTools ? config.maxToolRounds + 1 : 1,
        includePartialMessages: true,
        abortController,
      },
    })) {
      if (m.type === "system" && m.subtype === "init") {
        model = m.model;
      } else if (m.type === "stream_event") {
        const ev = m.event;
        if (ev.type === "content_block_start") {
          // Text written before a tool call is a preamble; keep it visually separate.
          if (ev.content_block.type === "tool_use" && lastBlockWasText) write("\n\n");
          lastBlockWasText = ev.content_block.type === "text";
        } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          if (firstMs < 0) firstMs = Date.now() - t0;
          write(ev.delta.text);
        }
      } else if (m.type === "system" && m.subtype === "api_retry") {
        hooks.trace({ step: "model", detail: `${model} retry #${m.attempt} (HTTP ${m.error_status ?? "?"})`, ms: Date.now() - t0 });
      } else if (m.type === "system" && m.subtype === "model_refusal_no_fallback") {
        blocked = "I can't help with that request — the model declined it. If this seems wrong, try rephrasing what you need.";
      } else if (m.type === "result") {
        if (m.subtype !== "success" && m.subtype !== "error_max_turns") error = (m.errors ?? []).join("; ") || m.subtype;
        if (m.stop_reason === "refusal" && !blocked) blocked = "I can't help with that request — the model declined it.";
      }
    }
  } finally {
    hooks.signal?.removeEventListener("abort", onAbort);
  }

  hooks.trace({
    step: "model",
    detail: `${model} → ${toolCalls ? `${toolCalls} search(es) + answer` : "answer"}`,
    ms: Date.now() - t0,
    firstMs,
  });
  if (error && !text.trim()) throw new Error(error);
  return { text: text.replace(/^\s+/, ""), blocked, model };
}

/** One cheap, tool-free completion on the small model (background memory distillation). */
export async function complete(system: string, prompt: string): Promise<string> {
  let text = "";
  for await (const m of query({
    prompt,
    options: { ...LOCKED_DOWN, model: config.claudeMemoryModel, effort: "low", systemPrompt: system, allowedTools: [], maxTurns: 1 },
  })) {
    if (m.type === "assistant") for (const b of m.message.content) if (b.type === "text") text += b.text;
    if (m.type === "result" && m.subtype !== "success" && !text) throw new Error((m.errors ?? []).join("; ") || m.subtype);
  }
  return text;
}

export function describeError(err: unknown): string {
  const msg = errorMessage(err, 300);
  if (/auth|api key|login|401|403/i.test(msg))
    return `Claude authentication failed: set ANTHROPIC_API_KEY in .env.local (or sign in to Claude Code on this machine). Details: ${msg.slice(0, 200)}`;
  if (/429|rate limit|overloaded|529/i.test(msg)) return "Claude is rate-limited or overloaded right now. Please try again in a moment.";
  return `Claude error: ${msg}`;
}
