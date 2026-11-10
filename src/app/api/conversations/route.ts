import { connection } from "next/server";
import { listConversations } from "@/lib/memory/db";

export async function GET() {
  await connection(); // always run at request time (reads the local DB)
  return Response.json({ conversations: listConversations() });
}
