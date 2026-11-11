import { config } from "@/lib/config";
import { discover, type WebSearchArgs } from "@/lib/search/discover";
import { fetchPage, needsRender, renderPage, type Fetched } from "@/lib/search/read";
import { selectPassages } from "@/lib/search/rank";
import { classifySource } from "@/lib/search/sources";
import type { PageProgress, ReadMode, SourceTier } from "@/lib/types";
import { domainOf, pageKey, tokenize } from "@/lib/util";

// Our web search pipeline — what sits behind the single web_search tool:
//   1. discover (bought, swappable)  2. fetch + 3. read (ours)  4. rank (ours)
// Every step reports progress, so the UI can show which URLs are being read
// and what happened to each one.

export interface PipelineResult {
  url: string;
  title: string;
  publishedDate: string | null;
  tier: SourceTier;
  text: string; // the passages the model will see
  mode: ReadMode;
  ms: number; // time spent reading this page
  note: string; // what happened, in words
}

export interface PipelineStats {
  provider: string;
  discoveryMs: number;
  readMs: number;
  modes: Record<ReadMode, number>;
  failures: string[]; // discovery providers that failed before one answered
}

export interface PipelineProgress {
  onPages?: (provider: string, pages: PageProgress[]) => void;
  onPage?: (page: PageProgress) => void;
}

const MIN_READABLE = 200; // fewer characters than this isn't a page we read, it's a shell
const chars = (n: number) => `${n.toLocaleString("en-US")} characters read`;

export async function webSearch(
  args: WebSearchArgs,
  signal?: AbortSignal,
  progress: PipelineProgress = {},
): Promise<{ results: PipelineResult[]; stats: PipelineStats }> {
  const t0 = Date.now();
  const { provider, hits, failures } = await discover(args, signal);
  const discoveryMs = Date.now() - t0;

  // The same page under tracking/locale parameters is one page.
  const seen = new Set<string>();
  const unique = hits.filter((h) => !seen.has(pageKey(h.url)) && seen.add(pageKey(h.url)));
  const readCount = Math.min(unique.length, config.pagesReadPerSearch);

  const pages = unique.map((h) => ({
    url: h.url,
    title: h.title,
    domain: domainOf(h.url),
    tier: classifySource({ url: h.url, title: h.title, query: args.query, includeDomains: args.include_domains }),
  }));
  const report = (i: number, status: PageProgress["status"], ms?: number, note?: string): PageProgress => {
    return { ...pages[i], status, ms, note };
  };
  const beyond = `not opened — only the top ${config.pagesReadPerSearch} results are read; using the search snippet`;
  progress.onPages?.(provider, pages.map((_, i) => (i < readCount ? report(i, "fetching") : report(i, "snippet", 0, beyond))));

  // Read the top pages ourselves, in parallel. A page that clearly doesn't need
  // rendering is final as soon as its fetch returns.
  const t1 = Date.now();
  const fetched: Fetched[] = await Promise.all(
    unique.slice(0, readCount).map(async (h, i) => {
      const f = await fetchPage(h.url, signal);
      if (!needsRender(f, args.query)) progress.onPage?.(report(i, "full", f.ms, chars(f.text.length)));
      return f;
    }),
  );

  // Spend the render budget (slow, 1 Firecrawl credit each) where it matters
  // most: pages that need it, from official/targeted sources, whose URL matches
  // what was asked (/pricing for a price question), then by search rank.
  const qTerms = tokenize(args.query).filter((t) => t.length > 3);
  const pending = fetched.map((f, i) => i).filter((i) => needsRender(fetched[i], args.query));
  const toRender = !config.firecrawlApiKey ? [] : pending
    .filter((i) => pages[i].tier === "official" || pages[i].tier === "primary" || !!args.include_domains?.length)
    .map((i) => {
      let path = "";
      try { path = new URL(pages[i].url).pathname.toLowerCase(); } catch {}
      return { i, score: qTerms.filter((t) => path.includes(t.replace(/s$/, ""))).length * 10 - i };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, config.rendersPerSearch)
    .map((c) => c.i);

  // What we end up with for a page our plain fetch couldn't fully read.
  const plain = (i: number, why: string): { mode: ReadMode; ms: number; note: string } => {
    const f = fetched[i];
    return f.text.length >= MIN_READABLE
      ? { mode: "full", ms: f.ms, note: `${chars(f.text.length)}${why}` }
      : { mode: "snippet", ms: f.ms, note: `${f.failure ?? "almost no readable text (JavaScript page)"}${why} — using the search snippet` };
  };

  const outcome = new Map<number, { mode: ReadMode; ms: number; note: string; rendered?: string }>();
  for (const i of pending) {
    if (toRender.includes(i)) progress.onPage?.(report(i, "rendering", fetched[i].ms, fetched[i].failure ?? "page needs JavaScript"));
    else {
      outcome.set(i, plain(i, ""));
      progress.onPage?.(report(i, outcome.get(i)!.mode, outcome.get(i)!.ms, outcome.get(i)!.note));
    }
  }
  await Promise.all(
    toRender.map(async (i) => {
      const tr = Date.now();
      const md = await renderPage(pages[i].url, signal);
      const ms = fetched[i].ms + (Date.now() - tr);
      const o = md && md.length > fetched[i].text.length
        ? { mode: "rendered" as const, ms, note: `${chars(md.length)} after rendering JavaScript`, rendered: md }
        : { ...plain(i, "; rendering didn't help"), ms };
      outcome.set(i, o);
      progress.onPage?.(report(i, o.mode, o.ms, o.note));
    }),
  );
  const readMs = Date.now() - t1;

  const results: PipelineResult[] = unique.map((h, i) => {
    const base = { url: h.url, title: h.title, tier: pages[i].tier };
    const f = i < readCount ? fetched[i] : null;
    const o = outcome.get(i) ?? (f ? { mode: "full" as const, ms: f.ms, note: chars(f.text.length) } : { mode: "snippet" as const, ms: 0, note: beyond });
    if (o.mode === "snippet") return { ...base, publishedDate: h.publishedDate, text: h.snippet.slice(0, 1500), mode: o.mode, ms: o.ms, note: o.note };
    return {
      ...base,
      publishedDate: h.publishedDate ?? f?.publishedDate ?? null,
      text: selectPassages(o.rendered ?? f!.text, args.query),
      mode: o.mode, ms: o.ms, note: o.note,
    };
  });

  const count = (m: ReadMode) => results.filter((r) => r.mode === m).length;
  return {
    results,
    stats: { provider, discoveryMs, readMs, modes: { full: count("full"), rendered: count("rendered"), snippet: count("snippet") }, failures },
  };
}
