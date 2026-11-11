import { config } from "@/lib/config";
import {
  claimKey, claimsForConversations, getConversationMemory, getProfile, historyStats, messagesBetween,
  recentConversations, searchClaimHistory, searchConversationMemory, searchMessages, withNeighbours,
  type Claim, type ConversationMemory, type MessageHit,
} from "@/lib/memory/db";
import { readQuestion, spellings, type UserClock } from "@/lib/memory/query";
import type { MemoryRecord, MemoryReport } from "@/lib/types";
import { fmtDateTime, fmtDay, safeTimeZone } from "@/lib/util";

export type { UserClock } from "@/lib/memory/query";

// The memory READ path. Runs in the harness BEFORE the model is called, so the
// model keeps exactly one tool (web_search) and we save a round-trip. No model
// call here: SQL + full-text search, identical on every run, a few milliseconds.
//
// Two things go into the <memory> block, inside one fixed budget:
//
//   ALWAYS IN VIEW   the user's profile, and a timeline of the most recent
//                    conversations (summary, what was decided, what was left
//                    open). This is what makes "that database thing", "which
//                    one did we pick?" or "my last three chats" work with no
//                    keyword to search for: the model does the matching.
//
//   RECALLED         four retrievers, fused by rank, reach the whole history:
//                      dates     exact SQL range (only if the message is about our past)
//                      keywords  BM25 over raw transcripts
//                      topics    BM25 over distilled summaries, topics and aliases
//                      facts     BM25 over the facts ledger, incl. money ("is it still $25?")
//                    The best conversations bring their recorded facts (with
//                    value history), their summary, and the exact messages.

export interface RetrieveOptions {
  currentConversationId?: string;
  currentMessageCount: number; // messages already in this conversation (for the long-chat summary)
  historyWindow: number; // how many of them are replayed verbatim
}

const RRF_K = 60;
const DATE_BUDGET = 6_000; // exact date hits may not crowd out everything else

// Old answers carry [S#] markers that point at *that* conversation's sources;
// strip them so the model cites the memory record [M#] instead.
const clip = (s: string, n: number) => {
  const t = s.replace(/\s?\[(S\d+)(,\s*S\d+)*\]/g, "");
  return t.length > n ? t.slice(0, n) + " …[truncated]" : t;
};
const uniq = <T,>(xs: T[]) => [...new Set(xs)];

/** What one conversation is remembered as. Falls back to the raw log until it has been distilled. */
function conversationText(c: ConversationMemory & { firstMessage?: string }): string {
  return [
    c.summary || (c.firstMessage ? `(not summarised yet) It began with the user asking: "${c.firstMessage.slice(0, 240)}"` : "(empty)"),
    c.topics.length && `Topics: ${c.topics.join(", ")}`,
    c.decisions.length && `Decided: ${c.decisions.join("; ")}`,
    c.open.length && `Left open: ${c.open.join("; ")}`,
  ].filter(Boolean).join("\n");
}

export async function retrieveMemory(
  message: string,
  clock: UserClock,
  opts: RetrieveOptions,
): Promise<{ report: MemoryReport; promptBlock: string }> {
  const tz = safeTimeZone(clock.timeZone);
  const current = opts.currentConversationId;
  const q = readQuestion(message, clock);
  // Dates select memory only when the message is about our past conversations:
  // "what did I ask on 3 Nov" → memory; "what did Supabase ship last month" → a search filter.
  const dateRefs = q.aboutOurPast ? q.dates : [];
  const stats = historyStats(current);
  const quoted = (ws: string[]) => ws.flatMap(spellings).map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
  const fts = quoted(q.terms);

  // ── Retrievers (all of them, on every message) ──────────────────────────
  // A message alone loses its context: "BIODERMA ATODERM" was the reply to "which
  // cream?" after "a barrier cream for two years". So each keyword hit brings its
  // neighbours (2 before, 1 after) from the same conversation.
  const kwHits = withNeighbours(searchMessages(fts, current, 8));
  const topicConvs = searchConversationMemory(fts, current, 8);
  const factHits = searchClaimHistory(quoted([...q.terms, ...q.figures])).filter((c) => c.conversationId !== current);
  // Dates. "Last Tuesday I asked about Postgres hosting" names a day AND a topic:
  // if any chat in the date range is about that topic, the rest of that day's
  // chats are noise (measured: one busy day put 12 unrelated chats in the block).
  const topical = new Set([...kwHits.map((h) => h.conversationId), ...topicConvs, ...factHits.map((c) => c.conversationId)]);
  const inRange = dateRefs.map((d) => ({ ...d, hits: messagesBetween(d.from, d.to, current) }));
  const onTopic = inRange.some((d) => d.hits.some((h) => topical.has(h.conversationId)));
  const perDate = inRange.map((d) => ({ ...d, all: d.hits.length, hits: onTopic ? d.hits.filter((h) => topical.has(h.conversationId)) : d.hits }));
  const dateHits = perDate.flatMap((d) => d.hits);

  // ── Reciprocal rank fusion over conversations ───────────────────────────
  const lists: { ids: string[]; weight: number }[] = [
    { ids: uniq(dateHits.map((h) => h.conversationId)), weight: 3 }, // exact → strongest
    { ids: uniq(kwHits.map((h) => h.conversationId)), weight: 1 },
    { ids: topicConvs, weight: 1 },
    { ids: uniq(factHits.map((c) => c.conversationId)), weight: 1 },
  ];
  const fused = new Map<string, number>();
  for (const l of lists) l.ids.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + l.weight / (RRF_K + rank + 1)));
  // Up to three conversations, but only ones that come close to the best: a chat
  // that matched one stray word doesn't ride along with a strong match.
  const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]);
  const selected = ranked.filter(([, score]) => score >= 0.6 * ranked[0][1]).slice(0, 3).map(([id]) => id);

  // ── Assemble records into a fixed budget, most reliable first ───────────
  const records: MemoryRecord[] = [];
  let used = 0;
  const push = (r: Omit<MemoryRecord, "id">, max: number, budget = config.memoryBudgetChars) => {
    const text = clip(r.text, max);
    if (used + text.length > budget) return false;
    used += text.length;
    records.push({ ...r, id: `M${records.length + 1}`, text });
    return true;
  };
  const pushMessage = (h: MessageHit, budget?: number) =>
    push({ kind: "message", conversationId: h.conversationId, conversationTitle: h.conversationTitle, createdAt: h.createdAt, role: h.role, text: h.text },
      h.role === "user" ? 500 : 900, budget);

  // 1. Profile: always — cross-session context that doesn't depend on keywords.
  //    Every fact, most recent first, with the value it replaced; if the profile
  //    ever outgrows its share, the oldest facts are named as left out, never cut silently.
  const profile = getProfile();
  if (profile.length) {
    const PROFILE_BUDGET = 2_000;
    const lines: string[] = [];
    let size = 0;
    for (const p of profile) {
      const prev = p.earlier.at(-1);
      const line = `- ${p.key}: ${p.value}${prev ? ` (earlier: ${prev.value}, until ${fmtDay(p.updatedAt, tz)})` : ""}`;
      if (size + line.length > PROFILE_BUDGET) { lines.push(`- (${profile.length - lines.length} older profile fact(s) not shown)`); break; }
      lines.push(line);
      size += line.length + 1;
    }
    push({ kind: "profile", conversationId: "", conversationTitle: "profile", createdAt: profile[0].updatedAt, text: lines.join("\n") }, PROFILE_BUDGET + 100);
  }
  // 2. Long chat: what scrolled out of the verbatim window of THIS conversation.
  if (current && opts.currentMessageCount > opts.historyWindow) {
    const cm = getConversationMemory(current);
    if (cm) push({ kind: "summary", conversationId: current, conversationTitle: `${cm.title} (earlier in this conversation)`,
      createdAt: cm.updatedAt, text: conversationText(cm) }, 900);
  }
  // 3. Exact date hits: raw wording, the ground truth for "what did I ask on…".
  const seenMsg = new Set<string>();
  for (const h of dateHits) {
    if (seenMsg.has(h.id)) continue;
    seenMsg.add(h.id);
    if (!pushMessage(h, DATE_BUDGET)) break;
  }
  // 4. Facts (versioned): everything recorded in the two best conversations, plus
  //    the full history of any fact the question names.
  const facts = new Map<string, Claim>();
  for (const c of [...claimsForConversations(selected.slice(0, 2)), ...factHits]) facts.set(c.id, c);
  if (facts.size) {
    const groups = new Map<string, Claim[]>();
    for (const c of facts.values()) {
      const k = `${claimKey(c.entity)}|${claimKey(c.attribute)}`;
      groups.set(k, [...(groups.get(k) ?? []), c]);
    }
    const lines = [...groups.values()].slice(0, 20).map((vs) => {
      vs.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
      const history = vs.map((v) => `${v.value} (observed ${fmtDay(v.observedAt, tz)}${v.sourceTitle ? `, source: ${v.sourceTitle}` : ""})`);
      return `- ${vs[0].entity} · ${vs[0].attribute}: ${history.join(" → ")}`;
    });
    const first = [...facts.values()][0];
    push({ kind: "claims", conversationId: first.conversationId, conversationTitle: "recorded facts", createdAt: first.observedAt, text: lines.join("\n") }, 2500);
  }
  // 5. Conversations: the ones recall selected, the ones nearest a date that had
  //    nothing, then the timeline of recent ones. One record each.
  const recent = recentConversations(current, 40);
  const byId = new Map(recent.map((c) => [c.conversationId, c]));
  const missed = perDate.filter((d) => !d.all && !d.alternative && !perDate.some((o) => o.phrase === d.phrase && o.hits.length));
  const nearMissed = missed.flatMap((d) => {
    const t = new Date(d.from).getTime();
    return [...recent].sort((a, b) => Math.abs(Date.parse(a.createdAt) - t) - Math.abs(Date.parse(b.createdAt) - t)).slice(0, 2).map((c) => c.conversationId);
  });
  const timeline = recent.slice(0, config.memoryTimeline).map((c) => c.conversationId);
  const shown = new Set<string>();
  for (const id of uniq([...selected, ...nearMissed, ...timeline])) {
    const c = byId.get(id) ?? getConversationMemory(id);
    if (c && push({ kind: "summary", conversationId: id, conversationTitle: c.title, createdAt: c.createdAt, text: conversationText(c) }, 700)) shown.add(id);
  }
  // 6. The exact messages behind the selected conversations. Not about the past →
  //    only the user's own words (their needs): an old ANSWER, replayed verbatim,
  //    got repeated as if it were a current fact (measured). Recorded facts above
  //    carry the date they were observed, so they can't be mistaken for "now".
  for (const h of kwHits) {
    if (seenMsg.has(h.id) || !selected.includes(h.conversationId) || (!q.aboutOurPast && h.role !== "user")) continue;
    seenMsg.add(h.id);
    if (!pushMessage(h)) break;
  }

  // ── Header: always say what was searched and what exists ────────────────
  const matched = dateHits.length > 0 || selected.length > 0;
  const lines: string[] = [];
  lines.push(`Stored history: ${stats.count} earlier conversation(s)` +
    (stats.first ? `, from ${fmtDay(stats.first, tz)} to ${fmtDay(stats.last!, tz)}.` : "."));
  for (const d of perDate) {
    if (!d.hits.length) lines.push(`Searched ${d.label}${d.alternative ? ` (another reading of "${d.phrase}")` : ""}: ${d.all ? `${d.all} message(s), none about the topic asked` : "NO conversation records on that date"}.`);
    else lines.push(`Searched ${d.label}${d.alternative ? ` (another reading of "${d.phrase}")` : ""}: ${d.hits.length} message(s) in ${uniq(d.hits.map((h) => `"${h.conversationTitle}"`)).join(", ")}.`);
  }
  if (perDate.some((d) => d.alternative)) lines.push("A weekday phrase had two possible dates; both were searched. Use the one whose conversation matches what the user describes, and say which date it was.");
  if (q.terms.length || q.figures.length) {
    lines.push(`Searched all history for [${[...q.terms, ...q.figures.map((f) => `amount ${f}`)].join(", ")}]: ` +
      `${kwHits.length} message(s), ${topicConvs.length} conversation summar${topicConvs.length === 1 ? "y" : "ies"}, ${facts.size} recorded fact value(s).`);
  }
  const older = recent.filter((c) => !shown.has(c.conversationId)).slice(0, 20);
  if (older.length) lines.push(`Other conversations on record (not shown in full): ${older.map((c) => `"${c.title}" (${fmtDay(c.createdAt, tz)})`).join("; ")}.`);
  if (!stats.count) lines.push("There are no earlier conversations. Do NOT invent or guess any.");
  else if (q.aboutOurPast && !matched) lines.push("Nothing in the history matched this question's dates or words. The recent conversations below are listed so you can tell the user what DOES exist — do NOT invent or guess what was said.");
  else if (!q.aboutOurPast) lines.push("The records below are background. Use one only if it is genuinely relevant to this message; otherwise ignore them and don't mention them.");

  const label = (r: MemoryRecord) => {
    switch (r.kind) {
      case "profile": return `[${r.id}] What the user has told me about themselves (from earlier chats):`;
      case "claims": return `[${r.id}] Facts recorded in earlier answers (value history with the date each was observed — compare with current sources):`;
      case "summary": return `[${r.id}] Conversation "${r.conversationTitle}" (started ${fmtDay(r.createdAt, tz)}):`;
      default: return `[${r.id}] ${fmtDateTime(r.createdAt, tz)} · conversation "${r.conversationTitle}" · ${(r.role ?? "user").toUpperCase()}:`;
    }
  };
  const recordText = records.map((r) => `${label(r)}\n${r.text}`).join("\n\n");
  const promptBlock = `<memory>\n${lines.join("\n")}\n${recordText ? "\n" + recordText + "\n" : ""}</memory>`;

  // One line for the UI: what was actually recalled for this message.
  const titles = selected
    .map((id) => byId.get(id)?.title ?? getConversationMemory(id)?.title).filter((t): t is string => !!t);
  const note = matched
    ? `recalled ${titles.slice(0, 3).map((t) => `"${t}"`).join(", ")}${facts.size ? " · recorded facts" : ""}`
    : missed.length ? `No records for ${missed.map((d) => d.label).join(", ")}` : q.aboutOurPast ? "No matching past conversations" : "";

  return {
    report: {
      aboutOurPast: q.aboutOurPast, recalled: titles, dateRefs, searchedTerms: q.terms, records, totalConversations: stats.count, note,
      retrievers: { dates: dateHits.length, keywords: kwHits.length, topics: topicConvs.length, facts: facts.size },
    },
    promptBlock,
  };
}
