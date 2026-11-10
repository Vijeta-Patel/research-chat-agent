import { connection } from "next/server";
import { conversationExists, deleteConversation, getMessages } from "@/lib/memory/db";


export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await ctx.params;
  if (!conversationExists(id)) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ messages: getMessages(id, true) });
}

// "Forget this conversation": removes the turns and their index entries.
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  deleteConversation(id);
  return Response.json({ ok: true });
}
