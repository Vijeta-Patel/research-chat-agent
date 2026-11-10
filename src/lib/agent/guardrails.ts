// Guardrails enforced in code (not just asked for in the prompt).
// All deterministic: no model calls, no added latency worth measuring.
//
//   threat                                  guardrail
//   ─────────────────────────────────────── ─────────────────────────────────────────────
//   secrets/PII leave via search queries    sanitizeQuery()        (#1)
//   web page tells the model what to do     neutralizeInjection()  (#2)
//   user pastes a key/password into chat    maskSecrets()          (#5)
//   model writes a URL we never retrieved   stripUnknownUrls()     (#7)
//   someone hammers the endpoint/the keys   rateLimit()            (#4)
// (#3 safety blocks, #4 turn budgets and #6 freshness live in run.ts;
//  #8 high-stakes topics is a prompt policy.)

type Kind = "email" | "phone" | "card" | "api key" | "password" | "private key" | "id number";

const SECRET_PATTERNS: { kind: Kind; re: RegExp }[] = [
  { kind: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  // Well-known key formats (OpenAI/Anthropic, Google, GitHub, Slack, AWS, Tavily, Stripe, JWT, bearer tokens).
  {
    kind: "api key",
    re: /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|AQ\.[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|tvly-[A-Za-z0-9_-]{10,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
  },
  { kind: "api key", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { kind: "password", re: /\b(pass(?:word|wd)?|pwd|secret|token|api[_ -]?key)\s*[:=]\s*\S{4,}/gi },
  { kind: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: "id number", re: /\b\d{3}-\d{2}-\d{4}\b/g }, // US SSN shape
];

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

// Card numbers (Luhn-valid 13–19 digits) and phone numbers (10–15 digits).
// Checked separately so prices, years and dates aren't caught.
function numberFindings(text: string): { kind: Kind; match: string }[] {
  const out: { kind: Kind; match: string }[] = [];
  for (const m of text.matchAll(/(?<![\w.$€£₹])\+?\d[\d ().-]{8,22}\d(?![\w%])/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) out.push({ kind: "card", match: m[0] });
    else if (digits.length >= 10 && digits.length <= 15 && !/^\d{4}-\d{2}-\d{2}/.test(m[0]) && /[\s+().-]|^\d{10,}$/.test(m[0]))
      out.push({ kind: "phone", match: m[0] });
  }
  return out;
}

function findings(text: string): { kind: Kind; match: string }[] {
  const out: { kind: Kind; match: string }[] = [];
  for (const { kind, re } of SECRET_PATTERNS) for (const m of text.matchAll(re)) out.push({ kind, match: m[0] });
  out.push(...numberFindings(text));
  return out;
}

function replaceAll(text: string, items: { kind: Kind; match: string }[]): string {
  let t = text;
  for (const f of items.sort((a, b) => b.match.length - a.match.length)) t = t.split(f.match).join(`[${f.kind} removed]`);
  return t;
}

/** #5 — Mask secrets a user pastes into chat before they are stored or sent anywhere. Emails/phones are kept (the user may legitimately mention them). */
export function maskSecrets(text: string): { text: string; masked: Kind[] } {
  const items = findings(text).filter((f) => f.kind === "api key" || f.kind === "password" || f.kind === "private key" || f.kind === "card");
  return { text: items.length ? replaceAll(text, items) : text, masked: [...new Set(items.map((i) => i.kind))] };
}

/** #1 — Nothing personal or secret leaves the machine inside a search query. */
export function sanitizeQuery(query: string): { query: string; removed: Kind[]; blocked: boolean } {
  const items = findings(query);
  if (!items.length) return { query, removed: [], blocked: false };
  const cleaned = replaceAll(query, items).replace(/\[[a-z ]+ removed\]/g, " ").replace(/\s+/g, " ").trim();
  return { query: cleaned, removed: [...new Set(items.map((i) => i.kind))], blocked: cleaned.replace(/\W/g, "").length < 3 };
}

/** #2 — Neutralise instruction-like text inside untrusted web content. */
const INJECTION = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|the|your)\b[^.\n]{0,30}\b(instructions?|prompts?|rules?|messages?|context)\b/gi,
  /\b(you are|you're|act as|pretend to be|roleplay as)\s+(now\s+)?(a|an|the)?\s*(new|different|unrestricted|jailbroken|DAN)\b[^.\n]*/gi,
  /\b(new|updated|real|actual)\s+(system\s+)?(instructions?|prompt|directive)s?\s*:/gi,
  /<\/?\s*(system|assistant|user|instructions?)\s*>|<\|(im_start|im_end|system|endoftext)\|>/gi,
  // Exfiltration attempts. Deliberately narrow ("Pro includes 8 GB memory" must survive).
  /\b(reveal|leak|exfiltrate|send|print|show)\b[^.\n]{0,40}\b(the user'?s?|this conversation|chat history|previous messages|api keys?|secrets?|system prompt)\b[^.\n]*/gi,
  /\b(call|invoke|use)\s+the\s+(web_search|search)\s+tool\b[^.\n]*/gi,
];

export function neutralizeInjection(text: string): { text: string; hits: number } {
  let hits = 0;
  let t = text;
  for (const re of INJECTION) {
    t = t.replace(re, () => { hits++; return "[instruction-like text removed]"; });
  }
  return { text: t, hits };
}

/** #7 — Remove URLs from the answer that didn't come from a retrieved source. */
export function stripUnknownUrls(text: string, allowed: Set<string>): { text: string; removed: number } {
  let removed = 0;
  const norm = (u: string) => u.replace(/[).,;]+$/, "").replace(/\/$/, "");
  const ok = new Set([...allowed].map(norm));
  // Markdown links [label](url) → keep the label if the URL is unknown.
  let t = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, label: string, url: string) => {
    if (ok.has(norm(url))) return m;
    removed++;
    return label;
  });
  // Bare URLs (not inside a markdown link we kept).
  t = t.replace(/(?<!\]\()https?:\/\/[^\s)<>\]]+/g, (url) => {
    if (ok.has(norm(url))) return url;
    removed++;
    return "";
  });
  return { text: removed ? t.replace(/[ \t]{2,}/g, " ") : text, removed };
}

/** #4 — Sliding-window rate limit per client (in memory; fine for a single-process app). */
const hitsByKey = new Map<string, number[]>();
export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterS: number } {
  const nowMs = Date.now();
  const recent = (hitsByKey.get(key) ?? []).filter((t) => nowMs - t < windowMs);
  if (recent.length >= limit) {
    hitsByKey.set(key, recent);
    return { ok: false, retryAfterS: Math.ceil((windowMs - (nowMs - recent[0])) / 1000) };
  }
  recent.push(nowMs);
  hitsByKey.set(key, recent);
  return { ok: true, retryAfterS: 0 };
}

/** #3 — Human explanation when Gemini's safety system blocks or cuts off a response. */
export function blockedExplanation(reason: string | undefined): string | null {
  switch (reason) {
    case "SAFETY":
    case "PROHIBITED_CONTENT":
    case "BLOCKLIST":
    case "JAILBREAK":
    case "MODEL_ARMOR":
      return "I can't help with that request — the model provider's safety system blocked it. If this seems wrong, try rephrasing what you need.";
    case "SPII":
      return "The response was blocked because it would have included sensitive personal information.";
    case "RECITATION":
      return "The response was stopped because it was reproducing copyrighted text too closely. Ask for a summary instead.";
    default:
      return null;
  }
}
