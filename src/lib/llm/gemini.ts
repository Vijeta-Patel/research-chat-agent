import { ApiError, FunctionCallingConfigMode, GoogleGenAI, type Content, type FunctionCall, type Part } from "@google/genai";
import { config } from "@/lib/config";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";
import { blockedExplanation } from "@/lib/agent/guardrails";
import { SEARCH_TOOL_DESCRIPTION, historyText, type GenerateHooks, type GenerateInput, type GenerateResult, type Provider } from "@/lib/llm/types";

// Google Gemini via @google/genai, with a hand-written model ⇄ tool loop.

const WEB_SEARCH_TOOL = {
  name: "web_search",
  description: SEARCH_TOOL_DESCRIPTION,
  parametersJsonSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query. Be specific; include product/company names." },
      topic: { type: "string", enum: ["general", "news"], description: "Use 'news' for recent events/announcements." },
      time_range: { type: "string", enum: ["day", "week", "month", "year"], description: "Only results from this recent period." },
      start_date: { type: "string", description: "Only results published on/after this date (YYYY-MM-DD). Use for 'since X' questions." },
      include_domains: {
        type: "array", items: { type: "string" },
        description: "Restrict to these domains, e.g. ['hubspot.com'] to read a vendor's own pricing/changelog.",
      },
    },
    required: ["query"],
  },
};

// The SDK retries 5xx/429 up to 5 times with exponential backoff by default
// (measured: one overloaded call took ~80s, one turn 167s). We disable that and
// do a fast fallback across models instead.
let client: GoogleGenAI | null = null;
const ai = () =>
  (client ??= new GoogleGenAI({ apiKey: config.geminiApiKey, httpOptions: { retryOptions: { attempts: 1 }, timeout: 90_000 } }));

// Circuit breaker: a model that just failed is skipped for a while. Per-minute
// limits (429) clear quickly; overload (503) and connect timeouts last longer.
const unhealthyUntil = new Map<string, number>();
const cooldownMs = (status: number | "timeout") => (status === 429 ? 60_000 : 5 * 60_000);
function modelChain(): string[] {
  const chain = [...new Set([config.geminiModel, ...config.geminiFallbackModels])];
  const healthy = chain.filter((m) => (unhealthyUntil.get(m) ?? 0) < Date.now());
  return healthy.length ? healthy : chain;
}

function buildContents(input: GenerateInput): Content[] {
  const contents: Content[] = input.history.slice(-config.historyWindow).map((m) => ({
    role: m.role === "user" ? "user" : "model",
    parts: [{ text: historyText(m) }],
  }));
  contents.push({ role: "user", parts: [{ text: input.userText }] });
  if (input.continuation) {
    contents.push({ role: "model", parts: [{ text: input.continuation.draft }] });
    contents.push({ role: "user", parts: [{ text: input.continuation.instruction }] });
  }
  return contents;
}

export const geminiProvider: Provider = {
  name: "gemini",

  async generate(input: GenerateInput, hooks: GenerateHooks): Promise<GenerateResult> {
    const contents = buildContents(input);
    // Once a model works we stay on it for the turn (thought signatures in the
    // history must come from one model).
    let pinned: string | null = null;

    async function streamRound(lastRound: boolean) {
      const attempts = pinned ? [pinned] : modelChain();
      let lastErr: unknown;
      for (let a = 0; a < attempts.length; a++) {
        const model = attempts[a];
        const modelParts: Part[] = [];
        const calls: FunctionCall[] = [];
        let roundText = "";
        let finishReason: string | undefined;
        const ctrl = new AbortController();
        const onAbort = () => ctrl.abort();
        hooks.signal?.addEventListener("abort", onAbort);
        let timedOut = false;
        const timer = a < attempts.length - 1
          ? setTimeout(() => { timedOut = true; ctrl.abort(); }, config.connectDeadlineMs)
          : null;
        const t0 = Date.now();
        let firstMs = -1;
        try {
          const stream = await ai().models.generateContentStream({
            model,
            contents,
            config: {
              systemInstruction: SYSTEM_PROMPT,
              ...(input.allowTools
                ? {
                    tools: [{ functionDeclarations: [WEB_SEARCH_TOOL] }],
                    toolConfig: { functionCallingConfig: { mode: lastRound ? FunctionCallingConfigMode.NONE : FunctionCallingConfigMode.AUTO } },
                  }
                : {}),
              abortSignal: ctrl.signal,
            },
          });
          if (timer) clearTimeout(timer);
          for await (const chunk of stream) {
            if (firstMs < 0) firstMs = Date.now() - t0;
            const cand = chunk.candidates?.[0];
            finishReason = cand?.finishReason ?? chunk.promptFeedback?.blockReason ?? finishReason;
            // Keep parts exactly as received (thought signatures must be sent back).
            for (const part of cand?.content?.parts ?? []) {
              modelParts.push(part);
              if (part.functionCall) calls.push(part.functionCall);
              else if (part.text && !part.thought) {
                roundText += part.text;
                if (!input.silent) hooks.onText(part.text);
              }
            }
          }
          if (!pinned && model !== config.geminiModel) {
            hooks.notice(`${config.geminiModel} is unavailable right now (Google overload/quota), so this answer used ${model}.`);
          }
          pinned = model;
          hooks.trace({ step: "model", detail: `${model}${calls.length ? ` → ${calls.length} search(es)` : " → answer"}${finishReason && finishReason !== "STOP" ? ` [${finishReason}]` : ""}`, ms: Date.now() - t0, firstMs });
          return { modelParts, calls, roundText, finishReason };
        } catch (err) {
          lastErr = err;
          if (hooks.signal?.aborted) throw err;
          const transient = timedOut || (err instanceof ApiError && [429, 500, 503].includes(err.status));
          if (!transient || roundText) throw err;
          const status = timedOut ? "timeout" : (err as ApiError).status;
          unhealthyUntil.set(model, Date.now() + cooldownMs(status));
          hooks.trace({ step: "model", detail: `${model} failed (${status})`, ms: Date.now() - t0 });
        } finally {
          if (timer) clearTimeout(timer);
          hooks.signal?.removeEventListener("abort", onAbort);
        }
      }
      throw lastErr;
    }

    let text = "";
    for (let round = 0; round <= input.maxRounds; round++) {
      const { modelParts, calls, roundText, finishReason } = await streamRound(!input.allowTools || round === input.maxRounds);
      contents.push({ role: "model", parts: modelParts });
      text += roundText;
      const blocked = blockedExplanation(finishReason);
      if (blocked && !calls.length) return { text, blocked, model: pinned ?? config.geminiModel };
      if (!calls.length) break;
      if (roundText) {
        text += "\n\n";
        if (!input.silent) hooks.onText("\n\n");
      }
      // All searches from this round run in parallel.
      const responses = await Promise.all(
        calls.map(async (call): Promise<Part> => ({
          functionResponse: { id: call.id, name: call.name, response: call.name === "web_search" ? await hooks.search(call.args) : { error: "Unknown tool." } },
        })),
      );
      contents.push({ role: "user", parts: responses });
    }
    return { text, blocked: null, model: pinned ?? config.geminiModel };
  },

  async complete(system: string, prompt: string): Promise<string> {
    // Same resilience as the main loop: fall through models on overload/quota.
    let lastErr: unknown;
    for (const model of [...new Set([config.geminiMemoryModel, ...modelChain()])]) {
      try {
        const res = await ai().models.generateContent({
          model,
          contents: prompt,
          config: { systemInstruction: system, responseMimeType: "application/json" },
        });
        return res.text ?? "";
      } catch (err) {
        lastErr = err;
        if (!(err instanceof ApiError && [429, 500, 503].includes(err.status))) throw err;
        unhealthyUntil.set(model, Date.now() + cooldownMs(err.status));
      }
    }
    throw lastErr;
  },

  describeError(err: unknown): string {
    if (err instanceof ApiError) {
      if (err.status === 429)
        return `Gemini's rate limit or daily quota was reached for every model tried (${modelChain().join(", ")}). Free-tier limits are per project per day — wait, or change GEMINI_MODEL / GEMINI_FALLBACK_MODELS.`;
      if (err.status === 503 || err.status === 500) return "All configured Gemini models are overloaded right now. Please try again in a minute.";
      if (err.status === 404) return `Gemini model "${config.geminiModel}" was not found. Check GEMINI_MODEL in .env.local.`;
      return `Gemini error ${err.status}: ${err.message.slice(0, 300)}`;
    }
    return err instanceof Error ? err.message : String(err);
  },
};
