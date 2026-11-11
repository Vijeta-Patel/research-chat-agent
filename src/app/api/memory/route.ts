import { connection } from "next/server";
import { claimKey, deleteFact, deleteProfileFact, getProfile, listFacts, recentConversations } from "@/lib/memory/db";

// "What do you remember about me?" — everything the agent has distilled, so the
// user can read it and delete any part of it. All of it lives in one local file.
export async function GET() {
  await connection(); // always run at request time (reads the local DB)
  // The facts ledger keeps every version; show each fact once, with its history oldest → newest.
  const facts = new Map<string, { entity: string; attribute: string; history: { value: string; observedAt: string; sourceUrl: string | null }[] }>();
  for (const c of listFacts().reverse()) {
    const key = `${claimKey(c.entity)}|${claimKey(c.attribute)}`;
    const f = facts.get(key) ?? { entity: c.entity, attribute: c.attribute, history: [] };
    f.history.push({ value: c.value, observedAt: c.observedAt, sourceUrl: c.sourceUrl });
    facts.set(key, f);
  }
  const threads = recentConversations(undefined, 60)
    .filter((c) => c.decisions.length || c.open.length)
    .map((c) => ({ conversationId: c.conversationId, title: c.title, createdAt: c.createdAt, decisions: c.decisions, open: c.open }));
  return Response.json({ profile: getProfile(), facts: [...facts.values()].reverse(), threads });
}

// Forget one thing: a profile fact, or a recorded fact with all its versions.
export async function DELETE(req: Request) {
  const body = (await req.json().catch(() => null)) as { kind?: string; key?: string; entity?: string; attribute?: string } | null;
  if (body?.kind === "profile" && body.key) deleteProfileFact(body.key);
  else if (body?.kind === "fact" && body.entity && body.attribute) deleteFact(body.entity, body.attribute);
  else return Response.json({ error: "nothing to forget" }, { status: 400 });
  return Response.json({ ok: true });
}
