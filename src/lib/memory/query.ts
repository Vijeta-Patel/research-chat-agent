import * as chrono from "chrono-node";
import { now } from "@/lib/memory/db";
import type { MemoryReport } from "@/lib/types";
import { STOP_WORDS, fmtDay, safeTimeZone, tokenize } from "@/lib/util";

// Reading the question, before any memory is searched: which dates does it
// name, which content words, which money figures, and is it about OUR past
// conversations or about the world? All deterministic — no model call.

export interface UserClock {
  tzOffsetMinutes: number; // Date#getTimezoneOffset() from the browser (IST = -330)
  timeZone: string; // IANA name from the browser, for labels
}

export interface Question {
  aboutOurPast: boolean;
  dates: MemoryReport["dateRefs"]; // every date named; they select memory only when aboutOurPast
  terms: string[]; // content words
  figures: string[]; // money amounts as plain numbers: "Is it still $25?" → ["25"]
}

/**
 * British ↔ American spellings of a word, so "moisturiser" finds "moisturizer"
 * and "colour" finds "color". Measured: the distiller stored one spelling and
 * the question used the other; stemming alone doesn't bridge them.
 */
export function spellings(word: string): string[] {
  const out = new Set([word]);
  const swap = (re: RegExp, to: string) => { if (re.test(word)) out.add(word.replace(re, to)); };
  swap(/is(e|ed|er|ers|es|ing|ation|ations)$/, "iz$1");
  swap(/iz(e|ed|er|ers|es|ing|ation|ations)$/, "is$1");
  swap(/([a-z]{2})our(s|ed|ing|ite|ites)?$/, "$1or$2");
  swap(/([a-z]{2}[^o])or(s|ed|ing|ite|ites)?$/, "$1our$2");
  return [...out];
}

export function readQuestion(text: string, clock: UserClock): Question {
  const dates = resolveDates(text, clock);
  return {
    aboutOurPast: PAST_REF.test(text),
    dates,
    terms: keywordTerms(text, dates),
    figures: [...new Set([...text.matchAll(/[$€£₹]\s?(\d[\d,]*(?:\.\d+)?)/g)].map((m) => m[1].replace(/,/g, "")))],
  };
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
    // "what was I researching", "have we looked at", "my last three conversations", "earlier this week".
    String.raw`\b(was|were|have|had|did)\s+(i|we)\b`,
    String.raw`\b(my|our) (last|previous|earlier|recent|past)\b|\b(earlier (this|last) (week|month)|the other day)\b`,
  ].join("|"),
  "i",
);

// Recall keys on content words. On top of the shared stop-words: date words
// (dates are resolved separately), words about the conversation itself, and
// common verbs/filler — they match unrelated chats ("you can't even USE…") and
// neighbour expansion would multiply that noise.
const RECALL_STOP = new Set([
  ...STOP_WORDS,
  ...("you we they he she me my our your their any some all more most other such than too very just also only own same " +
    "again ever still today now yet since ago last next week weeks month months year years day days " +
    "monday tuesday wednesday thursday friday saturday sunday january february march april june july august " +
    "september october november december jan feb mar apr jun jul aug sep sept oct nov dec yesterday tomorrow " +
    "asked ask said tell told answer answered correct changed change anything something thing things please thanks hi hello " +
    "there here them it's i'm im lets let's get got discuss discussed talk talked chat conversation " +
    "use used using uses think thought know knew want wanted need needed make made like liked good great bad " +
    "really actually maybe much many long time times hey yeah okay ok sure stuff " +
    "see saw look looked go going went come came take took give gave try tried work worked works keep kept " +
    "suggest suggested recommend recommended remind plan end one ones first came " +
    "start started stop stopped help helped cannot cant dont didnt doesnt wasnt isnt even never always often well less least every").split(/\s+/),
]);

// Local midnight (in the user's zone) of y-m-d, expressed as a UTC Date.
function localMidnightUtc(y: number, m: number, d: number, tzOffsetMinutes: number): Date {
  return new Date(Date.UTC(y, m - 1, d) + tzOffsetMinutes * 60_000);
}

function resolveDates(text: string, clock: UserClock): MemoryReport["dateRefs"] {
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

    // "last Tuesday", said on a Wednesday, means yesterday to some people and the
    // Tuesday of last week to others. When the parsed day falls in the current
    // week, search the week before too and let the topic decide.
    const weekStart = ref.getTime() - (((ref.getUTCDay() + 6) % 7) + 1) * 86_400_000;
    if (/^last\s+(mon|tue|wed|thu|fri|sat|sun)/.test(phrase) && !r.end && from.getTime() > weekStart) {
      const alt = new Date(from.getTime() - 7 * 86_400_000);
      out.push({ phrase: r.text, from: alt.toISOString(), to: new Date(alt.getTime() + 86_400_000).toISOString(), label: fmtDay(alt, tz), alternative: true });
    }
  }
  return out;
}

function keywordTerms(text: string, dateRefs: MemoryReport["dateRefs"]): string[] {
  let t = text;
  for (const d of dateRefs) t = t.replace(d.phrase, " ");
  return [...new Set(tokenize(t, RECALL_STOP).filter((w) => w.length >= 3 && !/^\d+$/.test(w)))].slice(0, 10);
}
