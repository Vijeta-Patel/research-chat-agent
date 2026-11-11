import { complete } from "@/lib/llm/claude";
import type { Source } from "@/lib/types";
import {
  addClaim, claimKey, countMessages, getConversationMemory, getMessages, getProfile, knownClaimKeys, knownEntities, now,
  saveConversationMemory, undistilledConversations, upsertProfileFact,
} from "@/lib/memory/db";
import { readQuestion } from "@/lib/memory/query";
import { citedIds, errorMessage } from "@/lib/util";

// The memory WRITE path. After each turn (in the background, never delaying the
// answer) one cheap model call distils the exchange into structured memory:
//   - rolling conversation summary + topics + entities  → conversation_memory
//   - aliases: other words the user might use for it later (paid for at write
//     time, so recall needs no model call and no embeddings at read time)
//   - decisions made and questions left open            → conversation_memory
//   - claims: facts the answer stated AND cited          → claims (versioned)
//   - profile: stable facts the USER stated about self   → profile
//   - resolved: open items of EARLIER conversations that the user settled
//     in this one ("we went with HubSpot") → closed there, recorded as decided
// The model proposes; code validates (claims must cite a source the answer used).
// A turn whose distillation failed is caught up later (catchUp).

const SYSTEM = `You maintain the long-term memory of a research assistant. You receive one exchange (user message + assistant answer + the sources the answer cited) and the current memory. Return ONLY a JSON object:

{
  "summary": string,      // rolling summary of the WHOLE conversation so far, <= 70 words, past tense, include product names, dates and conclusions
  "topics": string[],     // 2-6 short GENERAL topics, including broad categories a user might later use vaguely (e.g. "managed databases", "database pricing", "crm software")
  "entities": string[],   // companies, products, people, places named (max 10)
  "aliases": string[],    // 4-10 OTHER words or short phrases the user might use months later to refer to this conversation WITHOUT its exact words: synonyms, broader and narrower categories, British/American spellings, casual descriptions (e.g. for a Postgres hosting chat: "database", "db hosting", "cloud database", "backend infrastructure", "where to host our data")
  "decisions": string[],  // what the USER decided or chose in the WHOLE conversation so far, each with what it was about ("chose Supabase Pro for hosting"); max 5; [] if none
  "open": string[],       // what is still unresolved in the WHOLE conversation: undecided choices, things the user said they'd come back to, checks the assistant could not complete; max 5; drop items that have since been settled; [] if none
  "claims": [             // facts the ANSWER stated that are backed by a cited source; max 12; [] if none
    { "entity": string, "attribute": string, "value": string, "source": "S3" }
  ],
  "profile": [            // stable facts the USER stated about themselves/their team/company; max 5; [] if none
    { "key": string, "value": string }
  ],
  "resolved": [           // open items listed under OPEN ITEMS IN EARLIER CONVERSATIONS that the USER settled in this exchange; [] if none
    { "conversation": "C1", "item": 1, "decision": string }   // decision: what the user decided, short, e.g. "chose HubSpot Sales Hub Professional after the demo"
  ]
}

Rules:
- claims: only checkable facts (prices, plan names, limits, dates, versions, launches). attribute is generic and reusable ("Pro plan price", "free tier", "latest release"). value is short and exact as stated ("$25/month"). source must be one of the given source IDs.
- profile: only what the user said about themselves (e.g. key "team size", value "20-person sales team"; key "location", value "India"). Never infer. Never include secrets.
- profile keys must be SPECIFIC ("moisturizer", "cleanser", "serum", "crm in use", "team size") — never generic keys like "current product" that different things would overwrite. When the user adds detail to something already in KNOWN PROFILE, return the SAME key with a MERGED value that keeps the earlier detail (e.g. "moisturizer": "Bioderma Atoderm (barrier repair cream), used ~2 years, worked well").
- claims need a concrete value: a number, price, date, version or name. Skip vague ones ("may be lower", "contact sales").
- claim entity = the company or brand as it is usually named ("Salesforce", "Supabase", "HubSpot"), never a plan or tier ("Pro Suite") and never the site that reported it. Plans and tiers go in the attribute ("Pro Suite price", "Launch plan price"). If the brand is in KNOWN ENTITIES, use that exact spelling.
- resolved: only when the USER, in this exchange, states the outcome ("we went with HubSpot", "we dropped Pipedrive", "I bought the MacBook"). Asking about an item ("which one did we pick?") does NOT resolve it. Never resolve on the assistant's suggestion.
- open items are the USER's unfinished business. An offer the assistant made ("I can look into that") is not an open item unless the user took it up.
- decisions and open describe the conversation as it stands now. You are given the current lists: keep items that still hold, add new ones, move an open item to decisions when the user settles it. Never invent a decision the user did not state.
- No markdown, no commentary — JSON only.`;

interface DistillInput {
  conversationId: string;
  messageId: string;
  at: Date; // when the answer was given — claims are "observed" then, not when distilled
  userText: string;
  answerText: string;
  citedSources: Source[];
  // The turn only looked back at earlier chats (no web search). Such a turn is
  // remembered as having happened, but it must not copy the decisions, open
  // items or facts it merely recalled into a second place (measured: asking
  // "which one did we pick?" duplicated the CRM chat's open items).
  recallOnly?: boolean;
  // Earlier conversations recalled for this turn that still have open items:
  // the user may settle one of them here.
  related?: { conversationId: string; title: string; createdAt: string; open: string[] }[];
}

export interface DistillOutcome { claims: number; profile: number; resolved: number; summary: boolean; ms: number }

function parseJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strList = (v: unknown, n: number, max: number) =>
  (Array.isArray(v) ? v : []).map((x) => str(x, max)).filter(Boolean).slice(0, n);

/**
 * Keep one name per company so value histories line up. "Supabase Pro" with
 * attribute "price" becomes "Supabase" · "Pro price" when "Supabase" is known.
 * (Measured: the same vendor was stored as "Supabase" and "Supabase Pro", and
 * Salesforce prices as "Pro Suite" with no company at all.)
 */
export function canonicalEntity(entity: string, attribute: string, known: string[]): { entity: string; attribute: string } {
  const e = claimKey(entity);
  for (const k of known) {
    const kk = claimKey(k);
    if (!kk || kk === e) return { entity: k, attribute };
    if (e.startsWith(kk + " ")) {
      const rest = entity.trim().slice(k.length).trim();
      return { entity: k, attribute: claimKey(attribute).includes(claimKey(rest)) ? attribute : `${rest} ${attribute}` };
    }
  }
  return { entity, attribute };
}

const inFlight = new Set<string>(); // conversations being distilled right now

export async function distillTurn(input: DistillInput): Promise<DistillOutcome> {
  inFlight.add(input.conversationId);
  try {
    return await distill(input);
  } finally {
    inFlight.delete(input.conversationId);
  }
}

async function distill(input: DistillInput): Promise<DistillOutcome> {
  const t0 = Date.now();
  const prev = getConversationMemory(input.conversationId);
  const profile = getProfile();
  const sourceList = input.citedSources.map((s) => `[${s.id}] ${s.title} — ${s.url}`).join("\n") || "(none)";
  // Existing fact names for the entities in this answer, so a restated fact
  // reuses the same entity/attribute and versions line up ("$19 → usage-based").
  const known = knownClaimKeys(`${input.userText}\n${input.answerText}`);
  const entities0 = knownEntities();
  const related = (input.related ?? []).filter((r) => r.open.length && r.conversationId !== input.conversationId).slice(0, 3);
  const relatedText = related
    .map((r, i) => `[C${i + 1}] "${r.title}" (${r.createdAt.slice(0, 10)}):\n${r.open.map((o, j) => `  ${j + 1}. ${o}`).join("\n")}`)
    .join("\n");
  const prompt =
    `CURRENT CONVERSATION SUMMARY: ${prev?.summary ?? "(new conversation)"}\n` +
    `CURRENT DECISIONS: ${prev?.decisions.join("; ") || "(none)"}\nCURRENTLY OPEN: ${prev?.open.join("; ") || "(none)"}\n` +
    `EXISTING FACT NAMES (reuse these exact entity and attribute strings when the same fact is restated, even if its value changed): ${known.join("; ") || "(none)"}\n` +
    `KNOWN ENTITIES: ${entities0.join(", ") || "(none)"}\n` +
    `KNOWN PROFILE: ${profile.map((p) => `${p.key}: ${p.value}`).join("; ") || "(empty)"}\n` +
    `OPEN ITEMS IN EARLIER CONVERSATIONS:\n${relatedText || "(none)"}\n\n` +
    `USER MESSAGE:\n${input.userText.slice(0, 3000)}\n\nASSISTANT ANSWER:\n${input.answerText.slice(0, 6000)}\n\nSOURCES CITED:\n${sourceList}`;

  const raw = parseJson(await complete(SYSTEM, prompt));
  if (!raw) return { claims: 0, profile: 0, resolved: 0, summary: false, ms: Date.now() - t0 };

  const at = input.at.toISOString();
  const summary = str(raw.summary, 700);
  const topics = strList(raw.topics, 6, 60);
  const entities = strList(raw.entities, 10, 60);
  if (summary) {
    saveConversationMemory({
      conversationId: input.conversationId,
      summary, topics, entities,
      aliases: strList(raw.aliases, 10, 60),
      decisions: input.recallOnly ? prev?.decisions ?? [] : strList(raw.decisions, 5, 160),
      open: input.recallOnly ? prev?.open ?? [] : strList(raw.open, 5, 160),
      messageCount: countMessages(input.conversationId),
      updatedAt: new Date().toISOString(),
    });
  }

  // Claims: validated against the sources the answer actually cited.
  const byId = new Map(input.citedSources.map((s) => [s.id, s]));
  let claims = 0;
  for (const c of Array.isArray(raw.claims) && !input.recallOnly ? raw.claims.slice(0, 12) : []) {
    const o = c as Record<string, unknown>;
    const value = str(o.value, 160);
    const { entity, attribute } = canonicalEntity(str(o.entity, 80), str(o.attribute, 80), entities0);
    const src = byId.get(str(o.source, 10).replace(/[[\]]/g, ""));
    if (!entity || !attribute || !value || !src) continue; // uncited → not a fact we keep
    if (addClaim({
      entity, attribute, value,
      sourceUrl: src.url, sourceTitle: src.title,
      observedAt: at, conversationId: input.conversationId, messageId: input.messageId,
    })) claims++;
  }

  // Profile: user-stated facts only; never anything secret-looking.
  let prof = 0;
  for (const p of Array.isArray(raw.profile) ? raw.profile.slice(0, 5) : []) {
    const o = p as Record<string, unknown>;
    const key = str(o.key, 40), value = str(o.value, 160);
    if (!key || !value || /removed\]|password|api key|token/i.test(value)) continue;
    upsertProfileFact(key, value, input.conversationId);
    prof++;
  }
  // Resolved: close the item in the conversation it belongs to, and record the
  // decision there, so that chat no longer reads as undecided.
  let resolved = 0;
  const closing = new Map<string, { remove: Set<number>; decide: string[] }>();
  for (const x of Array.isArray(raw.resolved) ? raw.resolved.slice(0, 5) : []) {
    const o = x as Record<string, unknown>;
    const conv = related[parseInt(str(o.conversation, 6).replace(/\D/g, ""), 10) - 1];
    const item = Number(o.item) - 1;
    const decision = str(o.decision, 160);
    if (!conv || !(item >= 0 && item < conv.open.length) || !decision) continue;
    const c = closing.get(conv.conversationId) ?? { remove: new Set(), decide: [] };
    c.remove.add(item);
    c.decide.push(`${decision} (said ${at.slice(0, 10)}, in a later chat)`);
    closing.set(conv.conversationId, c);
  }
  for (const [id, c] of closing) {
    const m = getConversationMemory(id);
    if (!m) continue;
    // Match by text, not position: the item list may have changed since recall.
    const items = related.find((r) => r.conversationId === id)!.open.filter((_, i) => c.remove.has(i));
    const open = m.open.filter((o) => !items.includes(o));
    saveConversationMemory({ ...m, open, decisions: [...m.decisions, ...c.decide].slice(-5) });
    resolved += m.open.length - open.length;
  }

  return { claims, profile: prof, resolved, summary: !!summary, ms: Date.now() - t0 };
}

const attempts = new Map<string, number>();

/**
 * Catch up memory that a failed or interrupted distillation left behind. The
 * raw transcript is always saved first, so nothing is lost — this rebuilds the
 * derived memory from it. Runs in the background after a turn; at most a few
 * exchanges per run, and at most two tries per conversation per process (a
 * reply that never parses mustn't cost a model call on every turn).
 */
export async function catchUp(excludeConversation?: string, maxExchanges = 3): Promise<number> {
  const quietSince = new Date(now().getTime() - 60_000).toISOString();
  const stale = undistilledConversations(excludeConversation, quietSince)
    .filter((c) => !inFlight.has(c.id) && (attempts.get(c.id) ?? 0) < 2);
  let done = 0;
  for (const c of stale) {
    if (done >= maxExchanges) break;
    attempts.set(c.id, (attempts.get(c.id) ?? 0) + 1);
    const msgs = getMessages(c.id);
    for (let i = c.covered; i < msgs.length - 1 && done < maxExchanges; i++) {
      const [u, a] = [msgs[i], msgs[i + 1]];
      if (u.role !== "user" || a.role !== "assistant") continue;
      const cited = new Set(citedIds(a.text, "S"));
      try {
        await distillTurn({
          conversationId: c.id, messageId: a.id, at: new Date(a.createdAt),
          userText: u.text, answerText: a.text,
          citedSources: a.sources.filter((s) => cited.has(s.id)),
          recallOnly: readQuestion(u.text, { tzOffsetMinutes: 0, timeZone: "UTC" }).aboutOurPast && !a.sources.length,
        });
      } catch (err) {
        console.warn(`[memory] catch-up failed for ${c.id}: ${errorMessage(err, 100)}`);
        break;
      }
      done++;
      i++;
    }
  }
  return done;
}

// Distillation runs in the background; tests/evals can wait for it.
const pending = new Set<Promise<unknown>>();
export function track(p: Promise<unknown>): void {
  pending.add(p);
  p.finally(() => pending.delete(p)).catch(() => {});
}
export async function waitForDistillation(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}
