import type { CheckResult, MemoryRecord, Source } from "@/lib/types";

// Deterministic post-answer checks. No model call (no latency, no quota):
// 1. sentences with figures but no citation
// 2. citations to IDs that don't exist (fabricated)
// 3. figures that don't appear in the text of the source they cite —
//    unless they are calculations derivable from supported figures
//    (e.g. "20 seats × $39 = $780", "$780 × 12 = $9,360/year").

const CITE = /\[((?:[SM]\d+)(?:\]\s*\[|,\s*)?)+\]/g;
const ID = /[SM]\d+/g;

interface Unit { text: string; inheritedIds: string[] }

function units(text: string): Unit[] {
  const out: Unit[] = [];
  let inCode = false;
  let tableIds: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("```")) { inCode = !inCode; continue; }
    if (!line.startsWith("|")) tableIds = [];
    if (inCode || !line || /^#{1,6}\s/.test(line) || /^\|?\s*:?-{3,}/.test(line)) continue;
    // Table header row (next line is the |---| separator): not a claim, but its
    // citations (e.g. "| HubSpot [S11] |") apply to the rows below.
    if (line.startsWith("|") && /^\|?\s*:?-{3,}/.test((lines[i + 1] ?? "").trim())) {
      tableIds = idsIn(line);
      continue;
    }
    if (line.startsWith("|")) { out.push({ text: line, inheritedIds: tableIds }); continue; }
    for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z*"(])/)) out.push({ text: s, inheritedIds: [] });
  }
  return out;
}

const idsIn = (s: string) => [...new Set((s.match(CITE) ?? []).flatMap((c) => c.match(ID) ?? []))];

// Normalise markdown so "**$180**" and "$1,800" parse cleanly.
const plain = (s: string) => s.replace(CITE, " ").replace(/[*_`]|<br\s*\/?>/g, " ").replace(/(\d),(\d)/g, "$1$2");

interface Fig { raw: string; value: number; important: boolean }

// Figures worth verifying: money and percentages always; other numbers > 10 that aren't years.
function figures(s: string): Fig[] {
  const found = plain(s).match(/[$€£₹]\s?\d+(?:\.\d+)?|\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?\b/g) ?? [];
  const out: Fig[] = [];
  for (const raw of found) {
    const value = parseFloat(raw.replace(/[^\d.]/g, ""));
    if (Number.isNaN(value)) continue;
    const important = /[$€£₹%]/.test(raw);
    if (!important && (value <= 10 || /^(19|20)\d\d$/.test(raw.trim()))) continue;
    out.push({ raw: raw.trim(), value, important });
  }
  return out;
}

function numbersIn(text: string): number[] {
  return (plain(text).match(/\d+(?:\.\d+)?/g) ?? []).map(Number).filter((n) => !Number.isNaN(n));
}

const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 0.005);

// Is v a simple calculation from known-good numbers? Multiplication/division
// by any number written alongside (seats, months); addition/subtraction only
// between two supported figures (so "$39" can't be "explained" as 20 + 19).
function derivable(v: number, bases: number[], factors: number[]): boolean {
  for (const a of bases) {
    for (const b of factors) if (b !== 0 && (near(a * b, v) || near(a / b, v))) return true;
    for (const b of bases) if (near(a + b, v) || near(Math.abs(a - b), v)) return true;
  }
  return false;
}

export function checkAnswer(
  text: string,
  sources: Map<string, Source>,
  memory: MemoryRecord[],
  // searched: whether this turn used web search. Without one (maths, writing),
  // plain numbers are usually calculations, so only money/percentages are flagged.
  // userText: figures the user gave us ("20-person team") count as supported.
  opts: { searched: boolean; userText?: string } = { searched: true },
): CheckResult {
  const mem = new Map(memory.map((m) => [m.id, m]));
  const result: CheckResult = { uncitedSentences: [], unknownCitations: [], unsupportedNumbers: [] };
  const userNums = numbersIn(opts.userText ?? "");

  for (const u of units(text)) {
    const own = idsIn(u.text);
    for (const id of own) {
      if (!sources.has(id) && !mem.has(id) && !result.unknownCitations.includes(id)) result.unknownCitations.push(id);
    }
    const ids = own.length ? own : u.inheritedIds;
    const figs = figures(u.text);
    if (!figs.length) continue;

    if (!ids.length) {
      const fromUser = (f: Fig) => userNums.some((n) => near(n, f.value));
      // After a search: any uncited figure is suspect. Without one (maths,
      // memory, chit-chat): only money is — a price stated from training data
      // is the stale fact we care about; percentages and dates usually come
      // from the user's own numbers or a calculation.
      const suspect = opts.searched
        ? figs.some((f) => !fromUser(f))
        : figs.some((f) => /[$€£₹]/.test(f.raw) && !fromUser(f));
      if (suspect && !/general knowledge|unverified/i.test(u.text)) result.uncitedSentences.push(u.text.slice(0, 200));
      continue;
    }

    const sourceNums = numbersIn(ids.map((id) => sources.get(id)?.excerpt ?? mem.get(id)?.text ?? "").join(" "));
    const supported = new Set<number>();
    const isSourced = (v: number) => sourceNums.some((n) => near(n, v)) || userNums.some((n) => near(n, v));
    for (const f of figs) if (isSourced(f.value)) supported.add(f.value);

    // Allow calculations: bases are supported figures from this sentence/row;
    // factors are any number written here, the user's numbers, and 12 (months).
    const factors = [...new Set([...numbersIn(u.text), ...userNums, 12])];
    for (let pass = 0; pass < 2; pass++) {
      for (const f of figs) {
        if (!supported.has(f.value) && derivable(f.value, [...supported], factors)) supported.add(f.value);
      }
    }
    for (const f of figs) {
      if (!supported.has(f.value) && !/unverified/i.test(u.text)) result.unsupportedNumbers.push({ value: f.raw, cited: ids });
    }
  }
  return result;
}

export function hasProblems(c: CheckResult): boolean {
  return c.uncitedSentences.length + c.unknownCitations.length + c.unsupportedNumbers.length > 0;
}
