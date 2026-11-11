// Small shared helpers. Pure (no Node or browser APIs beyond URL/Intl/AbortSignal),
// so server code and client components use the same ones.

// ── URLs ────────────────────────────────────────────────────────────────────

/** "https://www.HubSpot.com/pricing" → "hubspot.com" */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url;
  }
}

// Query parameters that never change what the page says.
const NOISE_PARAM = /^(utm_\w+|gclid|fbclid|msclkid|mc_[ce]id|ref|ref_src|source|campaign|currency|lang|locale|hl)$/i;

/**
 * One identity per page: the key used to de-duplicate search hits AND to give a
 * page its [S#] id. Tracking/locale parameters are dropped (pricing?currency=EUR
 * is the same page); meaningful ones are kept (item?id=1 ≠ item?id=2).
 */
export function pageKey(url: string): string {
  try {
    const u = new URL(url);
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !NOISE_PARAM.test(k))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    return (domainOf(url) + u.pathname.replace(/\/$/, "") + (params ? `?${params}` : "")).toLowerCase();
  } catch {
    return url;
  }
}

// ── Text ────────────────────────────────────────────────────────────────────

/** Words that carry no meaning for matching, in page ranking or memory recall. */
export const STOP_WORDS = new Set(
  ("a an the and or but if then so of to in on at by for with about from into over under is are was were be been being " +
    "it its this that these those what which who whom how when where why do does did has have had can could should would " +
    "will shall may might must not no yes vs versus").split(" "),
);

/** Lower-cased content words; keeps things like "node.js", "c++", "gpt-4". */
export function tokenize(text: string, stop: Set<string> = STOP_WORDS): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9.+#-]*/g) ?? [])
    .map((w) => w.replace(/[.-]+$/, ""))
    .filter((w) => w.length > 1 && !stop.has(w));
}

/** Citation ids written in an answer: citedIds("… [S3][M1]", "S") → ["S3"]. */
export function citedIds(text: string, kind: "S" | "M" | "SM" = "SM"): string[] {
  return [...new Set(text.match(new RegExp(`\\b[${kind}]\\d+\\b`, "g")) ?? [])];
}

// ── Network ─────────────────────────────────────────────────────────────────

/** Abort after `ms`, or earlier if the caller's own signal fires. */
export function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

export const errorMessage = (err: unknown, max = 160): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, max);

// ── Dates (always shown in the user's time zone) ────────────────────────────

export function safeTimeZone(tz: string | undefined): string {
  try {
    if (tz) {
      new Intl.DateTimeFormat("en-GB", { timeZone: tz });
      return tz;
    }
  } catch {}
  return "UTC";
}

const DAY: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", year: "numeric" };
const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

/** "Tue, 3 Nov 2026" */
export const fmtDay = (d: Date | string, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { ...DAY, timeZone: tz }).format(new Date(d));

/** "Tue, 3 Nov 2026, 14:05" */
export const fmtDateTime = (d: Date | string, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { ...DAY, ...TIME, timeZone: tz }).format(new Date(d));

/** "Tuesday, 3 November 2026 at 14:05" — the "now" the model is told about. */
export const fmtLong = (d: Date | string, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { ...DAY, ...TIME, weekday: "long", month: "long", timeZone: tz }).format(new Date(d));
