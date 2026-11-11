"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, CheckResult, MemoryRecord, MemoryReport, Source, StoredMessage, TurnMeta } from "@/lib/types";
import { Answer, SourceList } from "@/components/Answer";
import { Cat, CatAvatar, CatLoader, PawDots, type Answerer, type Phase } from "@/components/Cats";
import { MemoryPanel, type ConvSummary } from "@/components/MemoryPanel";
import { SearchLog, pageOf, searchesFromSources, type SearchStep } from "@/components/SearchLog";
import { citedIds } from "@/lib/util";
interface UiMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  sources: Source[];
  memory: MemoryRecord[];
  memoryReport?: MemoryReport;
  searches: SearchStep[];
  checks: CheckResult | null;
  error?: string;
  notice?: string;
  pending?: boolean;
  ms?: number;
  turn?: TurnMeta;
}

const EXAMPLES = [
  "Compare HubSpot, Pipedrive and Salesforce pricing for a 20-person sales team",
  "What's the latest on Neon and Supabase Postgres pricing?",
  "What did I ask you last Tuesday?",
  "What happened in AI news this week?",
];

const fromStored = (m: StoredMessage): UiMessage => ({
  id: m.id, role: m.role, text: m.text, sources: m.sources, memory: m.memory, searches: searchesFromSources(m.sources), checks: m.checks,
  turn: m.turn, ms: m.turn?.totalMs,
});

export default function Chat() {
  const [conversations, setConversations] = useState<ConvSummary[]>([]);
  const [convId, setConvId] = useState<string | undefined>();
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const refreshConversations = useCallback(async () => {
    const r = await fetch("/api/conversations").then((x) => x.json()).catch(() => null);
    if (r?.conversations) setConversations(r.conversations);
  }, []);

  useEffect(() => { void refreshConversations(); }, [refreshConversations]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages]);

  // Conversation-wide maps so [S#] from earlier turns still resolve.
  const sourceMap = useMemo(() => {
    const m = new Map<string, Source>();
    for (const msg of messages) for (const s of msg.sources) m.set(s.id, s);
    return m;
  }, [messages]);

  const openConversation = useCallback(async (id: string) => {
    if (busy) return;
    const r = await fetch(`/api/conversations/${id}`).then((x) => x.json()).catch(() => null);
    if (!r?.messages) return;
    setConvId(id);
    setMessages((r.messages as StoredMessage[]).map(fromStored));
  }, [busy]);

  const newChat = () => { if (!busy) { setConvId(undefined); setMessages([]); } };

  const removeConversation = async (id: string) => {
    if (!confirm("Delete this conversation from memory? This can't be undone.")) return;
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    if (id === convId) newChat();
    void refreshConversations();
  };

  const patchLast = (fn: (m: UiMessage) => UiMessage) =>
    setMessages((ms) => ms.map((m, i) => (i === ms.length - 1 ? fn(m) : m)));

  const patchSearch = (id: string, fn: (s: SearchStep) => SearchStep) =>
    patchLast((m) => ({ ...m, searches: m.searches.map((s) => (s.id === id ? fn(s) : s)) }));

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    const user: UiMessage = { id: crypto.randomUUID(), role: "user", text: message, sources: [], memory: [], searches: [], checks: null };
    const asst: UiMessage = { id: crypto.randomUUID(), role: "assistant", text: "", sources: [], memory: [], searches: [], checks: null, pending: true };
    setMessages((ms) => [...ms, user, asst]);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          conversationId: convId,
          message,
          tzOffsetMinutes: new Date().getTimezoneOffset(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        patchLast((m) => ({ ...m, pending: false, error: err.error ?? `HTTP ${res.status}` }));
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, idx).replace(/^data: /, "");
          buf = buf.slice(idx + 2);
          if (line) handle(JSON.parse(line) as AgentEvent);
        }
      }
    } catch (err) {
      if (!ctrl.signal.aborted) patchLast((m) => ({ ...m, error: String(err) }));
    } finally {
      patchLast((m) => ({ ...m, pending: false }));
      setBusy(false);
      abortRef.current = null;
      void refreshConversations();
    }
  }

  function handle(e: AgentEvent) {
    switch (e.type) {
      case "conversation": setConvId(e.id); break;
      case "memory": patchLast((m) => ({ ...m, memoryReport: e.report, memory: e.report.records })); break;
      case "search_start":
        patchLast((m) => ({ ...m, searches: [...m.searches, { id: e.searchId, query: e.query, options: e.options, status: "running", pages: [] }] })); break;
      case "search_pages":
        patchSearch(e.searchId, (s) => ({ ...s, provider: e.provider, pages: e.pages })); break;
      case "search_page":
        patchSearch(e.searchId, (s) => ({ ...s, pages: s.pages.map((p) => (p.url === e.page.url ? e.page : p)) })); break;
      case "search_done":
        // The sources are the final word on each page (and what gets stored).
        patchSearch(e.searchId, (s) => ({ ...s, status: e.error ? "error" : "done", error: e.error, pages: e.error ? s.pages : e.sources.map(pageOf) }));
        patchLast((m) => {
          const byId = new Map(m.sources.map((s) => [s.id, s]));
          for (const s of e.sources) byId.set(s.id, s);
          return { ...m, sources: [...byId.values()] };
        });
        break;
      case "text": patchLast((m) => ({ ...m, text: m.text + e.delta })); break;
      case "checks": patchLast((m) => ({ ...m, checks: e.result })); break;
      case "revision": patchLast((m) => ({ ...m, text: e.text, checks: e.result, notice: [m.notice, e.note].filter(Boolean).join(" · ") })); break;
      case "done": patchLast((m) => ({ ...m, id: e.messageId, ms: e.ms, turn: e.turn, pending: false })); break;
      case "notice": patchLast((m) => ({ ...m, notice: [m.notice, e.message].filter(Boolean).join(" · ") })); break;
      case "error": patchLast((m) => ({ ...m, error: e.message })); break;
    }
  }

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-paper text-ink">
      <header className="flex items-center justify-between px-5 py-3">
        <button onClick={newChat} className="display text-lg tracking-tight" title="Start a new chat">research chat</button>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button onClick={newChat} disabled={busy} className="h-11 rounded-[10px] px-3 text-sm text-muted hover:text-ink disabled:opacity-40">new chat</button>
          )}
          <button onClick={() => setShowMemory((v) => !v)} aria-label="Memory" aria-expanded={showMemory}
            className="flex h-11 w-11 items-center justify-center rounded-[10px] hover:bg-warm">
            <Cat sprite="cali" scale={2} />
          </button>
        </div>
      </header>

      {showMemory && (
        <MemoryPanel conversations={conversations} currentId={convId}
          onOpen={(id) => { setShowMemory(false); void openConversation(id); }}
          onRemove={removeConversation} onClose={() => setShowMemory(false)} />
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[720px] px-5 pb-10 pt-6">
          {messages.length === 0 && (
            <div className="mt-[8vh] flex flex-col items-center text-center">
              <div className="flex items-end gap-6">
                <Cat sprite="tux" scale={6} alt="Tux, the tuxedo cat, who searches the web" />
                <Cat sprite="cali" scale={4} alt="Cali, the calico kitten, who remembers past chats" />
              </div>
              <h1 className="display mt-7 text-4xl leading-tight tracking-tight sm:text-5xl">ask me anything.</h1>
              <ul className="mt-10 flex w-full max-w-md flex-col gap-1 text-left">
                {EXAMPLES.map((ex) => (
                  <li key={ex}>
                    <button onClick={() => send(ex)} className="w-full rounded-[10px] px-3 py-2.5 text-left text-[15px] text-muted hover:bg-card hover:text-ink">
                      {ex}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {messages.map((m, i) =>
            m.role === "user" ? (
              <h2 key={m.id + i} className={`display whitespace-pre-wrap pl-16 text-[22px] leading-snug ${i === 0 ? "mt-2" : "mt-14"}`}>{m.text}</h2>
            ) : (
              <div key={m.id + i} className="mt-5">
                {m.pending && !m.text ? (
                  <div className="pl-16"><CatLoader {...loading(m)} /><MemoryLine report={m.memoryReport} /><SearchLog searches={m.searches} live /></div>
                ) : (
                  <div className="flex items-start gap-5">
                    <div className="shrink-0 pt-1"><CatAvatar who={answerer(m)} /></div>
                    <div className="min-w-0 flex-1">
                      {m.text && (
                        <Answer text={m.text} sources={sourceMap} memory={new Map(m.memory.map((r) => [r.id, r]))} onOpenConversation={openConversation} />
                      )}
                      {m.pending && m.text && <PawDots />}
                      {!m.pending && m.text && <SourceList text={m.text} sources={sourceMap} extra={m.sources} />}
                      <MemoryLine report={m.memoryReport} />
                      <SearchLog searches={m.searches} live={false} />
                      {!m.pending && m.checks && <Checks c={m.checks} />}
                      {m.notice && <div className="mt-2 font-mono text-[10px] text-faint">{m.notice}</div>}
                      {!m.pending && m.turn && <HowIGotThis turn={m.turn} memory={m.memory} />}
                    </div>
                  </div>
                )}
                {m.error && <div className="ml-16 mt-2 rounded-[10px] bg-orange-soft px-3 py-2 text-sm text-ink">{m.error}</div>}
              </div>
            ),
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <form onSubmit={(e) => { e.preventDefault(); void send(input); }} className="px-5 pb-5 pt-2">
        <div className="mx-auto flex max-w-[720px] items-end gap-2 rounded-[14px] bg-card p-1.5 pl-4">
          <label htmlFor="ask" className="sr-only">Ask a question</label>
          <textarea
            id="ask"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); } }}
            rows={1}
            placeholder="ask…"
            className="max-h-40 min-h-[44px] flex-1 resize-none bg-transparent py-2.5 text-base outline-none placeholder:text-faint"
          />
          {busy ? (
            <button type="button" onClick={() => abortRef.current?.abort()} aria-label="Stop"
              className="flex h-11 w-11 items-center justify-center rounded-[10px] bg-paper text-ink">
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="2" y="2" width="10" height="10" rx="2" fill="currentColor" /></svg>
            </button>
          ) : (
            <button type="submit" disabled={!input.trim()} aria-label="Send"
              className="flex h-11 w-11 items-center justify-center rounded-[10px] bg-accent text-white transition hover:brightness-110 disabled:opacity-35">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5" /><path d="M5 12l7-7 7 7" /></svg>
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

// Which cat signs the answer: web search → Tux, memory → Cali, both → both.
function answerer(m: UiMessage): Answerer {
  const memoryIds = new Set(m.memory.map((r) => r.id));
  const citedMemory = citedIds(m.text, "M").some((id) => memoryIds.has(id));
  const usedWeb = m.sources.length > 0 || m.searches.length > 0;
  if (citedMemory && usedWeb) return "both";
  if (citedMemory) return "cali";
  return "tux";
}

// Which loading animation to show, from the events received so far.
function loading(m: UiMessage): { phase: Phase; label: string } {
  if (!m.memoryReport) return { phase: "remembering", label: "cali is checking memory…" };
  const running = m.searches.filter((s) => s.status === "running");
  if (running.length) return { phase: "searching", label: `tux is searching · ${running[running.length - 1].query}` };
  if (m.searches.length) {
    const n = m.searches.reduce((a, s) => a + s.pages.length, 0);
    return { phase: "reading", label: `tux is reading ${n} page${n === 1 ? "" : "s"}` };
  }
  return { phase: "writing", label: "thinking…" };
}

// Memory is looked through before every answer; this line says what came back.
function MemoryLine({ report }: { report?: MemoryReport }) {
  if (!report || !report.totalConversations) return null;
  const n = report.totalConversations;
  return (
    <div className="mt-3 font-mono text-[11px] text-faint">
      ◆ memory checked first · {n} earlier chat{n === 1 ? "" : "s"} · {report.note || "nothing relevant"}
    </div>
  );
}

function Checks({ c }: { c: CheckResult }) {
  const items: string[] = [];
  if (c.unsupportedNumbers.length) items.push(`${c.unsupportedNumbers.length} figure(s) not found in the cited source text: ${c.unsupportedNumbers.map((n) => `${n.value} (${n.cited.join(",")})`).join("; ")}`);
  if (c.uncitedSentences.length) items.push(`${c.uncitedSentences.length} sentence(s) with figures but no citation`);
  if (c.unknownCitations.length) items.push(`Citations that don't match a source: ${c.unknownCitations.join(", ")}`);
  if (!items.length) return null;
  return (
    <details className="mt-3 rounded-[9px] bg-orange-soft px-3 py-2 text-xs text-ink">
      <summary className="cursor-pointer select-none font-mono text-[11px]">auto-check · verify {items.length === 1 ? "one point" : `${items.length} points`} before relying on this</summary>
      <ul className="mt-1 list-disc pl-5">{items.map((t) => <li key={t}>{t}</li>)}</ul>
      {c.uncitedSentences.length > 0 && <ul className="mt-1 list-disc pl-5 text-muted">{c.uncitedSentences.slice(0, 3).map((s) => <li key={s}>&ldquo;{s}&rdquo;</li>)}</ul>}
    </details>
  );
}

// "How I got this": the turn ledger for one answer — what the harness did, in
// order, with timings. Makes the architecture visible while you chat.
function HowIGotThis({ turn, memory }: { turn: TurnMeta; memory: MemoryRecord[] }) {
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const kinds = memory.reduce<Record<string, number>>((a, r) => ({ ...a, [r.kind]: (a[r.kind] ?? 0) + 1 }), {});
  const icon: Record<string, string> = { memory: "◆", model: "●", search: "⌕", guard: "▲", repair: "↺" };
  return (
    <details className="group mt-3 text-[11px]">
      <summary className="cursor-pointer select-none font-mono text-faint hover:text-ink">
        how i got this · {sec(turn.totalMs)}{turn.firstTokenMs != null ? ` · first word ${sec(turn.firstTokenMs)}` : ""} · {turn.searches} search{turn.searches === 1 ? "" : "es"}
      </summary>
      <div className="mt-2 space-y-2 rounded-[10px] bg-card px-3 py-2.5 font-mono text-[10.5px] leading-relaxed text-muted">
        <div><span className="text-ink">{turn.model}</span> via {turn.provider}{turn.revised ? " · answer revised after checks" : ""}</div>
        {memory.length > 0 && (
          <div>memory used: {Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(" · ")}</div>
        )}
        <ol className="space-y-0.5">
          {turn.trace.map((t, i) => (
            <li key={i} className="flex gap-2">
              <span className="w-3 shrink-0 text-faint">{icon[t.step] ?? "·"}</span>
              <span className="min-w-0 flex-1 break-words"><span className="text-ink">{t.step}</span> {t.detail}</span>
              <span className="shrink-0 text-faint">{t.ms ? sec(t.ms) : ""}</span>
            </li>
          ))}
        </ol>
        {turn.notices.length > 0 && <div className="text-faint">{turn.notices.join(" · ")}</div>}
      </div>
    </details>
  );
}
