import * as chrono from "chrono-node";
import { cosine, embed, embeddingsEnabled } from "@/lib/memory/embed";
import {
  withNeighbours,
  allConversationMemories, claimKey, claimsForConversations, getConversationMemory, getProfile,
  searchClaimHistory, searchConversationMemory, type Claim,
  historyStats, listConversations, messagesBetween, now, recentConversationMessages, searchMessages, type MessageHit,
} from "@/lib/memory/db";
import type { MemoryRecord, MemoryReport } from "@/lib/types";

// Memory retrieval runs in the harness BEFORE the model is called, so the model
// keeps exactly one tool (web_search) and we save a round-trip.
// No LLM call here: dates are parsed deterministically and history is filtered
// with SQL + full-text search. Cheap, fast, and identical on every run.

export interface UserClock {
  tzOffsetMinutes: number; // Date#getTimezoneOffset() from the browser (IST = -330)
  timeZone: string; // IANA name from the browser, for labels
}

// Does the message refer to OUR past conversations (vs. the world)? Only then
// do dates select memory: "what did I ask on 3 Nov" → memory; "what did Supabase
// ship in the last month" → a search filter, not a memory lookup.
const PAST_REF = new RegExp(
  [
    // Base forms only for speech verbs ("what did I ask"); for decision verbs require the
    // past tense, so "which CRM should we pick?" is NOT a question about our past.
    String.raw`\b(i|we)\s+(?:had\s+)?(ask|asked|say|said|tell|told|discuss|discussed|talk|talked|mention|mentioned|shortlisted|compared|looked|decided|chose|picked|shared|researched)\b`,
    String.raw`\byou\s+(?:had\s+)?(say|said|tell|told|recommend|recommended|suggest|suggested|answer|answered|mention|mentioned|found|gave|showed)\b`,
    String.raw`\b(last time|previously|our (chat|conversation|discussion|last chat)|we spoke|you remember|remember when|do you remember|talked about|we covered)\b`,
    String.raw`\b(your|the) (answer|recommendation|advice|reply|shortlist|list) (from|on|last)\b`,
  ].join("|"),
  "i",
);

const STOP = new Set(
  ("a an the and or but if then so of to in on at by for with about from into over under is are was were be been being " +
    "do does did have has had i you we they he she it me my our your their this that these those what which who whom " +
    "how when where why can could should would will shall may might must not no yes any some all more most other such " +
    "than too very just also only own same again ever still today now yet since ago last next week weeks month months " +
    "year years day days monday tuesday wednesday thursday friday saturday sunday january february march april may june " +
    "july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec yesterday tomorrow " +
    "asked ask said tell told answer answered correct changed change anything something thing things please thanks hi hello " +
    "has have there here them its it's i'm im lets let's get got discuss discussed talk talked chat conversation " +
    // Common verbs and filler: they match unrelated chats ("you can't even USE…") and
    // neighbour expansion would multiply that noise. Recall should key on content words.
    "use used using uses think thought know knew want wanted need needed make made like liked good great bad " +
    "really just actually maybe might much many long time times hey yeah yes okay ok sure thing stuff something " +
    "see saw look looked go going went come came take took give gave try tried work worked works keep kept " +
    "start started stop stopped help helped would could should will can cannot cant dont didnt doesnt wasnt isnt " +
    "also still even ever never always often again then than well very more most less least some any every").split(/\s+/),
);

const fmtDay = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: tz }).format(d);
const fmtDateTime = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: tz,
  }).format(new Date(iso));

export function safeTimeZone(tz: string | undefined): string {
  try {
    if (tz) {
      new Intl.DateTimeFormat("en-GB", { timeZone: tz });
      return tz;
    }
  } catch {}
  return "UTC";
}

// Local midnight (in the user's zone) of y-m-d, expressed as a UTC Date.
function localMidnightUtc(y: number, m: number, d: number, tzOffsetMinutes: number): Date {
  return new Date(Date.UTC(y, m - 1, d) + tzOffsetMinutes * 60_000);
}

export function resolveDates(text: string, clock: UserClock): MemoryReport["dateRefs"] {
  const ref = now();
  const tz = safeTimeZone(clock.timeZone);
  const results = chrono.parse(text, { instant: ref, timezone: -clock.tzOffsetMinutes });
  const out: MemoryReport["dateRefs"] = [];
  // "is it still correct today?" / "right now" refer to the present, not to a
  // past conversation — ignore them when another date is mentioned, and always for "now".
  const isPresent = (t: string) => /^(today|now|right now|tonight|this (morning|afternoon|evening))$/i.test(t.trim());
  const meaningful = results.filter((r) => !isPresent(r.text));
  for (const r of results) {
    if (isPresent(r.text) && (meaningful.length > 0 || /now/i.test(r.text))) continue;
    // A memory date must name a day: "3 Nov", "Tuesday", "yesterday", "last week".
    // Time-only parses ("from 2", "at 5") are not dates. Measured bug: "used it
    // FROM 2 years" parsed as "2 o'clock today" and pulled in every chat from today.
    const s0 = r.start;
    const namesDay = s0.isCertain("day") || s0.isCertain("weekday") || s0.isCertain("month") ||
      /\b(today|yesterday|week|month|year|ago|tonight|morning|evening)\b/i.test(r.text);
    if (!namesDay) continue;
    const y = r.start.get("year")!, m = r.start.get("month")!, d = r.start.get("day")!;
    let from = localMidnightUtc(y, m, d, clock.tzOffsetMinutes);
    let to = new Date(from.getTime() + 86_400_000);
    const phrase = r.text.toLowerCase();
    const before = text.slice(0, r.index).toLowerCase();

    if (/\bweek\b/.test(phrase)) {
      // Whole Mon–Sun week containing the parsed date.
      const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
      from = new Date(from.getTime() - dow * 86_400_000);
      to = new Date(from.getTime() + 7 * 86_400_000);
    } else if (/\bmonth\b/.test(phrase)) {
      from = localMidnightUtc(y, m, 1, clock.tzOffsetMinutes);
      to = localMidnightUtc(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1, clock.tzOffsetMinutes);
    } else if (r.end) {
      const e = r.end;
      to = new Date(localMidnightUtc(e.get("year")!, e.get("month")!, e.get("day")!, clock.tzOffsetMinutes).getTime() + 86_400_000);
    }
    if (/\bsince\s*$/.test(before) || /^since\b/.test(phrase)) to = ref;
    if (from > ref) continue; // future dates ("next Friday") aren't memory lookups

    const label =
      to.getTime() - from.getTime() <= 86_400_000
        ? fmtDay(from, tz)
        : `${fmtDay(from, tz)} – ${fmtDay(new Date(Math.min(to.getTime(), ref.getTime()) - 1), tz)}`;
    out.push({ phrase: r.text, from: from.toISOString(), to: to.toISOString(), label });
  }
  return out;
}

export function keywordTerms(text: string, dateRefs: MemoryReport["dateRefs"]): string[] {
  let t = text;
  for (const d of dateRefs) t = t.replace(d.phrase, " ");
  const words = t.toLowerCase().match(/[a-z0-9][a-z0-9.+#-]*[a-z0-9+#]|[a-z0-9]/g) ?? [];
  return [...new Set(words.filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)))].slice(0, 10);
}

const MAX_CHARS = 14_000; // memory budget in the prompt (~3.5k tokens), regardless of history size
// Old answers carry [S#] markers that point at *that* conversation's sources;
// strip them so the model cites the memory record [M#] instead.
const clip = (s: string, n: number) => {
  const t = s.replace(/\s?\[(S\d+)(,\s*S\d+)*\]/g, "");
  return t.length > n ? t.slice(0, n) + " …[truncated]" : t;
};

export interface RetrieveOptions {
  currentConversationId?: string;
  currentMessageCount: number; // messages already in this conversation (for the long-chat summary)
  historyWindow: number; // how many of them are replayed verbatim
}

const RRF_K = 60;

/**
 * Memory READ path — hybrid recall over four retrievers, fused by rank:
 *   1. dates      exact SQL range over messages (only when the message is about our past)
 *   2. keywords   FTS5/BM25 over raw transcripts
 *   3. topics     FTS5/BM25 over DISTILLED summaries/topics/entities (catches vague
 *                 wording: "that database thing" → topic "managed databases")
 *   4. vectors    optional hosted embeddings over summaries (only with GEMINI_API_KEY)
 * Then fills a fixed budget, most reliable first: profile → long-chat summary →
 * exact date hits → claims (with history) → conversation summaries → raw excerpts.
 */
export async function retrieveMemory(
  message: string,
  clock: UserClock,
  opts: RetrieveOptions,
): Promise<{ report: MemoryReport; promptBlock: string }> {
  const tz = safeTimeZone(clock.timeZone);
  const current = opts.currentConversationId;
  const allDates = resolveDates(message, clock);
  const terms = keywordTerms(message, allDates);
  const pastRef = PAST_REF.test(message);
  // Dates select memory only when the message is about our past conversations.
  const dateRefs = pastRef ? allDates : [];
  const stats = historyStats(current);
  const fts = terms.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");

  // ── Retrievers ──────────────────────────────────────────────────────────
  const perDate: { label: string; hits: MessageHit[] }[] = dateRefs.map((d) => ({
    label: d.label,
    hits: messagesBetween(d.from, d.to, current),
  }));
  const dateHits = perDate.flatMap((d) => d.hits);
  // A message alone loses its context: "BIODERMA AUTODERM" was the reply to "which
  // cream?" after "a barrier cream for two years". So each keyword hit brings its
  // neighbours (2 before, 1 after) from the same conversation.
  const kwHits = withNeighbours(searchMessages(fts, current, pastRef ? 8 : 3));
  const topicConvs = pastRef ? searchConversationMemory(fts, current, 8) : [];
  let vectorConvs: string[] = [];
  let vectorState = "off";
  if (pastRef && embeddingsEnabled()) {
    const mems = allConversationMemories(current).filter((m) => m.embedding?.length);
    const q = mems.length ? (await embed([message], "query"))?.[0] : null;
    if (q) {
      // Measured: hosted embeddings rank correctly but with small margins, so only
      // near-top hits count, and vectors get half weight in fusion (a tie-breaker).
      const scored = mems.map((m) => ({ id: m.conversationId, s: cosine(q, m.embedding!) })).sort((a, b) => b.s - a.s);
      const best = scored[0]?.s ?? 0;
      vectorConvs = scored.filter((x) => x.s >= Math.max(0.6, best - 0.03)).slice(0, 2).map((x) => x.id);
      vectorState = `${vectorConvs.length} match(es)`;
    } else vectorState = mems.length ? "unavailable" : "no summaries yet";
  }

  // ── Reciprocal rank fusion over conversations ───────────────────────────
  const uniq = (xs: string[]) => [...new Set(xs)];
  const lists: { ids: string[]; weight: number }[] = [
    { ids: uniq(dateHits.map((h) => h.conversationId)), weight: 3 }, // exact → strongest
    { ids: uniq(kwHits.map((h) => h.conversationId)), weight: 1 },
    { ids: topicConvs, weight: 1 },
    { ids: vectorConvs, weight: 0.5 },
  ];
  const fused = new Map<string, number>();
  for (const l of lists) l.ids.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + l.weight / (RRF_K + rank + 1)));
  const selected = pastRef ? [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id) : [];

  // ── Assemble records into a fixed budget ────────────────────────────────
  const records: MemoryRecord[] = [];
  let used = 0;
  const push = (r: Omit<MemoryRecord, "id">, max: number) => {
    const text = clip(r.text, max);
    if (used + text.length > MAX_CHARS) return false;
    used += text.length;
    records.push({ ...r, id: `M${records.length + 1}`, text });
    return true;
  };

  // 1. Profile: always — cross-session context that doesn't depend on keywords.
  const profile = getProfile();
  if (profile.length) {
    push({ kind: "profile", conversationId: "", conversationTitle: "profile", createdAt: profile[0].updatedAt,
      text: profile.map((p) => `${p.key}: ${p.value}`).join("; ") }, 800);
  }
  // 2. Long chat: what scrolled out of the verbatim window of THIS conversation.
  if (current && opts.currentMessageCount > opts.historyWindow) {
    const cm = getConversationMemory(current);
    if (cm) push({ kind: "summary", conversationId: current, conversationTitle: `${cm.title} (earlier in this conversation)`,
      createdAt: cm.updatedAt, text: cm.summary }, 900);
  }
  // 3. Exact date hits: raw wording, the ground truth for "what did I ask on…".
  const seenMsg = new Set<string>();
  for (const h of dateHits) {
    if (seenMsg.has(h.id)) continue;
    seenMsg.add(h.id);
    push({ kind: "message", conversationId: h.conversationId, conversationTitle: h.conversationTitle, createdAt: h.createdAt, role: h.role, text: h.text },
      h.role === "user" ? 500 : 900);
  }
  if (pastRef) {
    // 4. Claims (versioned) from selected conversations + any whose entity is named now.
    const claimMap = new Map<string, Claim>();
    // Claims from the top 2 conversations, plus the full history of any fact whose
    // entity/attribute/value is named in the question.
    for (const c of [...claimsForConversations(selected.slice(0, 2)), ...searchClaimHistory(fts)]) claimMap.set(c.id, c);
    const groups = new Map<string, Claim[]>();
    for (const c of claimMap.values()) {
      const k = `${claimKey(c.entity)}|${claimKey(c.attribute)}`;
      groups.set(k, [...(groups.get(k) ?? []), c]);
    }
    if (groups.size) {
      const lines = [...groups.values()].slice(0, 20).map((vs) => {
        vs.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
        const hist = vs.map((v) => `${v.value} (observed ${fmtDay(new Date(v.observedAt), tz)}${v.sourceTitle ? `, source: ${v.sourceTitle}` : ""})`);
        return `- ${vs[0].entity} · ${vs[0].attribute}: ${hist.join(" → ")}`;
      });
      push({ kind: "claims", conversationId: [...claimMap.values()][0].conversationId, conversationTitle: "recorded facts",
        createdAt: [...claimMap.values()][0].observedAt, text: lines.join("\n") }, 2500);
    }
    // 5. Summaries of the fused top conversations.
    for (const id of selected) {
      const cm = getConversationMemory(id);
      if (cm) push({ kind: "summary", conversationId: id, conversationTitle: cm.title, createdAt: cm.createdAt,
        text: `${cm.summary}\nTopics: ${cm.topics.join(", ")}` }, 900);
    }
  }
  // 6. Raw keyword excerpts. Not about the past → only the user's own earlier
  //    messages (their needs), never old answers that could be repeated as current facts.
  for (const h of pastRef ? kwHits : kwHits.filter((x) => x.role === "user")) {
    if (seenMsg.has(h.id)) continue;
    seenMsg.add(h.id);
    if (!push({ kind: "message", conversationId: h.conversationId, conversationTitle: h.conversationTitle, createdAt: h.createdAt, role: h.role, text: h.text },
      h.role === "user" ? 500 : 900)) break;
  }
  // 7. About the past but nothing matched at all → most recent conversations.
  const substantive = records.filter((r) => r.kind !== "profile").length;
  if (pastRef && !dateRefs.length && !substantive) {
    for (const h of recentConversationMessages(3, current)) {
      if (!push({ kind: "message", conversationId: h.conversationId, conversationTitle: h.conversationTitle, createdAt: h.createdAt, role: h.role, text: h.text },
        h.role === "user" ? 500 : 900)) break;
    }
  }

  // ── Header: always say what was searched and what exists ────────────────
  const lines: string[] = [];
  lines.push(`Stored history: ${stats.count} earlier conversation(s)` +
    (stats.first ? `, from ${fmtDay(new Date(stats.first), tz)} to ${fmtDay(new Date(stats.last!), tz)}.` : "."));
  for (const d of perDate) {
    if (!d.hits.length) lines.push(`Searched ${d.label}: NO conversation records on that date.`);
    else lines.push(`Searched ${d.label}: ${d.hits.length} message(s) in ${[...new Set(d.hits.map((h) => `"${h.conversationTitle}"`))].join(", ")}.`);
  }
  if (terms.length) {
    lines.push(`Keyword search for [${terms.join(", ")}]: ${kwHits.length} message(s)` +
      (pastRef ? `; topic search over conversation summaries: ${topicConvs.length} conversation(s); semantic search: ${vectorState}.` : "."));
  }
  const missedDate = perDate.some((d) => !d.hits.length);
  if (pastRef && (missedDate || !substantive) && stats.count > 0) {
    // A compact index (with topics) so the model can do the final semantic match itself.
    const anchor = dateRefs.length ? new Date(dateRefs[0].from).getTime() : now().getTime();
    const topics = new Map(allConversationMemories(current).map((m) => [m.conversationId, m.topics]));
    const index = listConversations()
      .filter((c) => c.id !== current)
      .sort((a, b) => Math.abs(new Date(a.createdAt).getTime() - anchor) - Math.abs(new Date(b.createdAt).getTime() - anchor))
      .slice(0, 12)
      .map((c) => `"${c.title}" (started ${fmtDay(new Date(c.createdAt), tz)}${topics.get(c.id)?.length ? `; topics: ${topics.get(c.id)!.join(", ")}` : ""})`);
    lines.push(`Conversations that do exist, nearest first: ${index.join("; ")}.`);
  }
  if (!substantive) lines.push("No relevant records found. Do NOT invent or guess what was said in past conversations.");
  else if (!pastRef) lines.push("These are only possibly-related earlier messages; mention them only if genuinely useful.");

  const label = (r: MemoryRecord) => {
    switch (r.kind) {
      case "profile": return `[${r.id}] What the user has told me about themselves (from earlier chats):`;
      case "claims": return `[${r.id}] Facts recorded in earlier answers (value history with the date each was observed — compare with current sources):`;
      case "summary": return `[${r.id}] Summary of conversation "${r.conversationTitle}" (started ${fmtDay(new Date(r.createdAt), tz)}):`;
      default: return `[${r.id}] ${fmtDateTime(r.createdAt, tz)} · conversation "${r.conversationTitle}" · ${(r.role ?? "user").toUpperCase()}:`;
    }
  };
  const recordText = records.map((r) => `${label(r)}\n${r.text}`).join("\n\n");
  const promptBlock = `<memory>\n${lines.join("\n")}\n${recordText ? "\n" + recordText + "\n" : ""}</memory>`;

  const kinds = (k: MemoryRecord["kind"]) => records.filter((r) => r.kind === k).length;
  const parts = [
    kinds("message") && `${kinds("message")} message(s)`,
    kinds("summary") && `${kinds("summary")} summar${kinds("summary") === 1 ? "y" : "ies"}`,
    kinds("claims") && "recorded facts",
    kinds("profile") && "your profile",
  ].filter(Boolean);
  const note = substantive || kinds("profile")
    ? `used ${parts.join(", ")}` + (dateRefs.length ? ` · ${dateRefs.map((d) => d.label).join(", ")}` : "")
    : dateRefs.length ? `No records for ${dateRefs.map((d) => d.label).join(", ")}` : pastRef ? "No matching past conversations" : "";

  return {
    report: {
      dateRefs, searchedTerms: terms, records, totalConversations: stats.count, note,
      retrievers: { dates: dateHits.length, keywords: kwHits.length, topics: topicConvs.length, vectors: vectorState },
    },
    promptBlock,
  };
}
