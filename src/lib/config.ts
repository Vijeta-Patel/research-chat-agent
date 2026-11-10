// Central place for env-driven settings. Everything model- or provider-specific
// is configurable so the graders can run it on their own key and quota.

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export const config = {
  // "claude" (default): Claude via the Claude Agent SDK — uses ANTHROPIC_API_KEY,
  // or the local Claude Code login if no key is set.
  // "gemini": Google Gemini via @google/genai (needs GEMINI_API_KEY).
  llmProvider: (process.env.LLM_PROVIDER || "claude") as "claude" | "gemini",

  claudeModel: process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
  // Sonnet 5.5 defaults to "high"; "medium" is the recommended starting point
  // for multi-step tool use and keeps chat latency down.
  claudeEffort: (process.env.CLAUDE_EFFORT || "medium") as Effort,

  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL || process.env.MAIN_MODEL || "gemini-3.6-flash",
  // Tried in order when the main Gemini model is overloaded (503) or out of quota (429).
  geminiFallbackModels: (process.env.GEMINI_FALLBACK_MODELS || process.env.FALLBACK_MODELS || "gemini-3.5-flash-lite,gemini-3.8-flash")
    .split(",").map((m) => m.trim()).filter(Boolean),
  // If a Gemini model hasn't started responding within this time and another
  // model is available, abandon it (overloaded models took ~11s just to 503).
  connectDeadlineMs: 15_000,

  tavilyApiKey: process.env.TAVILY_API_KEY ?? "",
  // Tavily: "basic" = 1 credit, "advanced" = 2 credits per search.
  searchDepth: (process.env.SEARCH_DEPTH || "basic") as "basic" | "advanced",
  dbPath: process.env.DB_PATH || "data/agent.db",

  // Guardrail budgets per user turn.
  maxSearchesPerTurn: 6,
  maxToolRounds: 4,
  turnSoftDeadlineMs: 45_000, // after this, searches are refused and the model answers with what it has
  // Per-client rate limit on the chat endpoint (protects the API keys/quotas).
  rateLimitPerMinute: 12,
  // How many past messages of the current conversation are replayed verbatim.
  historyWindow: 20,
};

export function missingKeys(): string[] {
  const missing: string[] = [];
  if (config.llmProvider === "gemini" && !config.geminiApiKey) missing.push("GEMINI_API_KEY");
  if (!config.tavilyApiKey) missing.push("TAVILY_API_KEY");
  return missing;
}
