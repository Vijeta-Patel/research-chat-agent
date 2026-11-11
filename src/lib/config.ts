// Central place for settings. Models and keys come from the environment, so
// the graders can run it on their own key.

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export const config = {
  // The model: Claude. Primary runtime is the Claude Agent SDK, which runs on
  // ANTHROPIC_API_KEY or, without one, on the local Claude Code login — this
  // project was built without an API key. CLAUDE_RUNTIME=api switches to our
  // own loop on the Messages API (needs ANTHROPIC_API_KEY).
  claudeRuntime: (process.env.CLAUDE_RUNTIME === "api" ? "api" : "agent-sdk") as "api" | "agent-sdk",
  claudeModel: process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
  // Sonnet 5.5 defaults to "high"; "medium" is the recommended starting point
  // for multi-step tool use and keeps chat latency down.
  claudeEffort: (process.env.CLAUDE_EFFORT || "medium") as Effort,
  // Small, fast model for background memory distillation (summaries, claims, profile).
  claudeMemoryModel: process.env.CLAUDE_MEMORY_MODEL || "claude-haiku-5-5",

  // Web search: discovery providers (tried in order, at least one key needed).
  tavilyApiKey: process.env.TAVILY_API_KEY ?? "",
  firecrawlApiKey: process.env.FIRECRAWL_API_KEY ?? "",
  // Our reader: how many result pages we fetch and read per search, how long we
  // wait for each, and how many may be rendered (JS pages, via Firecrawl).
  pagesReadPerSearch: 5,
  pageFetchTimeoutMs: 4_500,
  rendersPerSearch: 2,
  dbPath: process.env.DB_PATH || "data/agent.db",

  // Guardrail budgets per user turn.
  maxSearchesPerTurn: 6,
  maxToolRounds: 4,
  turnSoftDeadlineMs: 45_000, // after this, searches are refused and the model answers with what it has
  // Per-client rate limit on the chat endpoint (protects the API keys/quotas).
  rateLimitPerMinute: 12,
  // How many past messages of the current conversation are replayed verbatim.
  historyWindow: 20,
  // Memory: how many recent conversations are always in view (the timeline), and
  // the size of the whole memory block in the prompt (~3.5k tokens) however long the history is.
  memoryTimeline: 6,
  memoryBudgetChars: 14_000,
};

export function missingKeys(): string[] {
  const missing: string[] = [];
  if (!config.tavilyApiKey && !config.firecrawlApiKey) missing.push("TAVILY_API_KEY or FIRECRAWL_API_KEY");
  return missing;
}
