"use client";

import { useState } from "react";
import type { PageProgress, Source } from "@/lib/types";
import { TierBadge } from "@/components/Answer";

// The search work, shown as it happens: every query the agent ran, every URL
// that came back, and what happened to each page (read in full, rendered,
// snippet only — and why). Stays under the answer afterwards, so anyone can
// see exactly what the answer was built from.

export interface SearchStep {
  id: string;
  query: string;
  options: Record<string, unknown>;
  status: "running" | "done" | "error";
  provider?: string;
  pages: PageProgress[];
  error?: string;
}

export const pageOf = (s: Source): PageProgress => ({
  url: s.url, title: s.title, domain: s.domain, tier: s.tier, status: s.read ?? "snippet", ms: s.readMs, note: s.readNote,
});

/** Rebuild the log for a stored answer from its sources (each remembers its query and how it was read). */
export function searchesFromSources(sources: Source[]): SearchStep[] {
  const byQuery = new Map<string, SearchStep>();
  for (const s of sources) {
    const step = byQuery.get(s.query) ?? { id: s.query, query: s.query, options: {}, status: "done" as const, pages: [] };
    step.pages.push(pageOf(s));
    byQuery.set(s.query, step);
  }
  return [...byQuery.values()];
}

const STATUS: Record<PageProgress["status"], { label: string; cls: string }> = {
  fetching: { label: "fetching…", cls: "text-faint" },
  rendering: { label: "rendering…", cls: "text-faint" },
  full: { label: "read in full", cls: "text-accent-ink" },
  rendered: { label: "rendered", cls: "text-accent-ink" },
  snippet: { label: "snippet only", cls: "text-orange" },
};

const filters = (o: Record<string, unknown>) =>
  [
    Array.isArray(o.include_domains) && `only ${o.include_domains.join(", ")}`,
    o.start_date && `since ${o.start_date}`,
    o.time_range && `past ${o.time_range}`,
    o.topic === "news" && "news",
  ].filter(Boolean).join(" · ");

const shortUrl = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/$/, "");
const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function SearchLog({ searches, live }: { searches: SearchStep[]; live: boolean }) {
  // Open while the work is happening; afterwards the reader decides.
  const [toggled, setToggled] = useState<boolean | null>(null);
  if (!searches.length) return null;
  const open = toggled ?? live;
  const pages = searches.flatMap((s) => s.pages);
  const n = (status: PageProgress["status"]) => pages.filter((p) => p.status === status).length;
  const read = n("full") + n("rendered");
  return (
    <div className="mt-3 text-[11px]">
      <button type="button" onClick={() => setToggled(!open)} aria-expanded={open}
        className="cursor-pointer select-none font-mono text-faint hover:text-ink">
        {open ? "▾" : "▸"} {searches.length} search{searches.length === 1 ? "" : "es"} · {pages.length} page{pages.length === 1 ? "" : "s"} found
        {pages.length > 0 && ` · ${read} read${n("snippet") ? ` · ${n("snippet")} snippet only` : ""}`}
      </button>
      {open && (
        <ol className="mt-2 space-y-3 rounded-[10px] bg-card px-3 py-2.5 font-mono text-[10.5px] leading-relaxed text-muted">
          {searches.map((s) => (
            <li key={s.id}>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-faint">⌕</span>
                <span className="text-ink">{s.query}</span>
                {filters(s.options) && <span className="text-faint">{filters(s.options)}</span>}
                {s.provider && <span className="text-faint">via {s.provider}</span>}
                {s.status === "running" && !s.pages.length && <span className="text-faint">finding pages…</span>}
              </div>
              {s.error && <div className="mt-0.5 pl-4 text-orange">{s.error}</div>}
              {s.status === "done" && !s.pages.length && <div className="mt-0.5 pl-4 text-faint">no results</div>}
              <ul className="mt-0.5 space-y-0.5 pl-4">
                {s.pages.map((p) => (
                  <li key={p.url} title={p.note} className="flex min-w-0 items-baseline gap-2">
                    <span className={`w-[88px] shrink-0 ${STATUS[p.status].cls}`}>{STATUS[p.status].label}</span>
                    <a href={p.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-ink hover:text-accent-ink hover:underline">{shortUrl(p.url)}</a>
                    <span className="w-[62px] shrink-0">{p.tier && <TierBadge tier={p.tier} />}</span>
                    <span className="hidden w-[36%] shrink-0 truncate text-faint sm:inline">{p.note}</span>
                    <span className="w-8 shrink-0 text-right text-faint">{p.ms ? sec(p.ms) : ""}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
