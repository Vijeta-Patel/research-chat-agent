/*
 * Memory recall test.  Run:  npm run eval:memory
 *
 * Seeds a throwaway database with 17 conversations, distils each one with the
 * real write path (the small model), then asks 20 questions the way a person
 * actually refers to old chats — mostly WITHOUT the words the chat used — and
 * checks which conversation recall selects. Recall itself makes no model call,
 * so this isolates the memory system from the answering model.
 *
 * The five target conversations are older than the "always in view" timeline
 * (12 newer chats sit on top), so a pass means the retrievers found it.
 * Writes eval/memory.md.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f);
const DB = join(tmpdir(), `agent-memory-probe-${Date.now()}.db`);
process.env.DB_PATH = DB;
process.env.AGENT_NOW = "2026-11-11T09:00:00Z"; // a Wednesday

type Turn = [user: string, assistant: string];
const TARGETS: { key: string; title: string; day: string; turns: Turn[] }[] = [
  { key: "postgres", title: "Managed Postgres hosting options", day: "2026-11-03T10:00:00Z", turns: [
    ["What are good managed Postgres hosting options for a small startup, and what do they cost?", "Good options: Neon (Launch plan about $19/month) [S1], Supabase (Pro $25/month) [S2], and AWS RDS (pay-as-you-go). For a small startup I'd start with Neon or Supabase."],
    ["ok let's go with Supabase for now", "Noted: Supabase Pro at $25/month [S2]. I can re-check pricing whenever you like."]] },
  { key: "f1", title: "Who won the Mexico City Grand Prix?", day: "2026-11-05T15:00:00Z", turns: [
    ["Who won the Mexico City Grand Prix?", "Lando Norris won the race from pole position."]] },
  { key: "skincare", title: "Barrier cream for dry skin", day: "2026-11-07T08:00:00Z", turns: [
    ["I've used a barrier repair cream for two years, is there something better for winter?", "Which cream are you using?"],
    ["Bioderma Atoderm", "Atoderm Intensive Baume is a richer option for winter."]] },
  { key: "crm", title: "CRM shortlist for a 20-person sales team", day: "2026-11-09T11:00:00Z", turns: [
    ["We're a 20-person sales team. Shortlist 5 CRM tools for us with pricing.", "Shortlist: HubSpot Sales Hub Professional ($100/seat/month) [S1], Pipedrive Growth ($39/seat/month) [S2], Salesforce Pro Suite ($100/user/month) [S3], Zoho CRM Professional ($23/user/month) [S4], Close Growth ($99/seat/month) [S5]."],
    ["thanks, we'll decide between HubSpot and Pipedrive after the demo on Friday", "Sounds good. Tell me how the demo goes and I'll re-check both prices before you commit."]] },
  { key: "laptop", title: "Lightweight laptop for travel", day: "2026-11-10T04:00:00Z", turns: [
    ["Recommend a lightweight laptop for travel under $1500", "MacBook Air 13 M4 ($1,099) or ThinkPad X1 Carbon Gen 13 ($1,449)."]] },
];
const FILLER: Turn[] = [
  ["How do I convert a list to a set in Python?", "Use set(my_list)."],
  ["Give me a recipe for dal tadka", "Cook toor dal, then temper with ghee, cumin, garlic and chilli."],
  ["What's the capital of Australia?", "Canberra."],
  ["Explain the difference between TCP and UDP", "TCP is reliable and ordered; UDP is faster with no delivery guarantee."],
  ["Suggest a 3-day itinerary for Jaipur", "Day 1 Amber Fort, day 2 City Palace and Hawa Mahal, day 3 Nahargarh."],
  ["How many calories are in a banana?", "About 105 in a medium banana."],
  ["Write a haiku about monsoon rain", "Grey clouds lean closer / the first drops drum on tin roofs / the street smells of earth."],
  ["What does idempotent mean in REST APIs?", "Repeating the request has the same effect as making it once."],
  ["Who wrote Midnight's Children?", "Salman Rushdie."],
  ["Help me write a polite reminder email about an unpaid invoice", "Subject: Friendly reminder — invoice 1042 is due."],
  ["What is the boiling point of water at altitude?", "It drops roughly 1 °C for every 300 m of elevation."],
  ["Tips for a first 10k run", "Build up slowly, run three times a week, keep most runs easy."],
];

// [question, the conversation it is about ("-" = none), why it is hard]
const QUESTIONS: [string, string, string][] = [
  ["On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?", "crm", "brief example"],
  ["What did I ask you on 3 November? Is your answer still correct today?", "postgres", "brief example: date only, no topic"],
  ["Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", "postgres", "brief example: 'last Tuesday' is ambiguous on a Wednesday"],
  ["Any update on those CRM tools?", "crm", "no past-tense cue"],
  ["that database thing — did it get cheaper?", "postgres", "vague, no product name"],
  ["which one did we go with in the end for hosting?", "postgres", "asks for a decision"],
  ["remind me what the plan was for the sales team software", "crm", "no 'CRM'"],
  ["Is it still $25?", "postgres", "only an amount"],
  ["anything new with the tools for my reps?", "crm", "synonym only"],
  ["how long have I been using that moisturiser?", "skincare", "synonym + British spelling"],
  ["what was the F1 result I asked about?", "f1", "category word only"],
  ["did you ever suggest a notebook computer to me?", "laptop", "synonym only"],
  ["where did we land on our backend data store?", "postgres", "paraphrase"],
  ["what's still undecided from our software purchasing chat?", "crm", "asks for an open item"],
  ["Is Pipedrive still the cheapest of the five?", "crm", "entity + implicit set"],
  ["my skin routine — what did you recommend for cold weather?", "skincare", "paraphrase"],
  ["what was I looking into at the start of last week?", "postgres", "date range only"],
  ["the race in Mexico — who came first?", "f1", "paraphrase"],
  ["What's the weather in Mumbai today?", "-", "control: nothing to recall"],
  ["How do I reverse a string in JavaScript?", "-", "control: nothing to recall"],
];

async function main() {
  const db = await import("@/lib/memory/db");
  const { distillTurn } = await import("@/lib/memory/distill");
  const { retrieveMemory } = await import("@/lib/memory/retrieve");
  const src = (n: number) => ({ id: `S${n}`, url: `https://example.com/${n}`, title: `Vendor pricing page ${n}`, domain: "example.com", tier: "official" as const, publishedDate: null, retrievedAt: "", excerpt: "", query: "" });

  const convs = [
    ...TARGETS,
    ...FILLER.map((t, i) => ({ key: `filler${i}`, title: t[0].slice(0, 60), day: new Date(Date.parse("2026-11-10T08:00:00Z") + i * 3_600_000).toISOString(), turns: [t] })),
  ];
  const title = new Map<string, string>();
  console.log(`Seeding and distilling ${convs.length} conversations (real write path)…`);
  let failed = 0;
  for (let i = 0; i < convs.length; i += 4) {
    await Promise.all(convs.slice(i, i + 4).map(async (c) => {
      const at = new Date(c.day);
      const id = db.createConversation(c.title, at);
      title.set(c.key, c.title);
      for (const [n, [user, answer]] of c.turns.entries()) {
        const when = new Date(at.getTime() + n * 120_000);
        db.addMessage({ conversationId: id, role: "user", text: user, at: when });
        const messageId = db.addMessage({ conversationId: id, role: "assistant", text: answer, at: new Date(when.getTime() + 40_000) });
        await distillTurn({ conversationId: id, messageId, at: when, userText: user, answerText: answer, citedSources: [1, 2, 3, 4, 5].filter((n) => answer.includes(`[S${n}]`)).map(src) })
          .catch((err) => { failed++; console.warn(`  distillation failed for "${c.title}": ${err instanceof Error ? err.message.slice(0, 100) : err}`); });
      }
    }));
  }

  const clock = { tzOffsetMinutes: 0, timeZone: "UTC" };
  const rows: string[] = [];
  let pass = 0, totalMs = 0;
  for (const [question, about, why] of QUESTIONS) {
    const t0 = performance.now();
    const { report, promptBlock } = await retrieveMemory(question, clock, { currentMessageCount: 0, historyWindow: 20 });
    const ms = performance.now() - t0;
    totalMs += ms;
    const rank = about === "-" ? -1 : report.recalled.indexOf(title.get(about)!);
    // Controls pass when recall selects none of the five target conversations.
    const ok = about === "-" ? !report.recalled.some((t) => TARGETS.some((x) => x.title === t)) : rank >= 0;
    pass += ok ? 1 : 0;
    const got = report.recalled.length ? report.recalled.map((t) => `"${t.slice(0, 28)}"`).join(", ") : "nothing";
    console.log(`${ok ? "✓" : "✗"} ${question}\n    → ${got}  (${ms.toFixed(1)} ms, ${promptBlock.length} chars)`);
    rows.push(`| ${question.replace(/\|/g, "/")} | ${why} | ${ok ? "✅" : "❌"} | ${about === "-" ? "–" : rank >= 0 ? `#${rank + 1}` : "missed"} | ${promptBlock.length} | ${ms.toFixed(1)} ms |`);
  }

  const mem = db.recentConversations(undefined, 40).filter((c) => TARGETS.some((t) => t.title === c.title));
  const report = [
    `# Memory recall test`,
    ``,
    `Run: ${new Date().toISOString()} · \`npm run eval:memory\``,
    ``,
    `**${pass}/${QUESTIONS.length} passed** · recall took ${(totalMs / QUESTIONS.length).toFixed(1)} ms per question on average (no model call) · ${failed} distillation failure(s)`,
    ``,
    `17 conversations are seeded and distilled by the real write path. The 5 target conversations are older than the 12 filler chats, so they are outside the always-in-view timeline: a pass means the retrievers found the right conversation in the whole history. "Rank" is its position among the conversations recall selected (top 3).`,
    ``,
    `| Question (asked in a new chat) | Why it is hard | Result | Rank | Memory block (chars) | Recall time |`,
    `|---|---|---|---|---|---|`,
    ...rows,
    ``,
    `## What the write path stored for the target conversations`,
    ...mem.map((c) => `\n**${c.title}**\n- Summary: ${c.summary}\n- Topics: ${c.topics.join(", ")}\n- Aliases: ${c.aliases.join(", ")}\n- Decided: ${c.decisions.join("; ") || "–"}\n- Left open: ${c.open.join("; ") || "–"}`),
    ``,
  ].join("\n");
  mkdirSync("eval", { recursive: true });
  writeFileSync("eval/memory.md", report);
  console.log(`\n${pass}/${QUESTIONS.length} passed — report written to eval/memory.md`);
  for (const ext of ["", "-wal", "-shm"]) rmSync(DB + ext, { force: true });
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
