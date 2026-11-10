import { config } from "@/lib/config";
import { discover, type WebSearchArgs } from "@/lib/search/discover";
import { fetchPage, needsRender, renderPage, type ReadMode } from "@/lib/search/read";
import { selectPassages } from "@/lib/search/rank";
import { classifySource } from "@/lib/search/sources";

// Our web search pipeline — what sits behind the single web_search tool:
//   1. discover (bought, swappable)  2. fetch + 3. read (ours)  4. rank (ours)

export interface PipelineResult {
  url: string;
  title: string;
  publishedDate: string | null;
  text: string; // the passages the model will see
  mode: ReadMode; // full page / rendered page / provider snippet
}

export interface PipelineStats {
  provider: string;
  discoveryMs: number;
  readMs: number;
  full: number;
  rendered: number;
  snippet: number;
  failures: string[];
}

export async function webSearch(
  args: WebSearchArgs,
  signal?: AbortSignal,
): Promise<{ results: PipelineResult[]; stats: PipelineStats }> {
  const t0 = Date.now();
  const { provider, hits, failures } = await discover(args, signal);
  const discoveryMs = Date.now() - t0;

  // Same page under different query strings (?currency=EUR, tracking params) is one page.
  const seen = new Set<string>();
  const unique = hits.filter((h) => {
    let k = h.url;
    try { const u = new URL(h.url); k = (u.hostname.replace(/^www\./, "") + u.pathname).replace(/\/$/, "").toLowerCase(); } catch {}
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Read the top pages ourselves, in parallel.
  const toRead = unique.slice(0, config.pagesReadPerSearch);
  const t1 = Date.now();
  const fetched = await Promise.all(toRead.map((h) => fetchPage(h.url, signal)));

  // Spend the render budget (slow, 1 Firecrawl credit each) where it matters
  // most: pages that need it, from official/targeted sources, whose URL matches
  // what was asked (/pricing for a price question), then by search rank.
  const qTerms = args.query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const candidates = toRead
    .map((h, i) => {
      const tier = classifySource({ url: h.url, title: h.title, query: args.query, includeDomains: args.include_domains });
      const important = tier === "official" || tier === "primary" || !!args.include_domains?.length;
      let path = "";
      try { path = new URL(h.url).pathname.toLowerCase(); } catch {}
      const urlMatch = qTerms.filter((t) => t.length > 3 && path.includes(t.replace(/s$/, ""))).length;
      return { i, important, score: urlMatch * 10 - i };
    })
    .filter((c) => c.important && needsRender(fetched[c.i], args.query))
    .sort((a, b) => b.score - a.score)
    .slice(0, config.rendersPerSearch);
  const rendered = new Map<number, string>();
  await Promise.all(
    candidates.map(async ({ i }) => {
      const md = await renderPage(toRead[i].url, signal);
      if (md && md.length > fetched[i].text.length) rendered.set(i, md);
    }),
  );
  const readMs = Date.now() - t1;

  const results: PipelineResult[] = unique.map((h, i) => {
    const md = rendered.get(i);
    const page = i < fetched.length ? fetched[i] : null;
    if (md) return { url: h.url, title: h.title, publishedDate: h.publishedDate ?? page?.publishedDate ?? null, text: selectPassages(md, args.query), mode: "rendered" };
    if (page && page.text.length >= 200) {
      return { url: h.url, title: h.title, publishedDate: h.publishedDate ?? page.publishedDate, text: selectPassages(page.text, args.query), mode: "full" };
    }
    return { url: h.url, title: h.title, publishedDate: h.publishedDate, text: h.snippet.slice(0, 1500), mode: "snippet" };
  });

  return {
    results,
    stats: {
      provider,
      discoveryMs,
      readMs,
      full: results.filter((r) => r.mode === "full").length,
      rendered: results.filter((r) => r.mode === "rendered").length,
      snippet: results.filter((r) => r.mode === "snippet").length,
      failures,
    },
  };
}
