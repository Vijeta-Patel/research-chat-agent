import { config } from "@/lib/config";

// Stage 1 of web_search: DISCOVERY — "which URLs match this query?".
// The only stage we buy. Every provider returns the same shape, so they're
// interchangeable: a chain with a circuit breaker per provider and a cache.

export interface WebSearchArgs {
  query: string;
  topic?: "general" | "news";
  time_range?: "day" | "week" | "month" | "year";
  start_date?: string; // YYYY-MM-DD
  include_domains?: string[];
}

export interface Hit {
  url: string;
  title: string;
  snippet: string; // provider's excerpt — fallback text if we can't read the page ourselves
  publishedDate: string | null;
}

interface DiscoveryProvider {
  name: string;
  enabled: () => boolean;
  search: (args: WebSearchArgs, signal?: AbortSignal) => Promise<Hit[]>;
}

class ProviderError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function postJson(url: string, key: string, body: unknown, timeoutMs: number, signal?: AbortSignal) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new ProviderError(`${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`, res.status);
  return res.json();
}

const tavily: DiscoveryProvider = {
  name: "tavily",
  enabled: () => !!config.tavilyApiKey,
  async search(args, signal) {
    const body: Record<string, unknown> = {
      query: args.query,
      topic: args.topic ?? "general",
      search_depth: "basic", // 1 credit: we read the pages ourselves, so their extraction depth doesn't matter
      max_results: 6,
      chunks_per_source: 3,
      include_published_date: true,
    };
    if (args.start_date) body.start_date = args.start_date;
    else if (args.time_range) body.time_range = args.time_range;
    if (args.include_domains?.length) body.include_domains = args.include_domains;
    const json = await postJson("https://api.tavily.com/search", config.tavilyApiKey, body, 12_000, signal);
    return ((json.results ?? []) as { url: string; title?: string; content?: string; published_date?: string | null }[]).map((r) => ({
      url: r.url,
      title: r.title || r.url,
      snippet: r.content || "",
      publishedDate: r.published_date ?? null,
    }));
  },
};

const mdY = (iso: string) => { const [y, m, d] = iso.split("-"); return `${m}/${d}/${y}`; };

const firecrawl: DiscoveryProvider = {
  name: "firecrawl",
  enabled: () => !!config.firecrawlApiKey,
  async search(args, signal) {
    const body: Record<string, unknown> = { query: args.query, limit: 6, timeout: 12_000 };
    if (args.start_date) body.tbs = `cdr:1,cd_min:${mdY(args.start_date)}`;
    else if (args.time_range) body.tbs = `qdr:${args.time_range[0]}`;
    if (args.include_domains?.length) body.includeDomains = args.include_domains;
    if (args.topic === "news") body.sources = [{ type: "news" }, { type: "web" }];
    const json = await postJson("https://api.firecrawl.dev/v2/search", config.firecrawlApiKey, body, 15_000, signal);
    const d = json.data ?? {};
    type FcItem = { url: string; title?: string; description?: string; snippet?: string; date?: string };
    const items: FcItem[] = Array.isArray(d) ? d : [...(d.news ?? []), ...(d.web ?? [])];
    const seen = new Set<string>();
    return items
      .filter((r) => r.url && !seen.has(r.url) && seen.add(r.url))
      .map((r) => ({
        url: r.url,
        title: r.title || r.url,
        snippet: r.description || r.snippet || "",
        publishedDate: r.date && !Number.isNaN(Date.parse(r.date)) ? new Date(r.date).toISOString() : null,
      }));
  },
};

// Order = preference. Tavily first (generous free tier); Firecrawl takes over
// when Tavily is down, rate-limited or out of credits.
const PROVIDERS: DiscoveryProvider[] = [tavily, firecrawl];

// Circuit breaker: skip a failing provider for a while instead of paying its
// failure latency on every search. Out-of-credit errors back off much longer.
const coolUntil = new Map<string, number>();
const cooldownMs = (status: number) =>
  [401, 402, 403, 432, 433].includes(status) ? 60 * 60_000 : status === 429 ? 60_000 : 2 * 60_000;

const cache = new Map<string, { at: number; provider: string; hits: Hit[] }>();
const CACHE_MS = 10 * 60_000;

export function discoveryConfigured(): boolean {
  return PROVIDERS.some((p) => p.enabled());
}

export async function discover(
  args: WebSearchArgs,
  signal?: AbortSignal,
): Promise<{ provider: string; hits: Hit[]; failures: string[] }> {
  const key = JSON.stringify(args);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { provider: `${hit.provider} (cached)`, hits: hit.hits, failures: [] };

  const enabled = PROVIDERS.filter((p) => p.enabled());
  const healthy = enabled.filter((p) => (coolUntil.get(p.name) ?? 0) < Date.now());
  const chain = healthy.length ? healthy : enabled; // all cooling down → try anyway
  const failures: string[] = [];
  for (const p of chain) {
    try {
      const hits = await p.search(args, signal);
      cache.set(key, { at: Date.now(), provider: p.name, hits });
      return { provider: p.name, hits, failures };
    } catch (err) {
      if (signal?.aborted) throw err;
      const status = err instanceof ProviderError ? err.status : 0;
      coolUntil.set(p.name, Date.now() + cooldownMs(status));
      failures.push(`${p.name}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
    }
  }
  throw new Error(`All search providers failed — ${failures.join(" | ") || "none configured"}`);
}
