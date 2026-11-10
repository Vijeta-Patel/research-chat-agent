import { config } from "@/lib/config";

// Thin client for Tavily's /search endpoint (docs.tavily.com, API reference "search").

export interface WebSearchArgs {
  query: string;
  topic?: "general" | "news";
  time_range?: "day" | "week" | "month" | "year";
  start_date?: string; // YYYY-MM-DD
  include_domains?: string[];
}

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
  published_date?: string | null;
}

// Short-lived in-process cache: the same query in the same few minutes
// (common in follow-ups and retries) costs no credits and no latency.
const cache = new Map<string, { at: number; results: TavilyResult[] }>();
const CACHE_MS = 10 * 60 * 1000;

export async function tavilySearch(args: WebSearchArgs, signal?: AbortSignal): Promise<TavilyResult[]> {
  const body: Record<string, unknown> = {
    query: args.query,
    topic: args.topic ?? "general",
    // Searches aimed at a vendor's own site (pricing, changelogs) use "advanced"
    // depth: longer, more relevant excerpts, so price tables actually reach the
    // model. Costs 2 credits instead of 1, so only where it matters.
    search_depth: args.include_domains?.length ? "advanced" : config.searchDepth,
    max_results: args.include_domains?.length ? 5 : 6,
    chunks_per_source: 3,
    include_published_date: true,
    include_answer: false,
    include_raw_content: false,
  };
  if (args.start_date) body.start_date = args.start_date;
  else if (args.time_range) body.time_range = args.time_range;
  if (args.include_domains?.length) body.include_domains = args.include_domains;

  const key = JSON.stringify(body);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.results;

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.tavilyApiKey}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const hint =
      res.status === 401 ? " (check TAVILY_API_KEY)" :
      res.status === 432 ? " (Tavily plan credit limit reached)" :
      res.status === 429 ? " (Tavily rate limit)" : "";
    throw new Error(`Tavily ${res.status}${hint}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { results?: TavilyResult[] };
  const results = json.results ?? [];
  cache.set(key, { at: Date.now(), results });
  return results;
}
