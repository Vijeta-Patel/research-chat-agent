import { withTimeout } from "@/lib/util";

// JSON-over-POST with a bearer key and a hard timeout: the one way we call the
// bought services (Tavily and Firecrawl).

export class HttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function postJson(url: string, key: string, body: unknown, timeoutMs: number, signal?: AbortSignal) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: withTimeout(timeoutMs, signal),
  });
  if (!res.ok) throw new HttpError(`${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`, res.status);
  return res.json();
}
