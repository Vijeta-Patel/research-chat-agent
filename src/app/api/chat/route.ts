import { runTurn } from "@/lib/agent/run";
import { config, missingKeys } from "@/lib/config";
import { rateLimit } from "@/lib/agent/guardrails";
import type { AgentEvent } from "@/lib/types";


// Streams AgentEvents to the browser as Server-Sent Events.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    conversationId?: string;
    message?: string;
    tzOffsetMinutes?: number;
    timeZone?: string;
  } | null;

  // Guardrail #4: per-client rate limit protects the API keys and free-tier quotas.
  const client = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const rl = rateLimit(client, config.rateLimitPerMinute, 60_000);
  if (!rl.ok) {
    return Response.json(
      { error: `Too many messages — please wait ${rl.retryAfterS}s.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterS) } },
    );
  }

  const message = body?.message?.trim();
  if (!message) return Response.json({ error: "message is required" }, { status: 400 });
  if (message.length > 8000) return Response.json({ error: "message too long" }, { status: 413 });

  const missing = missingKeys();
  if (missing.length) {
    return Response.json(
      { error: `Missing ${missing.join(", ")}. Copy .env.example to .env.local, add the keys, and restart npm run dev.` },
      { status: 500 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: AgentEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          /* client went away */
        }
      };
      try {
        await runTurn({
          conversationId: body?.conversationId,
          message,
          clock: {
            tzOffsetMinutes: Number.isFinite(body?.tzOffsetMinutes) ? Number(body!.tzOffsetMinutes) : 0,
            timeZone: body?.timeZone || "UTC",
          },
          emit,
          signal: req.signal,
        });
      } catch (err) {
        emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
