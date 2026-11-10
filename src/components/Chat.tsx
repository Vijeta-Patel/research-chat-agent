"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, CheckResult, MemoryRecord, MemoryReport, Source, StoredMessage } from "@/lib/types";
import { Answer, SourceList, fmtDate } from "@/components/Answer";

interface SearchStep { query: string; status: "running" | "done" | "error"; count: number; error?: string }
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
}
interface ConvSummary { id: string; title: string; updatedAt: string }

const EXAMPLES = [
  "Compare HubSpot, Pipedrive and Salesforce pricing for a 20-person sales team",
  "What's the latest on Neon and Supabase Postgres pricing?",
  "What did I ask you last Tuesday?",
  "What happened in AI news this week?",
];

const fromStored = (m: StoredMessage): UiMessage => ({
  id: m.id, role: m.role, text: m.text, sources: m.sources, memory: m.memory, searches: [], checks: m.checks,
});

export default function Chat() {
  const [conversations, setConversations] = useState<ConvSummary[]>([]);
  const [convId, setConvId] = useState<string | undefined>();
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
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
        patchLast((m) => ({ ...m, searches: [...m.searches, { query: e.query, status: "running", count: 0 }] })); break;
      case "search_done":
        patchLast((m) => {
          const i = m.searches.findIndex((s) => s.query === e.query && s.status === "running");
          const searches = [...m.searches];
          if (i >= 0) searches[i] = { query: e.query, status: e.error ? "error" : "done", count: e.sources.length, error: e.error };
          const byId = new Map(m.sources.map((s) => [s.id, s]));
          for (const s of e.sources) byId.set(s.id, s);
          return { ...m, searches, sources: [...byId.values()] };
        });
        break;
      case "text": patchLast((m) => ({ ...m, text: m.text + e.delta })); break;
      case "checks": patchLast((m) => ({ ...m, checks: e.result })); break;
      case "revision": patchLast((m) => ({ ...m, text: e.text, checks: e.result, notice: [m.notice, e.note].filter(Boolean).join(" · ") })); break;
      case "done": patchLast((m) => ({ ...m, id: e.messageId, ms: e.ms, pending: false })); break;
      case "notice": patchLast((m) => ({ ...m, notice: [m.notice, e.message].filter(Boolean).join(" · ") })); break;
      case "error": patchLast((m) => ({ ...m, error: e.message })); break;
    }
  }

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-paper text-ink">
      {/* Sidebar: memory */}
      <aside className="hidden w-64 shrink-0 flex-col bg-night text-night-ink [color-scheme:dark] md:flex">
        <div className="px-4 pb-3 pt-5">
          <div className="pixel text-xl tracking-tight">research chat</div>
          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-night-muted">search · remember · cite</div>
        </div>
        <div className="px-3">
          <button onClick={newChat} className="w-full rounded-[9px] bg-accent px-3 py-2 text-sm font-medium text-white transition hover:brightness-110">
            new chat
          </button>
        </div>
        <div className="mt-5 px-4 pb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-night-muted">memory · past chats</div>
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {conversations.length === 0 && <p className="px-2 text-xs text-night-muted">nothing yet — I&rsquo;ll remember what we talk about.</p>}
          {conversations.map((c) => (
            <div key={c.id} className={`group flex items-center rounded-[9px] ${c.id === convId ? "bg-white/12" : "hover:bg-white/6"}`}>
              <button onClick={() => openConversation(c.id)} className="min-w-0 flex-1 px-2.5 py-1.5 text-left">
                <div className="truncate text-[13px]">{c.title}</div>
                <div className="font-mono text-[10px] text-night-muted">{fmtDate(c.updatedAt)}</div>
              </button>
              <button onClick={() => removeConversation(c.id)} title="Forget this conversation"
                className="mr-1 hidden rounded px-1.5 text-night-muted hover:text-orange group-hover:block">×</button>
            </div>
          ))}
        </nav>
      </aside>

      {/* Main */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between px-4 py-3 md:hidden">
          <div className="pixel text-lg">research chat</div>
          <button onClick={newChat} className="rounded-[9px] bg-accent px-3 py-1.5 text-xs font-medium text-white">new chat</button>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 py-8">
            {messages.length === 0 && (
              <div className="mt-14 text-center">
                <div className="mx-auto mb-5 inline-block rounded-full bg-card px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
                  web search · memory · citations
                </div>
                <h1 className="pixel text-4xl leading-tight tracking-tight sm:text-5xl">ask me anything.</h1>
                <p className="mx-auto mt-3 max-w-md text-[15px] text-muted">
                  I search the web, cite every claim, and remember our past chats — so you can ask
                  &ldquo;what did I ask you last tuesday, is it still true?&rdquo;
                </p>
                <div className="mt-10 grid gap-2 text-left sm:grid-cols-2">
                  {EXAMPLES.map((ex, i) => (
                    <button key={ex} onClick={() => send(ex)}
                      className="group rounded-xl bg-card p-4 text-left text-sm transition hover:-translate-y-0.5 hover:shadow-[0_6px_24px_rgba(0,0,0,0.06)]">
                      <span className="mb-1 block font-mono text-[10px] text-faint">0{i + 1}</span>
                      {ex}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={m.id + i} className="my-5 flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-xl rounded-br-[4px] bg-ink px-4 py-2.5 text-[15px] font-normal text-paper">{m.text}</div>
                </div>
              ) : (
                <div key={m.id + i} className="my-5 rounded-xl bg-card px-5 py-4">
                  <Activity m={m} />
                  {m.text && (
                    <Answer text={m.text} sources={sourceMap} memory={new Map(m.memory.map((r) => [r.id, r]))} onOpenConversation={openConversation} />
                  )}
                  {m.pending && !m.text && (
                    <div className="flex items-center gap-2 font-mono text-xs text-muted">
                      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
                      {phase(m)}
                    </div>
                  )}
                  {m.error && <div className="mt-2 rounded-[9px] bg-orange-soft px-3 py-2 text-sm text-ink">{m.error}</div>}
                  {!m.pending && m.text && <SourceList text={m.text} sources={sourceMap} extra={m.sources} />}
                  {!m.pending && m.checks && <Checks c={m.checks} />}
                  {(m.notice || m.ms !== undefined) && (
                    <div className="mt-2 flex flex-wrap gap-x-3 font-mono text-[10px] text-faint">
                      {m.notice && <span>ℹ {m.notice}</span>}
                      {m.ms !== undefined && <span>{(m.ms / 1000).toFixed(1)}s</span>}
                    </div>
                  )}
                </div>
              ),
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        <form onSubmit={(e) => { e.preventDefault(); void send(input); }} className="px-4 pb-4 pt-2">
          <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl bg-card p-2 shadow-[0_2px_16px_rgba(0,0,0,0.05)]">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); } }}
              rows={1}
              placeholder="ask anything…"
              className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-[15px] outline-none placeholder:text-faint"
            />
            {busy ? (
              <button type="button" onClick={() => abortRef.current?.abort()} className="h-10 rounded-[9px] bg-paper px-4 text-sm text-ink">stop</button>
            ) : (
              <button type="submit" disabled={!input.trim()} className="h-10 rounded-[9px] bg-accent px-4 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-35">send</button>
            )}
          </div>
          <div className="mx-auto mt-1.5 max-w-3xl text-center font-mono text-[10px] text-faint">answers cite their sources · check anything important</div>
        </form>
      </main>
    </div>
  );
}

// What the agent is doing right now, derived from the events received so far.
function phase(m: UiMessage): string {
  if (!m.memoryReport) return "Checking memory…";
  const running = m.searches.filter((s) => s.status === "running").length;
  if (running) return `Searching the web (${running} quer${running === 1 ? "y" : "ies"})…`;
  if (m.searches.length) {
    const n = m.searches.reduce((a, s) => a + s.count, 0);
    return `Reading ${n} result${n === 1 ? "" : "s"} and writing the answer…`;
  }
  return "Thinking…";
}

function Activity({ m }: { m: UiMessage }) {
  const note = m.memoryReport?.note;
  if (!note && !m.searches.length) return null;
  return (
    <div className="mb-3 flex flex-wrap gap-1.5 font-mono text-[11px]">
      {note && (
        <span className="rounded-full bg-warm px-2.5 py-0.5 text-ink" title={m.memoryReport?.searchedTerms.length ? `Keywords searched: ${m.memoryReport.searchedTerms.join(", ")}` : undefined}>
          memory · {note}
        </span>
      )}
      {m.searches.map((s, i) => (
        <span key={i} title={s.error} className={`rounded-full px-2.5 py-0.5 ${s.status === "error" ? "bg-orange-soft text-ink" : "bg-accent-soft text-accent-ink"}`}>
          {s.status === "running" ? "searching" : s.status === "error" ? "failed" : "searched"} · {s.query}{s.status === "done" ? ` · ${s.count}` : ""}
        </span>
      ))}
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
