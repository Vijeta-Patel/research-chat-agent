import { config } from "@/lib/config";
import { buildTurnPreamble } from "@/lib/agent/prompt";
import { maskSecrets } from "@/lib/agent/guardrails";
import { verifyAnswer } from "@/lib/agent/verify";
import { describeError, generate } from "@/lib/llm/claude";
import { addMessage, conversationExists, createConversation, getConversationMemory, getMessages, now, saveTurn } from "@/lib/memory/db";
import { catchUp, distillTurn, track } from "@/lib/memory/distill";
import { retrieveMemory, type UserClock } from "@/lib/memory/retrieve";
import { createSearchTool } from "@/lib/search/tool";
import type { AgentEvent, TraceStep, TurnMeta } from "@/lib/types";
import { citedIds, errorMessage, fmtLong, safeTimeZone } from "@/lib/util";

// One user turn, end to end. This file is the agent's spine; each step lives in
// its own module:
//
//   mask secrets            agent/guardrails.ts
//   → recall memory         memory/retrieve.ts   (deterministic, before the model)
//   → model ⇄ web_search    llm/claude.ts + search/tool.ts (guarded, streamed)
//   → verify the draft      agent/verify.ts      (freshness, URL guard, citation repair)
//   → persist + ledger      memory/db.ts
//   → distil into memory    memory/distill.ts    (background)

export interface TurnInput {
  conversationId?: string;
  message: string;
  clock: UserClock;
  emit: (e: AgentEvent) => void;
  signal?: AbortSignal;
}

export async function runTurn({ conversationId, message: rawMessage, clock, emit, signal }: TurnInput): Promise<void> {
  const started = Date.now();
  const tz = safeTimeZone(clock.timeZone);
  const steps: TraceStep[] = []; // where the time went + which guardrails fired
  const trace = (step: TraceStep) => { steps.push(step); };

  // Guardrail #5: secrets pasted into chat are masked before they are stored,
  // searched for, or sent to the model.
  const { text: message, masked } = maskSecrets(rawMessage);
  if (masked.length) {
    emit({
      type: "notice",
      message: `I masked what looked like ${masked.map((k) => (/^[aeiou]/.test(k) ? `an ${k}` : `a ${k}`)).join(" and ")} in your message; it was not stored or sent anywhere. Please rotate it if it's real.`,
    });
    trace({ step: "guard", detail: `masked ${masked.join(", ")} in user message`, ms: 0 });
  }

  // 1. Conversation + persist the user message first (so it survives errors).
  const convId = conversationId && conversationExists(conversationId)
    ? conversationId
    : createConversation(message.replace(/\s+/g, " ").trim().slice(0, 60) || "New chat");
  const prior = getMessages(convId);
  if (!prior.length) emit({ type: "conversation", id: convId, title: message.slice(0, 60) });
  addMessage({ conversationId: convId, role: "user", text: message });

  // 2. Memory (deterministic, before the model runs).
  const tm = Date.now();
  const { report, promptBlock } = await retrieveMemory(message, clock, {
    currentConversationId: convId,
    currentMessageCount: prior.length,
    historyWindow: config.historyWindow,
  });
  const rv = report.retrievers;
  trace({
    step: "memory",
    detail: `looked through ${report.totalConversations} earlier chat(s) before answering → ${report.note || "nothing relevant"} · ${report.records.length} record(s)${rv ? ` [dates ${rv.dates} · keywords ${rv.keywords} · topics ${rv.topics} · facts ${rv.facts}]` : ""}`,
    ms: Date.now() - tm,
  });
  emit({ type: "memory", report });

  // 3. The one tool, and what the model is told this turn.
  const nowLabel = fmtLong(now(), tz);
  const search = createSearchTool({ history: prior, startedAt: started, nowLabel, emit, trace, signal });
  const base = {
    history: prior,
    userText: `${buildTurnPreamble({ nowLabel, timeZone: tz, memoryBlock: promptBlock })}\n${message}`,
  };

  // 4. The model ⇄ web_search loop, streamed to the user.
  let firstTokenMs: number | null = null;
  let modelUsed = config.claudeModel;
  let streamed = "";
  const say = (delta: string) => {
    if (firstTokenMs === null) firstTokenMs = Date.now() - started;
    streamed += delta;
    emit({ type: "text", delta });
  };
  try {
    const r = await generate({ ...base, allowTools: true }, { onText: say, search: search.run, trace, signal });
    modelUsed = r.model;
    // Guardrail #3: the model declined or was cut off — say so in plain words.
    if (r.blocked) {
      trace({ step: "guard", detail: "model declined the request", ms: 0 });
      say((streamed.trim() ? "\n\n" : "") + r.blocked);
    }
  } catch (err) {
    if (signal?.aborted) return;
    const msg = describeError(err);
    emit({ type: "error", message: msg });
    if (!streamed.trim()) return;
    say(`\n\n_(Answer interrupted: ${msg})_`);
  }
  if (!streamed.trim()) say("I couldn't produce an answer this time. Please try again or rephrase.");

  // 5. Verify the draft; if a check changed it, replace what was streamed.
  const verified = await verifyAnswer({
    draft: streamed.replace(/^\s+/, ""),
    base, userMessage: message, memory: report.records, memoryBlock: promptBlock, aboutOurPast: report.aboutOurPast, search, startedAt: started, trace, signal,
    onChecks: (result) => emit({ type: "checks", result }),
  });
  const finalText = verified.text.trim();
  const revised = finalText !== streamed.trim();
  if (revised) emit({ type: "revision", text: finalText, result: verified.checks, note: verified.notes.join(" ") });

  // 6. Persist the answer and the turn ledger: how it was produced.
  const messageId = addMessage({
    conversationId: convId, role: "assistant", text: finalText,
    sources: search.turnSources, memory: report.records, checks: verified.checks,
  });
  const totalMs = Date.now() - started;
  const turn: TurnMeta = {
    provider: "claude",
    model: modelUsed,
    totalMs,
    firstTokenMs,
    searches: search.searchesUsed(),
    revised,
    notices: verified.notes,
    trace: steps,
  };
  const ledger = { messageId, conversationId: convId, timeZone: tz, ...turn };
  saveTurn(ledger);
  console.log(`[trace] ${totalMs}ms total | ` + steps.map((t) => `${t.step}:${t.detail} ${t.ms}ms${t.firstMs !== undefined ? ` (first ${t.firstMs}ms)` : ""}`).join(" | "));
  emit({ type: "done", messageId, ms: totalMs, trace: steps, turn });

  // 7. Memory WRITE path, in the background (never delays the answer):
  //    distil summary + topics + claims + profile; record the outcome in the ledger.
  const cited = new Set(citedIds(finalText, "S"));
  track(
    distillTurn({
      conversationId: convId,
      messageId,
      at: now(),
      userText: message,
      answerText: finalText,
      citedSources: [...search.sources.values()].filter((s) => cited.has(s.id)),
      recallOnly: report.aboutOurPast && search.searchesUsed() === 0,
      // Recalled chats with unfinished business: this turn may settle some of it.
      related: [...new Set(report.records.filter((r) => r.kind === "summary").map((r) => r.conversationId))]
        .map((id) => getConversationMemory(id))
        .filter((m) => !!m && m.open.length > 0)
        .map((m) => ({ conversationId: m!.conversationId, title: m!.title, createdAt: m!.createdAt, open: m!.open })),
    })
      .then((d) => trace({ step: "memory", detail: `distilled: summary ${d.summary ? "updated" : "unchanged"} · ${d.claims} new claim(s) · ${d.profile} profile fact(s)${d.resolved ? ` · closed ${d.resolved} open item(s) in earlier chats` : ""}`, ms: d.ms }))
      .catch((err) => trace({ step: "memory", detail: `distillation failed: ${errorMessage(err, 100)}`, ms: 0 }))
      .finally(() => saveTurn(ledger))
      // Then repair any earlier turn whose memory was never written.
      .then(() => catchUp(convId))
      .then((n) => { if (n) console.log(`[memory] caught up ${n} missed exchange(s)`); }),
  );
}
