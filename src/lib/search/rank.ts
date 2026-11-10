// Stage 4 of web_search: RANK — ours.
// A full page is too long to hand the model, and a provider snippet often misses
// the part that matters (the pricing table). Split the page into passages, score
// them against the query with BM25, boost passages that contain figures when the
// question is about prices/numbers, and keep the best few in page order.

const STOP = new Set(
  "a an the and or of to in on at by for with from is are was were be been it its this that these those what which who how when where why do does did has have had can will would should vs versus".split(" "),
);
const tokenize = (s: string) =>
  (s.toLowerCase().match(/[a-z0-9][a-z0-9.+#-]*/g) ?? []).map((w) => w.replace(/[.-]+$/, "")).filter((w) => w.length > 1 && !STOP.has(w));

const NUMERIC_Q = /\b(price|pricing|cost|costs|plan|plans|how much|fee|fees|rate|rates|per (seat|user|month)|limit|limits|percent|%|\d)\b/i;
const HAS_FIGURE = /[$€£₹]\s?\d|\d+(\.\d+)?\s?(%|\/mo|per|usd|eur|gb|tb)/i;

function passages(text: string, target = 700, max = 1100): string[] {
  const out: string[] = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if (line.length > max) {
      if (buf) { out.push(buf); buf = ""; }
      const sentences = line.split(/(?<=[.!?])\s+/);
      let chunk = "";
      for (const s of sentences) {
        if ((chunk + " " + s).length > max && chunk) { out.push(chunk); chunk = s; } else chunk = chunk ? `${chunk} ${s}` : s;
      }
      if (chunk) out.push(chunk);
      continue;
    }
    if ((buf + "\n" + line).length > target && buf) { out.push(buf); buf = line; } else buf = buf ? `${buf}\n${line}` : line;
  }
  if (buf) out.push(buf);
  return out;
}

/** Best passages of `text` for `query`, in original order, within `budget` characters. */
export function selectPassages(text: string, query: string, budget = 2400): string {
  const ps = passages(text);
  if (ps.join("\n").length <= budget) return ps.join("\n");
  const q = [...new Set(tokenize(query))];
  const docs = ps.map((p) => tokenize(p));
  const N = docs.length;
  const avg = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, N);
  const df = new Map(q.map((t) => [t, docs.filter((d) => d.includes(t)).length]));
  const k1 = 1.2, b = 0.75;
  const numeric = NUMERIC_Q.test(query);

  const scored = ps.map((p, i) => {
    const d = docs[i];
    let s = 0;
    for (const t of q) {
      const tf = d.filter((w) => w === t).length;
      if (!tf) continue;
      const idf = Math.log(1 + (N - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
      s += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / avg)));
    }
    if (numeric && HAS_FIGURE.test(p)) s += 1.5; // pricing tables, limits, dates
    if (i === 0) s += 0.3; // the intro usually frames the page
    return { i, s, len: p.length };
  });

  const chosen: number[] = [];
  let used = 0;
  for (const { i, len } of [...scored].sort((a, b2) => b2.s - a.s)) {
    if (used + len > budget) continue;
    chosen.push(i);
    used += len;
  }
  return chosen.sort((a, b2) => a - b2).map((i) => ps[i]).join("\n…\n");
}
