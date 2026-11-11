import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { config } from "@/lib/config";
import { postJson } from "@/lib/search/http";
import { withTimeout } from "@/lib/util";

// Stages 2+3 of web_search: FETCH and READ — ours.
// Fetch the page ourselves and extract its main text with Mozilla Readability
// (the engine behind Firefox Reader View). If the page looks JavaScript-rendered
// (almost no text, or a pricing question but no prices in the text), render it
// with Firecrawl. If all of that fails, the caller falls back to the provider snippet.

const UA = "Mozilla/5.0 (compatible; research-chat/1.0; +https://github.com/Vijeta-Patel/research-chat-agent)";
const MAX_HTML = 3_000_000;
const PRICE_Q = /\b(price|pricing|cost|costs|plan|plans|per (seat|user|month)|subscription|tier)\b/i;
const HAS_PRICE = /[$€£₹]\s?\d|\d\s?(usd|eur|gbp)\b/i;

// Readability's HTML → readable plain text with line breaks between blocks and
// " | " between table cells (pricing tables survive as rows).
function htmlToText(html: string): string {
  const marked = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|table|ul|ol|blockquote|pre)>/gi, "\n")
    .replace(/<(td|th)[^>]*>/gi, " | ");
  const { document } = parseHTML(`<!doctype html><html><body>${marked}</body></html>`);
  return (document.body.textContent ?? "")
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function metaDate(html: string): string | null {
  const m =
    html.match(/<meta[^>]+(?:property|name|itemprop)=["'](?:article:published_time|article:modified_time|og:updated_time|datePublished|dateModified|date|pubdate)["'][^>]+content=["']([^"']+)["']/i) ??
    html.match(/"date(?:Published|Modified)"\s*:\s*"([^"]+)"/i);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function extract(html: string): { title: string; text: string; publishedDate: string | null } {
  const { document } = parseHTML(html);
  let text = "";
  let title = "";
  try {
    const article = new Readability(document as unknown as Document, { charThreshold: 200 }).parse();
    if (article?.content) text = htmlToText(article.content);
    title = article?.title ?? "";
  } catch {
    /* fall through to body text */
  }
  if (text.length < 200) {
    // Readability gave up (e.g. a pricing grid isn't "article-like"): use body text minus chrome.
    const { document: d2 } = parseHTML(html);
    d2.querySelectorAll("script,style,noscript,nav,footer,svg,iframe").forEach((n) => n.remove());
    text = htmlToText(d2.body?.innerHTML ?? "");
  }
  return { title, text, publishedDate: metaDate(html) };
}

export interface Fetched {
  text: string;
  publishedDate: string | null;
  blocked: boolean; // bot wall / rate limit — rendering may get through
  failure: string | null; // why we got no text: "HTTP 403", "timed out", "not HTML (application/pdf)"
  ms: number;
}

/** Fetch + extract with our own reader. Never throws. */
export async function fetchPage(url: string, signal?: AbortSignal): Promise<Fetched> {
  const t0 = Date.now();
  const failed = (failure: string, blocked = false): Fetched => ({ text: "", publishedDate: null, blocked, failure, ms: Date.now() - t0 });
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: withTimeout(config.pageFetchTimeoutMs, signal),
    });
    if (!res.ok) return failed(`HTTP ${res.status}`, [401, 403, 429, 503].includes(res.status));
    const type = res.headers.get("content-type") ?? "";
    if (!/html|xml/.test(type)) return failed(`not HTML (${type.split(";")[0] || "unknown type"})`);
    const out = extract((await res.text()).slice(0, MAX_HTML));
    return { text: out.text, publishedDate: out.publishedDate, blocked: false, failure: null, ms: Date.now() - t0 };
  } catch (err) {
    return failed(err instanceof Error && err.name === "TimeoutError" ? `timed out after ${config.pageFetchTimeoutMs / 1000}s` : "could not connect");
  }
}

/** Does this page probably need a JavaScript render to show its real content? */
export function needsRender(f: Fetched, query: string): boolean {
  return f.blocked || f.text.length < 800 || (PRICE_Q.test(query) && !HAS_PRICE.test(f.text));
}

/** Render via Firecrawl (JavaScript executed). Returns null if unavailable or failed. */
export async function renderPage(url: string, signal?: AbortSignal): Promise<string | null> {
  if (!config.firecrawlApiKey) return null;
  try {
    // maxAge: accept Firecrawl's cached render up to 1 day old — much faster, prices rarely change hourly.
    const json = await postJson(
      "https://api.firecrawl.dev/v2/scrape", config.firecrawlApiKey,
      { url, formats: ["markdown"], onlyMainContent: true, timeout: 12_000, maxAge: 86_400_000 },
      14_000, signal,
    );
    const md: string = json?.data?.markdown ?? "";
    // Light markdown cleanup: drop images and link targets, keep the text.
    return md.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim() || null;
  } catch {
    return null;
  }
}
