import * as chrono from "chrono-node";
import {
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
    String.raw`\b(i|we)\s+(?:had\s+)?(ask|asked|say|said|tell|told|discuss|discussed|talk|talked|mention|mentioned|shortlist|shortlisted|compare|compared|look|looked|decide|decided|choose|chose|pick|picked|share|shared|research|researched)\b`,
    String.raw`\byou\s+(?:had\s+)?(say|said|tell|told|recommend|recommended|suggest|suggested|answer|answered|mention|mentioned|find|found|give|gave|show|showed)\b`,
    String.raw`\b(last time|previously|our (chat|conversation|discussion|last chat)|we spoke|you remember|remember when|do you remember)\b`,
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
    "has have there here them its it's i'm im lets let's get got discuss discussed talk talked chat conversation").split(/\s+/),
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

export function retrieveMemory(
  message: string,
  clock: UserClock,
  currentConversationId?: string,
): { report: MemoryReport; promptBlock: string } {
  const tz = safeTimeZone(clock.timeZone);
  const allDates = resolveDates(message, clock);
  const terms = keywordTerms(message, allDates);
  const pastRef = PAST_REF.test(message);
  // Dates select memory only when the message is about our past conversations.
  const dateRefs = pastRef ? allDates : [];
  const stats = historyStats(currentConversationId);

  type Tagged = MessageHit & { why: string };
  const picked: Tagged[] = [];
  const seen = new Set<string>();
  const take = (hits: MessageHit[], why: string) => {
    for (const h of hits) if (!seen.has(h.id)) { seen.add(h.id); picked.push({ ...h, why }); }
  };

  const perDate: { label: string; hits: MessageHit[] }[] = [];
  for (const d of dateRefs) {
    const hits = messagesBetween(d.from, d.to, currentConversationId);
    perDate.push({ label: d.label, hits });
    take(hits, `on ${d.label}`);
  }
  const fts = terms.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
  const kwHits = searchMessages(fts, currentConversationId, pastRef ? 12 : 4);
  // For questions that aren't about the past, only the user's earlier messages
  // are useful context (their team size, needs). Old answers are stale facts and
  // would tempt the model to repeat them as current.
  take(pastRef ? kwHits : kwHits.filter((h) => h.role === "user"), "keyword match");
  if (pastRef && !dateRefs.length && picked.length === 0) {
    take(recentConversationMessages(3, currentConversationId), "most recent conversations");
  }

  // Fill the fixed budget in priority order (date matches first, then keywords).
  const records: MemoryRecord[] = [];
  let used = 0;
  for (const h of picked) {
    const text = clip(h.text, h.role === "user" ? 500 : 900);
    if (used + text.length > MAX_CHARS) break;
    used += text.length;
    records.push({
      id: `M${records.length + 1}`,
      conversationId: h.conversationId,
      conversationTitle: h.conversationTitle,
      createdAt: h.createdAt,
      role: h.role,
      text,
    });
  }

  // Always tell the model what was searched and what exists — including "nothing".
  const lines: string[] = [];
  lines.push(`Stored history: ${stats.count} earlier conversation(s)` +
    (stats.first ? `, from ${fmtDay(new Date(stats.first), tz)} to ${fmtDay(new Date(stats.last!), tz)}.` : "."));
  for (const d of perDate) {
    if (!d.hits.length) lines.push(`Searched ${d.label}: NO conversation records on that date.`);
    else {
      const titles = [...new Set(d.hits.map((h) => `"${h.conversationTitle}"`))].join(", ");
      lines.push(`Searched ${d.label}: ${d.hits.length} message(s) in conversation(s) ${titles}.`);
    }
  }
  if (terms.length) lines.push(`Keyword search for [${terms.join(", ")}]: ${kwHits.length} matching message(s).`);
  // When a lookup about the past comes up empty (or a date has no records),
  // list the conversations that DO exist, nearest to the asked-about date, so
  // the agent can offer "did you mean the one on 3 Nov about X?" instead of a dead end.
  const missedDate = perDate.some((d) => !d.hits.length);
  if (pastRef && (missedDate || !records.length) && stats.count > 0) {
    const anchor = dateRefs.length ? new Date(dateRefs[0].from).getTime() : now().getTime();
    const index = listConversations()
      .filter((c) => c.id !== currentConversationId)
      .sort((a, b) => Math.abs(new Date(a.createdAt).getTime() - anchor) - Math.abs(new Date(b.createdAt).getTime() - anchor))
      .slice(0, 8)
      .map((c) => `"${c.title}" (started ${fmtDay(new Date(c.createdAt), tz)})`);
    lines.push(`Conversations that do exist, nearest first: ${index.join("; ")}.`);
  }
  if (!records.length) lines.push("No relevant records found. Do NOT invent or guess what was said in past conversations.");
  else if (!pastRef) lines.push("These are only possibly-related earlier messages; mention them only if genuinely useful.");

  const recordText = records
    .map((r) => `[${r.id}] ${fmtDateTime(r.createdAt, tz)} · conversation "${r.conversationTitle}" · ${r.role.toUpperCase()}:\n${r.text}`)
    .join("\n\n");

  const promptBlock = `<memory>\n${lines.join("\n")}\n${recordText ? "\n" + recordText + "\n" : ""}</memory>`;

  const note = records.length
    ? `${records.length} past message(s) used` + (dateRefs.length ? ` · ${dateRefs.map((d) => d.label).join(", ")}` : "")
    : dateRefs.length
      ? `No records for ${dateRefs.map((d) => d.label).join(", ")}`
      : pastRef ? "No matching past conversations" : "";

  return {
    report: { dateRefs, searchedTerms: terms, records, totalConversations: stats.count, note },
    promptBlock,
  };
}
