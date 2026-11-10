"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MemoryRecord, Source } from "@/lib/types";

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

// Turn "[S3]" / "[S3, S5]" / "[M2]" into links the renderer can style as superscript numbers.
function linkCitations(text: string): string {
  return text.replace(/\[((?:[SM]\d+)(?:\s*,\s*[SM]\d+)*)\]/g, (_m, ids: string) =>
    ids.split(/\s*,\s*/).map((id) => `[${id}](#cite-${id})`).join(""),
  );
}

export function Answer(props: {
  text: string;
  sources: Map<string, Source>;
  memory: Map<string, MemoryRecord>;
  onOpenConversation: (id: string) => void;
}) {
  const { sources, memory } = props;
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            if (href?.startsWith("#cite-")) {
              const id = href.slice(6);
              const s = sources.get(id);
              const m = memory.get(id);
              if (s) {
                return (
                  <span className="group relative inline-block align-super">
                    <a href={s.url} target="_blank" rel="noreferrer"
                      className="mx-0.5 font-mono text-[11px] font-medium text-accent-ink no-underline hover:underline">
                      {id.slice(1)}
                    </a>
                    <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 hidden w-80 -translate-x-1/2 rounded-xl bg-night p-3 text-xs font-light leading-snug text-night-ink shadow-[0_8px_30px_rgba(0,0,0,0.25)] group-hover:block">
                      <span className="mb-1 flex items-center gap-2"><TierBadge tier={s.tier} /><span className="truncate font-mono text-[10px] text-night-muted">{s.domain} · {fmtDate(s.publishedDate)}</span></span>
                      <span className="block font-medium">{s.title}</span>
                      <span className="mt-1 line-clamp-4 block text-night-muted">{s.excerpt.slice(0, 280)}</span>
                    </span>
                  </span>
                );
              }
              if (m) {
                return (
                  <button type="button" onClick={() => props.onOpenConversation(m.conversationId)}
                    title={`From our conversation "${m.conversationTitle}" on ${fmtDate(m.createdAt)}`}
                    className="mx-0.5 align-super font-mono text-[10px] text-muted underline decoration-dotted underline-offset-2 hover:text-ink">
                    memory {fmtDate(m.createdAt)}
                  </button>
                );
              }
              return <span className="mx-0.5 align-super font-mono text-[10px] text-orange" title="Citation not found">[{id}?]</span>;
            }
            return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
          },
        }}
      >
        {linkCitations(props.text)}
      </ReactMarkdown>
    </div>
  );
}

export function SourceList({ text, sources, extra }: { text: string; sources: Map<string, Source>; extra: Source[] }) {
  const citedIds = [...new Set(text.match(/S\d+/g) ?? [])].filter((id) => sources.has(id));
  const cited = citedIds.map((id) => sources.get(id)!).sort((a, b) => parseInt(a.id.slice(1)) - parseInt(b.id.slice(1)));
  const others = extra.filter((s) => !citedIds.includes(s.id));
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
