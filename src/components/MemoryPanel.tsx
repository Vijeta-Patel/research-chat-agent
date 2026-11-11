"use client";

import { useEffect, useState } from "react";
import { fmtDate } from "@/components/Answer";
import { Cat } from "@/components/Cats";

// The memory drawer: past chats, plus everything the agent has distilled from
// them — what it knows about you, what you decided, what is still open, and the
// facts it is tracking with their history. Every item can be forgotten.

export interface ConvSummary { id: string; title: string; updatedAt: string }
interface Remembered {
  profile: { key: string; value: string; updatedAt: string; earlier: { value: string; saidAt: string }[] }[];
  facts: { entity: string; attribute: string; history: { value: string; observedAt: string; sourceUrl: string | null }[] }[];
  threads: { conversationId: string; title: string; createdAt: string; decisions: string[]; open: string[] }[];
}

const Forget = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button onClick={onClick} aria-label={label} title={label}
    className="h-6 w-6 shrink-0 rounded-[6px] text-faint opacity-0 hover:text-orange focus:opacity-100 group-hover:opacity-100">×</button>
);

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (!count) return null;
  return (
    <details className="px-3 py-1.5" open>
      <summary className="cursor-pointer select-none font-mono text-[10px] text-faint hover:text-ink">{title} · {count}</summary>
      <ul className="mt-1 space-y-1 text-[13px] leading-snug">{children}</ul>
    </details>
  );
}

export function MemoryPanel(props: {
  conversations: ConvSummary[];
  currentId?: string;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}) {
  const [mem, setMem] = useState<Remembered | null>(null);
  const [version, setVersion] = useState(0); // bumped after forgetting something
  useEffect(() => {
    let live = true;
    fetch("/api/memory").then((x) => x.json()).then((r) => { if (live && r?.profile) setMem(r); }).catch(() => {});
    return () => { live = false; };
  }, [version, props.conversations]);
  const forget = async (body: Record<string, string>) => {
    await fetch("/api/memory", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setVersion((v) => v + 1);
  };
  const open = mem?.threads.filter((t) => t.open.length) ?? [];
  const decided = mem?.threads.filter((t) => t.decisions.length) ?? [];

  return (
    <div className="fixed inset-0 z-30 flex justify-end" onKeyDown={(e) => { if (e.key === "Escape") props.onClose(); }}>
      <button aria-label="Close memory" onClick={props.onClose} className="absolute inset-0 bg-black/10" />
      <aside aria-label="Memory" className="relative flex h-full w-[22rem] max-w-[92vw] flex-col bg-card shadow-[0_0_40px_rgba(0,0,0,0.12)]">
        <div className="flex items-end justify-between px-5 pb-2 pt-5">
          <div>
            <div className="display text-lg">what i remember</div>
            <div className="font-mono text-[10px] text-faint">stored in one file on this machine · × forgets</div>
          </div>
          <Cat sprite="cali-nap" scale={3} />
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {mem && (
            <>
              <Section title="about you" count={mem.profile.length}>
                {mem.profile.map((p) => (
                  <li key={p.key} className="group flex items-start gap-1">
                    <span className="min-w-0 flex-1">
                      <span className="text-muted">{p.key}:</span>{" "}
                      {p.earlier.map((h, i) => (
                        <span key={i}><span className="text-faint line-through">{h.value}</span> <span className="font-mono text-[10px] text-faint">{fmtDate(h.saidAt)}</span> → </span>
                      ))}
                      {p.value} <span className="font-mono text-[10px] text-faint">{fmtDate(p.updatedAt)}</span>
                    </span>
                    <Forget label={`Forget "${p.key}"`} onClick={() => forget({ kind: "profile", key: p.key })} />
                  </li>
                ))}
              </Section>
              <Section title="still open" count={open.length}>
                {open.map((t) => (
                  <li key={t.conversationId}>
                    <button onClick={() => props.onOpen(t.conversationId)} className="w-full text-left hover:text-accent-ink">
                      {t.open.join("; ")}
                      <span className="block font-mono text-[10px] text-faint">{t.title} · {fmtDate(t.createdAt)}</span>
                    </button>
                  </li>
                ))}
              </Section>
              <Section title="you decided" count={decided.length}>
                {decided.map((t) => (
                  <li key={t.conversationId}>
                    <button onClick={() => props.onOpen(t.conversationId)} className="w-full text-left hover:text-accent-ink">
                      {t.decisions.join("; ")}
                      <span className="block font-mono text-[10px] text-faint">{t.title} · {fmtDate(t.createdAt)}</span>
                    </button>
                  </li>
                ))}
              </Section>
              <Section title="facts i'm tracking" count={mem.facts.length}>
                {mem.facts.map((f) => (
                  <li key={`${f.entity}|${f.attribute}`} className="group flex items-start gap-1">
                    <span className="min-w-0 flex-1">
                      <span className="text-muted">{f.entity} · {f.attribute}:</span>{" "}
                      {f.history.map((h, i) => (
                        <span key={i} className={i < f.history.length - 1 ? "text-faint line-through" : ""}>
                          {i > 0 && <span className="no-underline"> → </span>}{h.value} <span className="font-mono text-[10px] text-faint">{fmtDate(h.observedAt)}</span>
                        </span>
                      ))}
                    </span>
                    <Forget label={`Forget ${f.entity} ${f.attribute}`} onClick={() => forget({ kind: "fact", entity: f.entity, attribute: f.attribute })} />
                  </li>
                ))}
              </Section>
            </>
          )}
          <div className="px-3 pb-1 pt-3 font-mono text-[10px] text-faint">past chats · {props.conversations.length}</div>
          <nav>
            {props.conversations.length === 0 && <p className="px-3 text-sm text-muted">nothing yet.</p>}
            {props.conversations.map((c) => (
              <div key={c.id} className={`group flex items-center rounded-[10px] ${c.id === props.currentId ? "bg-warm" : "hover:bg-paper"}`}>
                <button onClick={() => props.onOpen(c.id)} className="min-w-0 flex-1 px-3 py-2 text-left">
                  <div className="truncate text-sm">{c.title}</div>
                  <div className="font-mono text-[10px] text-faint">{fmtDate(c.updatedAt)}</div>
                </button>
                <button onClick={() => props.onRemove(c.id)} aria-label={`Forget "${c.title}"`} title="Forget this conversation and everything learned from it"
                  className="mr-1 h-9 w-9 rounded-[8px] text-faint opacity-0 hover:text-orange focus:opacity-100 group-hover:opacity-100">×</button>
              </div>
            ))}
          </nav>
        </div>
      </aside>
    </div>
  );
}
