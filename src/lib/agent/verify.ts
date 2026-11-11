import { config } from "@/lib/config";
import { checkAnswer } from "@/lib/agent/citations";
import { stripUnknownUrls } from "@/lib/agent/guardrails";
import { generate, type GenerateInput } from "@/lib/llm/claude";
import type { SearchTool } from "@/lib/search/tool";
import type { CheckResult, MemoryRecord, Source, TraceStep } from "@/lib/types";
import { citedIds, errorMessage } from "@/lib/util";

// What happens to a draft answer before it is stored: three deterministic
// checks, and at most two extra model passes when a check fails.
//   memory first   a question about our past answered without a memory record → one repair pass
//   #6 freshness   money stated without searching → one silent pass WITH search
//   #7 URL guard   links we never retrieved are removed
//   citations      figures not in their cited source / invented ids → one repair pass

const problemCount = (c: CheckResult) =>
  c.unsupportedNumbers.length + c.unknownCitations.length + c.uncitedSentences.length;

export async function verifyAnswer(opts: {
  draft: string;
  base: Pick<GenerateInput, "history" | "userText">;
  userMessage: string;
  memory: MemoryRecord[];
  memoryBlock: string; // what recall found, exactly as the model was shown it
  aboutOurPast: boolean;
  search: SearchTool;
  startedAt: number;
  trace: (step: TraceStep) => void;
  onChecks: (c: CheckResult) => void; // result of the checks on the draft, before any repair
  signal?: AbortSignal;
}): Promise<{ text: string; checks: CheckResult; notes: string[] }> {
  const { search, trace, signal } = opts;
  const notes: string[] = [];
  const check = (t: string) =>
    checkAnswer(t, search.sources, opts.memory, { searched: search.turnSources.length > 0, userText: opts.userMessage });
  const hooks = { search: search.run, trace, signal }; // no onText: these passes are silent
  let text = opts.draft;
  let checks = check(text);

  // Memory first: a question about our past conversations is answered FROM the
  // memory that was looked through before the model ran — never from a guess.
  // The answer must cite a record that exists, or say plainly that there is none.
  const memoryIds = new Set(opts.memory.map((m) => m.id));
  const grounded = (t: string) =>
    citedIds(t, "M").some((id) => memoryIds.has(id)) ||
    /\b(no|not|n't|don't|didn't|couldn't|can't|nothing|never)\b[^.\n]{0,80}\b(record|records|memory|history|conversation|conversations|chat|chats|recall|remember|find|found)\b/i.test(t);
  if (opts.aboutOurPast && !grounded(text)) {
    const t0 = Date.now();
    try {
      const r = await generate({
        ...opts.base,
        allowTools: false,
        continuation: {
          draft: text,
          instruction:
            `Automatic check: the user asked about our earlier conversations, but your draft does not rest on any memory record. ` +
            `Here is everything memory holds that is relevant, again:\n${opts.memoryBlock}\n\n` +
            `Rewrite the answer using ONLY these records for anything about the past: cite the record ([M#]) for each thing you say was asked, said or decided, with its date. ` +
            `If the records do not contain it, say plainly that you have no record of it and mention what you do have. Keep any web-sourced parts ([S#]) as they are. Output only the revised answer.`,
        },
      }, hooks);
      trace({ step: "repair", detail: "memory grounding: past question answered without a memory record", ms: Date.now() - t0 });
      if (r.text.trim().length > 20 && grounded(r.text)) {
        text = r.text.trim();
        notes.push("Rewritten from memory records: the first draft answered a question about earlier chats without citing one.");
        checks = check(text);
      }
    } catch (err) {
      console.warn("[agent] memory grounding pass failed:", errorMessage(err, 120));
    }
  }

  // #6: time-sensitive figures stated WITHOUT searching this turn (the model
  // answering from stale training data). The verified answer replaces the draft.
  if (!search.turnSources.length && checks.uncitedSentences.length && Date.now() - opts.startedAt < config.turnSoftDeadlineMs) {
    const t0 = Date.now();
    try {
      const v = await generate({
        ...opts.base,
        allowTools: true,
        continuation: {
          draft: text,
          instruction: "Automatic check: your draft states prices/figures without having searched in this turn, so they may be outdated. Use web_search to verify them now, then give the full corrected answer with citations. If they can't be verified, say so.",
        },
      }, hooks);
      trace({ step: "repair", detail: `freshness verification (${search.turnSources.length} sources)`, ms: Date.now() - t0 });
      if (v.text.trim() && search.turnSources.length) {
        text = v.text.trim();
        notes.push("Re-checked against live sources because the first draft stated figures without searching.");
        checks = check(text);
      }
    } catch (err) {
      console.warn("[agent] freshness verification failed:", errorMessage(err, 120));
    }
  }

  // #7: no links the agent didn't actually retrieve.
  const allowed = new Set([...search.sources.values()].map((s) => s.url));
  const urls = stripUnknownUrls(text, allowed);
  if (urls.removed) {
    text = urls.text;
    notes.push(`Removed ${urls.removed} link(s) that didn't come from a retrieved source.`);
    trace({ step: "guard", detail: `stripped ${urls.removed} unknown URL(s)`, ms: 0 });
    checks = check(text);
  }

  // Citations: ONE repair pass, without tools. The prompt carries the text of
  // the cited sources, so the model can only fix, remove or flag — not add.
  opts.onChecks(checks);
  if (checks.unsupportedNumbers.length || checks.unknownCitations.length) {
    const t0 = Date.now();
    const evidence = [...new Set(checks.unsupportedNumbers.flatMap((n) => n.cited))]
      .map((id) => search.sources.get(id))
      .filter((s): s is Source => !!s)
      .map((s) => `[${s.id}] ${s.title} (${s.domain}):\n${s.excerpt.slice(0, 1500)}`)
      .join("\n\n");
    const problems = [
      ...checks.unsupportedNumbers.map((n) => `- "${n.value}" is cited to ${n.cited.join(", ")}, but that figure does not appear in the text of those sources.`),
      ...checks.unknownCitations.map((id) => `- [${id}] is not a valid source ID.`),
    ].join("\n");
    try {
      const r = await generate({
        ...opts.base,
        allowTools: false,
        continuation: {
          draft: text,
          instruction:
            `Automatic fact-check of your draft found problems:\n${problems}\n\nText of the cited sources:\n${evidence || "(none)"}\n\n` +
            `Rewrite the answer. For each flagged figure: cite a source whose text actually contains it, or remove it, or mark it "(unverified)". ` +
            `Don't add new facts. Keep everything else, including the format. Output only the revised answer.`,
        },
      }, hooks);
      const cleaned = stripUnknownUrls(r.text.trim(), allowed).text;
      const revised = check(cleaned);
      trace({ step: "repair", detail: "citation repair", ms: Date.now() - t0 });
      if (cleaned.length > 20 && problemCount(revised) < problemCount(checks)) {
        text = cleaned;
        checks = revised;
        notes.push("Revised after an automatic fact-check against the cited sources.");
      }
    } catch (err) {
      console.warn("[agent] repair pass failed:", errorMessage(err, 120));
    }
  }
  return { text, checks, notes };
}
