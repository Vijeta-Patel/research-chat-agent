"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useMemo } from "react";
import { findEvidence, linkCitations } from "@/lib/evidence";
import type { MemoryRecord, Source } from "@/lib/types";
import { citedIds } from "@/lib/util";

// Plain coloured words, no pill backgrounds.
const TIER_BADGE: Record<Source["tier"], { label: string; cls: string }> = {
  official: { label: "official", cls: "text-accent-ink" },
  primary: { label: "primary", cls: "text-accent-ink" },
  news: { label: "news", cls: "text-ink" },
  community: { label: "community", cls: "text-muted" },
  listicle: { label: "roundup", cls: "text-orange" },
  other: { label: "web", cls: "text-muted" },
};

export function TierBadge({ tier }: { tier: Source["tier"] }) {
  const b = TIER_BADGE[tier];
  return <span className={`shrink-0 font-mono text-[10px] lowercase ${b.cls}`}>{b.label}</span>;
}

export const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "undated";

const READ_LABEL = { full: "page read in full", rendered: "page rendered + read", snippet: "search snippet only" } as const;

// A web citation: the number opens the page at the passage that backs the
// claim; hovering shows that passage as the agent read it, figures marked.
function SourceCitation({ source: s, claim }: { source: Source; claim: string }) {
  const ev = useMemo(() => findEvidence(claim, s.excerpt, s.url), [claim, s.excerpt, s.url]);
  const parts: React.ReactNode[] = [];
  let at = 0;
  ev.marks.forEach(([from, to], i) => {
    if (from < at) return;
    parts.push(ev.passage.slice(at, from), <mark key={i} className="rounded-[3px] bg-orange/40 px-0.5 text-night-ink">{ev.passage.slice(from, to)}</mark>);
    at = to;
  });
  parts.push(ev.passage.slice(at));
  return (
    <span className="group relative inline-block align-super">
      <a href={ev.url} target="_blank" rel="noreferrer"
        className="mx-0.5 font-mono text-[11px] font-medium text-accent-ink no-underline hover:underline">
        {s.id.slice(1)}
      </a>
      <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-1.5 hidden w-80 -translate-x-1/2 rounded-xl bg-night p-3 text-xs font-light leading-snug text-night-ink shadow-[0_8px_30px_rgba(0,0,0,0.25)] group-hover:block">
        <span className="mb-1 flex items-center gap-2"><TierBadge tier={s.tier} /><span className="truncate font-mono text-[10px] text-night-muted">{s.domain} · {fmtDate(s.publishedDate)}{s.read ? ` · ${READ_LABEL[s.read]}` : ""}</span></span>
        <span className="block font-medium">{s.title}</span>
        <span className="mt-2 block font-mono text-[10px] text-night-muted">{ev.basis === "none" ? "what the agent read (no exact match for this sentence):" : "what the agent read:"}</span>
        <span className="mt-0.5 line-clamp-6 block whitespace-pre-line border-l-2 border-night-line pl-2 text-night-ink/85">{at > 0 || ev.basis !== "none" ? "…" : ""}{parts}…</span>
        {ev.missing.length > 0 && (
          <span className="mt-1.5 block text-orange">not in this source&rsquo;s text: {ev.missing.join(", ")} — a calculation, or from another cited source</span>
        )}
        <span className="mt-2 block font-mono text-[10px] text-night-muted">click the number to open the page{ev.url !== s.url ? " at this passage" : ""}</span>
      </span>
    </span>
  );
}

export function Answer(props: {
  text: string;
  sources: Map<string, Source>;
  memory: Map<string, MemoryRecord>;
  onOpenConversation: (id: string) => void;
}) {
  const { sources, memory } = props;
  const { markdown, claims } = useMemo(() => linkCitations(props.text), [props.text]);
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            if (href?.startsWith("#cite-")) {
              const [, id, n] = href.match(/^#cite-([SM]\d+)-(\d+)$/) ?? [];
              const s = sources.get(id);
              const m = memory.get(id);
              if (s) return <SourceCitation source={s} claim={claims[Number(n)] ?? ""} />;
              if (m) {
                return (
                  <button type="button" onClick={() => m.conversationId && props.onOpenConversation(m.conversationId)}
                    title={m.kind === "profile" ? "Something you told me in an earlier chat" : m.kind === "claims" ? "Facts recorded in earlier answers" : `From our conversation "${m.conversationTitle}" on ${fmtDate(m.createdAt)}`}
                    className="mx-0.5 align-super font-mono text-[10px] text-muted underline decoration-dotted underline-offset-2 hover:text-ink">
                    {m.kind === "profile" ? "you told me" : m.kind === "claims" ? "recorded facts" : `memory ${fmtDate(m.createdAt)}`}
                  </button>
                );
              }
              return <span className="mx-0.5 align-super font-mono text-[10px] text-orange" title="Citation not found">[{id}?]</span>;
            }
            return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

export function SourceList({ text, sources, extra }: { text: string; sources: Map<string, Source>; extra: Source[] }) {
  const ids = citedIds(text, "S").filter((id) => sources.has(id));
  const cited = ids.map((id) => sources.get(id)!).sort((a, b) => parseInt(a.id.slice(1)) - parseInt(b.id.slice(1)));
  const others = extra.filter((s) => !ids.includes(s.id));
  if (!cited.length && !others.length) return null;
  return (
    <div className="mt-4 border-t border-line pt-3">
      {cited.length > 0 && (
        <ol className="space-y-1 text-xs">
          {cited.map((s) => (
            <li key={s.id} className="flex min-w-0 items-center gap-2">
              <span className="w-5 shrink-0 text-right font-mono text-[10px] text-faint">{s.id.slice(1)}</span>
              <TierBadge tier={s.tier} />
              <a href={s.url} target="_blank" rel="noreferrer" className="truncate text-ink hover:text-accent-ink">{s.title}</a>
              <span className="shrink-0 font-mono text-[10px] text-faint">{s.domain} · {fmtDate(s.publishedDate)}</span>
            </li>
          ))}
        </ol>
      )}
      {others.length > 0 && (
        <details className="mt-1.5 text-xs text-muted">
          <summary className="cursor-pointer select-none font-mono text-[10px]">+{others.length} more source{others.length > 1 ? "s" : ""} read, not cited</summary>
          <ul className="mt-1 space-y-0.5 pl-7">
            {others.map((s) => (
              <li key={s.id} className="truncate">
                <a href={s.url} target="_blank" rel="noreferrer" className="hover:underline">{s.title}</a> · {s.domain}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
