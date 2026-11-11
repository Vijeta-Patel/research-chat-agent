import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "@/lib/config";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";
import { SEARCH_TOOL_DESCRIPTION, SEARCH_TOOL_NAME, searchToolShape } from "@/lib/search/tool";
import { DECLINED, historyText, recentHistory, turnText, type GenerateHooks, type GenerateInput, type GenerateResult, type Runtime } from "@/lib/llm/shared";
import { errorMessage } from "@/lib/util";

// Optional runtime: our own agent loop on the plain Messages API, for anyone
// with an API key (CLAUDE_RUNTIME=api). Every step of the loop is here:
//
//   ask Claude (streamed) ─► it asks for web_search? ─► run every requested
//   search in parallel through hooks.search() (all guardrails apply) ─► send
//   all results back in ONE message ─► repeat, at most maxToolRounds times;
//   the last round has tools switched off, so it must answer.
//
// What the API gives us that the Agent SDK route doesn't: the system prompt
// and tool definition are cached (they are identical on every call), and a
// policy refusal is retried on a fallback model inside the same call.

let client: Anthropic | null = null;
const api = () => (client ??= new Anthropic()); // reads ANTHROPIC_API_KEY

// Identical bytes on every call, so they can be cached: tools → system is the cache prefix.
const TOOLS: Anthropic.Beta.BetaToolUnion[] = [{
  name: SEARCH_TOOL_NAME,
  description: SEARCH_TOOL_DESCRIPTION,
  // One schema for both runtimes: the same zod shape the Agent SDK route uses.
  input_schema: z.toJSONSchema(z.object(searchToolShape)) as Anthropic.Beta.BetaTool.InputSchema,
  // Stream tool input as it is generated. The API then doesn't validate it,
  // so hooks.search() repairs or rejects it (parseSearchArgs).
  eager_input_streaming: true,
}];
const SYSTEM: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }];
// A policy refusal on the main model is re-run on a fallback model inside the
// same request; "default" picks the fallback by refusal category.
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"] as Anthropic.Beta.AnthropicBeta[], fallbacks: "default" as const };

/** Earlier turns as real user/assistant messages, then this turn. */
function buildMessages(input: GenerateInput): Anthropic.Beta.BetaMessageParam[] {
  return [
    ...recentHistory(input).map((m): Anthropic.Beta.BetaMessageParam => ({ role: m.role, content: historyText(m) })),
    { role: "user", content: turnText(input) },
  ];
}

async function generate(input: GenerateInput, hooks: GenerateHooks): Promise<GenerateResult> {
  const messages = buildMessages(input);
  const t0 = Date.now();
  let firstMs = -1;
  let text = "";
  let model = config.claudeModel;
  let searches = 0;
  let blocked: string | null = null;
  const write = (delta: string) => { text += delta; hooks.onText?.(delta); };

  for (let round = 0; ; round++) {
    const lastRound = !input.allowTools || round >= config.maxToolRounds;
    const stream = api().beta.messages.stream({
      ...FALLBACK,
      model: config.claudeModel,
      max_tokens: 16_000,
      system: SYSTEM,
      tools: TOOLS, // always sent, so the cached prefix never changes…
      tool_choice: { type: lastRound ? "none" : "auto" }, // …and switched off by tool_choice instead
      output_config: { effort: config.claudeEffort },
      messages,
    }, { signal: hooks.signal });
    stream.on("text", (delta) => {
      if (firstMs < 0) firstMs = Date.now() - t0;
      write(delta);
    });
    const message = await stream.finalMessage();
    model = message.model;
    // Keep the whole assistant turn, unchanged (thinking blocks included), as the API requires.
    messages.push({ role: "assistant", content: message.content });

    if (message.stop_reason === "refusal") { blocked = DECLINED; break; }
    if (message.stop_reason === "pause_turn") continue;
    const calls = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (message.stop_reason !== "tool_use" || !calls.length) break; // end_turn, max_tokens: the answer is done

    // Text written before a tool call is a preamble; keep it visually separate.
    if (text && !text.endsWith("\n\n")) write("\n\n");
    // Every requested search runs in parallel; all results go back in one message.
    searches += calls.length;
    const results = await Promise.all(calls.map(async (c): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
      const out = await hooks.search(c.input);
      return { type: "tool_result", tool_use_id: c.id, content: JSON.stringify(out), is_error: "error" in out && !("results" in out) };
    }));
    messages.push({ role: "user", content: results });
  }

  hooks.trace({
    step: "model",
    detail: `${model} (own loop, Messages API) → ${searches ? `${searches} search(es) + answer` : "answer"}`,
    ms: Date.now() - t0,
    firstMs,
  });
  return { text: text.replace(/^\s+/, ""), blocked, model };
}

async function complete(system: string, prompt: string): Promise<string> {
  // The small model; no fallbacks (not offered on Haiku). Low effort: it fills in JSON.
  const message = await api().messages.create({
    model: config.claudeMemoryModel,
    max_tokens: 8_000,
    system,
    output_config: { effort: "low" },
    messages: [{ role: "user", content: prompt }],
  });
  if (message.stop_reason === "refusal") throw new Error("memory model declined");
  return message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
    return "Claude authentication failed: check ANTHROPIC_API_KEY in .env.local (or remove it to use a local Claude Code login).";
  if (err instanceof Anthropic.RateLimitError) return "Claude is rate-limited right now. Please try again in a moment.";
  if (err instanceof Anthropic.APIError && (err.status === 529 || (err.status ?? 0) >= 500))
    return "Claude is overloaded or unavailable right now. Please try again in a moment.";
  if (err instanceof Anthropic.APIError) return `Claude error ${err.status ?? ""}: ${errorMessage(err, 300)}`;
  return `Claude error: ${errorMessage(err, 300)}`;
}

export const messagesApiRuntime: Runtime = { name: "Messages API (own loop)", generate, complete, describeError };
