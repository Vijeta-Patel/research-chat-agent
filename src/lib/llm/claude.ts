import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";
import { z } from "zod";
import { config } from "@/lib/config";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";
import { SEARCH_TOOL_DESCRIPTION, historyText, type GenerateHooks, type GenerateInput, type GenerateResult, type Provider } from "@/lib/llm/types";

// Claude via the Claude Agent SDK. The SDK runs the model ⇄ tool loop; we
// configure it down to exactly what the brief allows:
//   - tools: []            → every built-in tool (files, shell, web) is OFF
//   - one MCP tool         → our web_search, whose handler is hooks.search()
//                            (all search guardrails apply)
//   - settingSources: []   → no CLAUDE.md / user settings leak into the agent
//   - persistSession:false → the SDK keeps no history of its own; our SQLite
//                            store is the single source of memory
// Auth: ANTHROPIC_API_KEY if set, otherwise the local Claude Code login.

const SERVER = "agent";
const TOOL_NAME = `mcp__${SERVER}__web_search`;

// Lenient schema on purpose: models sometimes send a list for a string (or the
// reverse). We accept it here and repair it in normalizeArgs, rather than
// failing the call.
const searchShape = {
  query: z.union([z.string(), z.array(z.string())]).describe("Search query. Be specific; include product/company names."),
  topic: z.string().optional().describe("'general' or 'news' (recent events/announcements)."),
  time_range: z.string().optional().describe("'day' | 'week' | 'month' | 'year': only results from this recent period."),
  start_date: z.string().optional().describe("Only results published on/after this date (YYYY-MM-DD). Use for 'since X' questions."),
  include_domains: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .describe("Restrict to these domains, e.g. ['hubspot.com'] to read a vendor's own pricing/changelog."),
};

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

export const claudeProvider: Provider = {
  name: "claude",

  async generate(input: GenerateInput, hooks: GenerateHooks): Promise<GenerateResult> {
    let toolCalls = 0;
    const webSearch = tool("web_search", SEARCH_TOOL_DESCRIPTION, searchShape, async (args) => {
      toolCalls++;
      const result = await hooks.search(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
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

    try {
      for await (const m of query({
        prompt: buildPrompt(input),
        options: {
          model: config.claudeModel,
          effort: config.claudeEffort,
          systemPrompt: SYSTEM_PROMPT,
          tools: [],
          allowedTools: input.allowTools ? [TOOL_NAME] : [],
          mcpServers: input.allowTools ? { [SERVER]: createSdkMcpServer({ name: SERVER, version: "1.0.0", tools: [webSearch] }) } : {},
          maxTurns: input.allowTools ? input.maxRounds + 1 : 1,
          includePartialMessages: true,
          settingSources: [],
          persistSession: false,
          cwd: tmpdir(), // the agent has no business with the project directory
          abortController,
        },
      })) {
        if (m.type === "system" && m.subtype === "init") {
          model = m.model;
        } else if (m.type === "stream_event") {
          const ev = m.event;
          if (ev.type === "content_block_start") {
            // Text written before a tool call is a preamble; keep it visually separate.
            if (ev.content_block.type === "tool_use" && lastBlockWasText) {
              text += "\n\n";
              if (!input.silent) hooks.onText("\n\n");
            }
            lastBlockWasText = ev.content_block.type === "text";
          } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            if (firstMs < 0) firstMs = Date.now() - t0;
            text += ev.delta.text;
            if (!input.silent) hooks.onText(ev.delta.text);
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
  },

  describeError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    if (/auth|api key|login|401|403/i.test(msg))
      return `Claude authentication failed: set ANTHROPIC_API_KEY in .env.local (or sign in to Claude Code on this machine). Details: ${msg.slice(0, 200)}`;
    if (/429|rate limit|overloaded|529/i.test(msg)) return "Claude is rate-limited or overloaded right now. Please try again in a moment.";
    return `Claude error: ${msg.slice(0, 300)}`;
  },
};
