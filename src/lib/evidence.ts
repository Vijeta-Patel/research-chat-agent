import { figures, near } from "@/lib/agent/citations";
import { tokenize } from "@/lib/util";

// "Show me where it says that." Given a claim from the answer and the text the
// agent read from the cited page, find the passage that backs the claim, mark
// the figures, and build a link that opens the real page scrolled to that
// passage — so a reader can verify the claim against the source in one click.
// Pure and deterministic; runs in the browser.

export interface Evidence {
  passage: string; // part of what the agent read
  marks: [number, number][]; // ranges in `passage` to highlight (the claim's figures)
  basis: "figure" | "words" | "none"; // how the passage was matched to the claim
  missing: string[]; // figures in the claim that are NOT in this source's text
  url: string; // the page, scrolled to the passage where the browser supports it
}

const WINDOW_BEFORE = 150;
const WINDOW_AFTER = 190;
// Characters that end a run of text we can expect to find verbatim on the page
// (our table-cell separator, markdown from rendered pages, snippet ellipses).
const BREAK = /[|*_#`[\]\n…]|\.{3}/;

/** A text-fragment link (#:~:text=…). Browsers that don't support it just open the page. */
function fragmentUrl(url: string, text: string, at: number, end: number): string {
  let from = at, to = end;
  while (from > 0 && at - from < 40 && !BREAK.test(text[from - 1])) from--;
  while (to < text.length && to - end < 40 && !BREAK.test(text[to])) to++;
  // Don't start or end in the middle of a word.
  if (from > 0 && /\S/.test(text[from - 1])) from += text.slice(from, at).search(/\s/) + 1 || at - from;
  if (to < text.length && /\S/.test(text[to])) to = end + Math.max(0, text.slice(end, to).lastIndexOf(" "));
  const quote = text.slice(from, to).replace(/\s+/g, " ").trim();
  if (quote.length < 4) return url;
  const [page, hash = ""] = url.split("#");
  return `${page}#${hash}:~:text=${encodeURIComponent(quote).replace(/-/g, "%2D")}`;
}

export function findEvidence(claim: string, sourceText: string, url: string): Evidence {
  // Money and percentages first: they are what a reader wants to check.
  const wanted = figures(claim).sort((a, b) => Number(b.important) - Number(a.important));
  // Every number in the source, with its position (and a currency sign just before it).
  const numbers = [...sourceText.matchAll(/(?:[$€£₹]\s?)?\d[\d,]*(?:\.\d+)?/g)].map((m) => ({
    at: m.index, end: m.index + m[0].length, value: parseFloat(m[0].replace(/[^\d.]/g, "")), money: /^\D/.test(m[0]),
  }));
  const hits = wanted.map((f) => {
    const same = numbers.filter((n) => near(n.value, f.value));
    // "$20" should match "$20" on the page, not the "20" in "20 seats" (and vice versa).
    const alike = same.filter((n) => n.money === /[$€£₹]/.test(f.raw));
    return alike.length ? alike : same;
  });
  const missing = wanted.filter((f, i) => f.important && !hits[i].length).map((f) => f.raw);
  const found = hits.flat();

  if (found.length) {
    // Anchor on the first figure; show the text around it and mark every figure in view.
    const anchor = hits.find((h) => h.length)![0];
    let from = Math.max(0, anchor.at - WINDOW_BEFORE);
    let to = Math.min(sourceText.length, anchor.end + WINDOW_AFTER);
    if (from > 0) from += sourceText.slice(from, anchor.at).search(/\s/) + 1;
    if (to < sourceText.length) to = anchor.end + Math.max(0, sourceText.slice(anchor.end, to).lastIndexOf(" "));
    const marks = found
      .filter((n) => n.at >= from && n.end <= to)
      .sort((a, b) => a.at - b.at)
      .map((n): [number, number] => [n.at - from, n.end - from]);
    return { passage: sourceText.slice(from, to), marks, basis: "figure", missing, url: fragmentUrl(url, sourceText, anchor.at, anchor.end) };
  }

  // No figure to anchor on: the line that shares the most words with the claim.
  const words = new Set(tokenize(claim).filter((w) => w.length > 2));
  let best = { score: 0, at: 0, line: "" };
  let at = 0;
  for (const line of sourceText.split("\n")) {
    const score = new Set(tokenize(line).filter((w) => words.has(w))).size;
    if (score > best.score) best = { score, at, line };
    at += line.length + 1;
  }
  if (best.score >= 2) {
    const head = best.line.slice(0, WINDOW_BEFORE + WINDOW_AFTER);
    return { passage: head, marks: [], basis: "words", missing, url: fragmentUrl(url, sourceText, best.at, best.at + Math.min(head.length, 25)) };
  }
  return { passage: sourceText.slice(0, 280), marks: [], basis: "none", missing, url };
}

/**
 * The part of the answer a citation vouches for: the text since the previous
 * citation on that line (or the start of its sentence). Returns the answer with
 * each "[S3]" turned into a link carrying an index into `claims`.
 */
export function linkCitations(answer: string): { markdown: string; claims: string[] } {
  const claims: string[] = [];
  const markdown = answer
    .split("\n")
    .map((line) => {
      const isRow = line.trim().startsWith("|");
      let last = 0;
      return line.replace(/\[((?:[SM]\d+)(?:\s*,\s*[SM]\d+)*)\]/g, (match, ids: string, offset: number) => {
        let claim = line.slice(last, offset);
        last = offset + match.length;
        if (!isRow) claim = claim.split(/(?<=[.!?])\s+/).pop() ?? claim;
        else if (!figures(claim).length) claim = line; // "| HubSpot [S1] | $20 | $90 |": the citation covers the row
        // "[S3][S5]" — the second one vouches for the same text as the first.
        if (/[a-z0-9]/i.test(claim) || !claims.length) claims.push(claim.trim());
        const n = claims.length - 1;
        return ids.split(/\s*,\s*/).map((id) => `[${id}](#cite-${id}-${n})`).join("");
      });
    })
    .join("\n");
  return { markdown, claims };
}
