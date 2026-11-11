# Decision log

Every significant design decision, in the order it was made: the problem, the options, what was chosen, and the **evidence**. Where a decision was later reversed, both are kept, because the reversal is part of the reasoning. [`DESIGN.md`](../DESIGN.md) is the one-page summary; this is the full record.

**Contents**
1. [Reading the brief](#1-reading-the-brief)
2. [Agent architecture](#2-agent-architecture)
3. [Model provider](#3-model-provider)
4. [Web search](#4-web-search)
5. [Memory](#5-memory)
6. [Verification and citations](#6-verification-and-citations)
7. [Guardrails](#7-guardrails)
8. [Speed](#8-speed)
9. [Observability](#9-observability)
10. [Storage and stack](#10-storage-and-stack)
11. [Evaluation](#11-evaluation)
12. [Bugs found and fixed](#12-bugs-found-and-fixed)
13. [How the design evolved](#13-how-the-design-evolved)

---

## 1. Reading the brief

**D1. The example questions are about memory + dates + freshness, and each hides a trap.**
"What did I ask you on 3 November? Is it still correct?" needs (a) persistent, dated memory, (b) relative-date resolution in the user's timezone, (c) re-verification against the live web. The trap: graders may ask about a conversation that **never happened**. An agent that invents one fails the most important honesty test. Everything in §5 is designed around this.

**D2. Don't overfit to the three examples.** The dataset also contains plain facts, comparisons, follow-ups, false premises, no-search questions (maths, chit-chat) and ambiguous questions. The design has to handle all of them; the test suite (§11) covers each kind.

**D3. Priorities, in the brief's own terms.** *Gets things right* > *answers fast* > features. Correctness mechanisms are in code, not just in the prompt (§6, §7); speed changes are made from measurements (§8).

---

## 2. Agent architecture

**D4. Our harness, a pluggable inner loop.** `src/lib/agent/run.ts` owns the whole turn: secret masking → memory recall → model loop → checks → persistence → background distillation. The model provider only runs the model ⇄ `web_search` loop, behind a small `Provider` interface (`src/lib/llm/`).
- *Rejected:* LangChain / LangGraph / Vercel AI SDK. The loop and the harness are what's being judged; owning them means every line can be explained.

**D5. Exactly one model-facing tool: `web_search`.** Everything else (memory, checks, guardrails) runs in code around the model.
- *Rejected:* a `recall_memory` tool. It breaks the brief, adds a model round-trip per turn, and makes recall depend on the model choosing to call it.

**D6. Memory is retrieved *before* the model runs** and injected as a `<memory>` block. Faster (no extra round-trip), gives the same result every time, and keeps one tool.

**D7. No separate planner model.** First planned (a cheap model to decide memory/search needs). Dropped when free-tier quotas made every call expensive. Date parsing and the "is this about our past?" check proved to be deterministic code jobs, with no LLM needed.

---

## 3. Model provider

**D8. First build on Gemini (free tier).** No Anthropic API key was available.
- *Measured problems:* repeated 503 "high demand" errors. An overloaded model took **10.8 s just to fail**. The SDK's built-in retry (5 attempts, exponential backoff) made one answer take **167 s**. Then the daily quota ran out.
- *Fixes made at the time (removed with the Gemini path, D43):* SDK retries off; our own fallback chain (3.6 Flash → 3.5 Flash-Lite → 3.8 Flash); a per-model circuit breaker (429 → 60 s cool-down, 503 → 5 min); a 15 s connection deadline.

**D9. Default provider: Claude Sonnet 5.5 via the Claude Agent SDK.** It runs with `ANTHROPIC_API_KEY`, or with a local Claude Code login for development.
- **Configured down to the brief:** `tools: []` (every built-in tool off: no shell, no files, no built-in web); our `web_search` is the only tool (an in-process MCP tool whose handler is our guarded search); `settingSources: []`; `persistSession: false` (our SQLite store is the only memory); `cwd` set to a temp directory.
- *Rejected:* the SDK's built-in WebSearch/WebFetch. Two tools instead of one; no date filters, source tiers or guardrails; our citation checker couldn't see the page text.
- *Measured:* effort `low` vs `medium` made no measurable latency difference (16.0 s vs 15.2 s on the same question), so `medium` stayed.

**D10. Gemini stayed available for a while** (`LLM_PROVIDER=gemini`), with the same harness and tool on both. *Superseded by D43.*

**D11. A cheap model for memory distillation** (Claude Haiku 5.5). It runs once per turn, in the background, so cost and latency don't touch the answer.

---

## 4. Web search

**D12. "Plain Tavily" and "our own search" are both just a tool call. The difference is who implements the stages inside it.**

| Stage inside `web_search` | Search API as the whole tool | Ours |
|---|---|---|
| 1. Discover URLs | vendor | vendor (swappable chain), **the only bought step** |
| 2. Fetch pages | vendor | ours |
| 3. Read / extract (incl. JS-rendered pages) | vendor | ours |
| 4. Rank passages | vendor | ours |
| 5. Shape for the model (IDs, dates, tiers) | ours | ours |
| 6. Guardrails | ours | ours |

Nobody builds web search fully from scratch without an index. Crawling the web isn't feasible, so discovery is the one stage worth buying.

**D13. Why we built stages 2–4: measured failure.** With Tavily snippets (~500 characters), the model quoted Pipedrive prices that **weren't in the cited text**. The pricing table wasn't in the snippet, and the citation checker caught it (§6). Owning page reading fixes the cause, not just the symptom.

**D14. Discovery: Tavily → Firecrawl**, called directly, each with a circuit breaker (2 min after a failure, 60 s after a 429, 1 h after auth or credit errors), plus a 10-minute cache.
- *Verified:* with Tavily's key deliberately broken, search failed over to Firecrawl and the breaker skipped Tavily on the next search.

| Option | Decision | Why |
|---|---|---|
| Tavily | Discovery #1 | Free 1,000 credits/month, no card. `basic` depth is enough because we read pages ourselves. |
| Firecrawl | Discovery #2 + JS renderer | Free 1,000 credits/month. Its real strength is rendering JavaScript pages. |
| Brave Search API | Optional #3 | An independent index with good date filters, but needs a card. |
| treg.to | **Rejected** | A gateway reselling other providers; $1 one-time credit; its docs contradict themselves on failover. Failover is what we should design ourselves. |
| DuckDuckGo results scraping | **Rejected** | Not an API; rate limits and block pages; grey area under its terms. |
| Headless browser on Google/Bing results | **Rejected** | Against terms of service, CAPTCHAs, 3–10 s per page, heavy install for graders. |
| Bing Search API / Google Custom Search | Not available | Bing retired Aug 2025; Google's closed to new customers. |
| SearXNG | Rejected as default | Graders would need Docker. |
| Own crawler/index | Rejected | Not feasible. |
| Wikidata → official site → sitemap/RSS | Deferred | Great for "what shipped since Monday" (dated changelogs); the most work. |

**D15. Reader:** our own `fetch` (4.5 s timeout, 3 MB cap, an honest User-Agent naming the project) → **Mozilla Readability on linkedom** → block-aware text, with pricing-table cells kept as rows. If Readability gives up (pricing grids aren't "article-like"), we fall back to the body text minus nav/footer.
- *Rejected:* jsdom (heavier); Tavily `include_raw_content` (their extraction again, a black box).

**D16. Rendering JS pages:** a page is a candidate if it was blocked, has very little text, or the question is about prices and the text has none. Renders go through Firecrawl (max 2 per search, official sources only), **prioritised by need**.
- *Measured bug:* renders first went out in result order, so a support article took the slot and `/pricing` stayed a snippet. Now candidates are ranked by URL match to the question.
- *Measured win:* HubSpot's pricing page only shows prices after JavaScript runs; rendered, its real tiers reached the model.

**D17. Ranking:** passages of ~700 characters, BM25 against the query, a boost for passages with figures on numeric questions, best ~2,400 characters per page, kept in page order. URLs are deduplicated by host + path (the same pricing page under `?currency=EUR` was being read twice).

**D18. Source reliability tiers in code:** official / primary / news / community / roundup. Prices must come from official sources; when a search returns none, the tool result tells the model to search the vendor's own domain.

---

## 5. Memory

**D19. Four memory types, one write path, one read path.**

| Type | Table | Written by | Serves |
|---|---|---|---|
| Episodic transcripts | `messages` + full-text index | every turn | exact wording: "what did I ask on 3 Nov?" |
| Conversation summary + topics + entities | `conversation_memory` | distil step | vague recall; long chats whose start left the 20-message window |
| Facts ledger, **versioned, never overwritten** | `claims` | distil step, only facts the answer cited | "what changed?" as a diff: `$19/month (3 Nov) → usage-based (10 Nov)` |
| User profile | `profile` | distil step, only what the user said about themselves | cross-session context without keyword luck |

**D20. Write path = background distillation.** After each answer, one cheap model call returns JSON; the code validates it (claims must cite a source the answer actually used; secrets are never stored). Existing fact names are passed in, so a restated fact becomes a new version of the same fact (*measured bug:* it had been stored under two different names, so there was no history). Facts are stamped with the time of the answer, not the time of distillation.

**D21. Read path = hybrid recall** (extended by D48) over four retrievers, merged by reciprocal rank fusion, filling a **fixed budget** (~3.5k tokens) most reliable first: profile → (long chats) earlier-in-this-chat summary → exact date hits → facts with value history → summaries → raw excerpts. The prompt stays the same size at 10 conversations or 10,000.

**D22. Dates only trigger a memory lookup when the message is about *our* past** ("I asked…", "you told me…"). "News from last month" is a search filter, not memory. Decision verbs (pick, choose, compare) only count in the past tense: *measured bug*, "which CRM should we **pick**?" had been treated as a question about the past.

**D23. The memory block always says what was searched and what was found, including "nothing on 5 Nov",** plus a compact index of the conversations that do exist (with topics). That's how the agent says "I don't have that — did you mean the 3 Nov Postgres chat?" instead of inventing one. Test-verified.

**D24. Vectors were measured, not assumed.** 3 distilled summaries, 4 vague questions:

| Embedding model | "that database thing" (should be Postgres) | Decision |
|---|---|---|
| Local all-MiniLM-L6-v2 | postgres 0.22 · **crm 0.24** · f1 0.10 → wrong | Rejected |
| Local bge-small-en-v1.5 | postgres 0.55 · crm 0.56 · **f1 0.62** → wrong | Rejected |
| Hosted gemini-embedding-001 | **postgres 0.66** · crm 0.65 → right by a hair | Was optional at half weight; removed with Gemini (D43) |

Fuzzy recall mainly comes from **distilled general topics** ("managed databases") + stemmed full-text search: exact, instant, no extra key. *Rejected:* local embeddings (wrong answers + 25–130 MB download + 5–6 s cold start); a vector database (overkill at this scale).

**D25. Recalled messages come with their neighbours.** *Measured in real use:* a user stated a product's duration ("a cream for two years") and named the product in the *next* message. Recall returned only the message naming the product, so a later chat missed the duration. Each keyword hit now brings 2 messages before and 1 after from its conversation.

**D26. Profile keys are specific and merge.** *Measured:* a generic key (`current product`) was overwritten by the next product mentioned, losing the duration. Keys are now specific (`moisturizer`, `serum`, `cleanser`), and new detail is merged into the existing value.

**D27. Old answers aren't evidence for current facts.** For questions not about the past, raw recall is limited to the user's own earlier messages (their needs), never old answers verbatim. (Since D48, dated summaries and recorded facts are always available; the prompt rule and the freshness check stop them being presented as current.) *Measured:* the model had cited its own earlier answer as the source for a current price.

**D47. Memory first, enforced in code.** A question about our past must not be answered before memory has been looked through.
- *Structure:* recall runs before the model on every message; the model has no way to answer ahead of it. The UI prints "memory checked first · N earlier chats · recalled …" above the search log.
- *Check:* when the message is about our past and the draft cites no memory record and doesn't say there is none, one repair pass re-sends the memory block and requires `[M#]` citations or a plain "no record".
- *Rejected:* a `recall_memory` tool the model may or may not call (breaks the one-tool brief, and "may not call" is exactly the failure this rule exists to prevent).

**D48. Recall no longer depends on the user saying the right words.** *Measured before:* 16 probe questions against 5 seeded chats: 11 found the right conversation, 6 of those only as the user's old message with no recorded facts, and "that database thing", "Is it still $25?", "my last three conversations" and "that moisturiser" found nothing. Cause: summaries and facts were only retrieved when a regex saw phrases like "I asked".
- *Always in view:* the profile plus a timeline of the 6 most recent conversations (summary, decided, left open), relevant or not. The answering model does the fuzzy matching itself, at no extra call. A chat that hasn't been distilled yet still appears, from its raw first message.
- *All retrievers run on every message:* dates, keywords, topics, and a new one over the facts ledger that also matches money amounts ("$25").
- *Aliases at write time:* the distiller adds 4–10 other words a person might use later (synonyms, broader categories, British/American spellings). They go into the full-text index. This is document-side expansion: the semantic work is paid once, in the background, instead of an embedding or model call on every question.
- *Precision:* only conversations scoring ≥ 60% of the best fused score are selected (max 3); a date plus a topic keeps only that day's chats about the topic (*measured:* one busy day put 12 unrelated chats in the block).
- *"Last Tuesday" on a Wednesday* can mean yesterday or eight days ago. Both are searched and the block says so.
- *Rejected:* a small-model "router" call before every answer (adds a model round-trip to every message; the timeline + aliases reached 20/20 without it); bringing embeddings back (D24, D43).
- *Result:* `npm run eval:memory` — 17 chats distilled by the real write path, targets pushed outside the timeline, 20 questions: **20/20**, ~9 ms per recall. Report: `eval/memory.md`.
- *Limit, stated plainly:* 20 hand-written questions over 17 chats is a regression test, not a benchmark; the timeline costs ~1k tokens on every message.

**D49. Decisions and open items are memory too.** The distiller keeps two short lists per conversation, updated each turn: what the user decided, and what is still unresolved. Recall shows them with the conversation; the prompt tells the model to pick an open thread up when the user returns to that topic, and not otherwise.
- *Measured in the running app:* after "we'll decide between HubSpot and Pipedrive after Friday's demo", a new chat asking "which one did we go with for the sales software?" answered "You haven't picked one yet", cited both records, and listed what was still open. No search, 10 s.
- *Bug found by that test:* the recall question itself was distilled and copied the CRM chat's open items into a second conversation. *Fix:* a turn that only looked back (about our past, no search) is remembered as having happened but adds no decisions, open items or facts.

**D50. Memory you can read and delete.** The drawer lists the profile, open items, decisions and every tracked fact with its value history; each can be forgotten (`/api/memory`). Everything is one local SQLite file.

**D51. A later chat can settle an earlier chat's open item.** *Gap:* only the current conversation's notes were ever updated, so after "we went with HubSpot" in a new chat, the CRM chat still read "choose between HubSpot and Pipedrive". *Fix:* the open items of the chats recall brought in are given to the same background distillation call (no extra model call); it returns which ones the user settled, and code closes them in their own conversation and records the decision there ("… said 11 Nov, in a later chat"). Only the user stating an outcome counts: asking "which one did we pick?" closes nothing. *Tested:* both cases, in `eval:memory`.

**D52. One name per company in the facts ledger.** *Measured in the drawer:* the same vendor stored as "Supabase" and "Supabase Pro", and Salesforce prices as "Pro Suite" with no company, so value histories split and never lined up. *Fix:* the distiller gets the entity names already on record and a rule (entity = the brand; plans go in the attribute), and code folds "Supabase Pro" + "price" into "Supabase" · "Pro price" when "Supabase" is known. *Tested:* every stored entity is a brand name.

**D53. Missed memory writes are caught up.** *Gap:* if a background distillation failed or the app stopped mid-write, that turn never got a summary, aliases or decisions. *Fix:* after each turn, conversations whose notes are behind their transcript (and quiet for a minute, so an in-flight write isn't doubled) are distilled from the saved transcript, at most 3 exchanges per turn and 2 tries per conversation per process. *Tested:* a never-distilled chat is caught up and then recalled from a question with none of its words.

**D54. The profile keeps its history and has no cap.** *Gaps:* only the 12 most recent profile facts reached the model (the rest silently dropped); a changed value replaced the old one; forgetting a conversation deleted any profile key it had last touched, including what earlier chats said. *Fix:* every value is a version with the conversation that said it (`profile_history`); the current value is the latest version; the model sees "(earlier: …)"; forgetting a conversation removes only its versions, so the key falls back to what was said before. The profile has a 2,000-character share of the memory block, and anything beyond it is named as left out, never cut silently. *Tested:* Pune → Bengaluru keeps "Pune" as earlier; forgetting the "Bengaluru" chat brings back Pune; 18 facts all reach the model.

**D28. "Forget this conversation" removes everything derived from it:** transcript, index, summary, facts, the profile facts it contributed, and its turn ledger rows.

---

## 6. Verification and citations

**D29. Citations are a hard requirement, enforced in code.** Search results get conversation-wide IDs (`[S3]`), memory records get `[M1]`; the model never writes URLs. UI hover shows the source's tier, date and the passage it read.
- *Rejected:* prompt-only citations (models invent links and misattribute numbers; measured).

**D30. A deterministic checker after every answer:** every cited ID must exist; every figure must appear in the text of the source it cites. Calculations are allowed: a figure counts as supported if it can be derived from cited figures (× ÷ by numbers in the same sentence, e.g. seats or 12 months; + − only between two supported figures). Citations in a table header apply to its rows.
- *Measured bug:* table headers and "20 × $39 = $780" were false alarms; fixed by this rule.

**D31. One repair pass when the check fails.** The model gets the exact problems plus the cited sources' text; the revision is kept only if it has fewer problems. Costs a call only when needed.
- *Rejected:* an LLM judge on every turn (latency and cost; the checker catches the common failure for free).

**D32. "Is it still correct?" answers have a required shape:** per item, Then [memory] / Now [source] / Changed · Unchanged · Couldn't verify, plus a verdict. *Measured:* before this, a model wrote "still correct" when a price model had changed.

---

## 7. Guardrails

All in code (`src/lib/agent/guardrails.ts`) unless marked *prompt*.

| # | Threat | Guardrail |
|---|---|---|
| 1 | Personal data or secrets leaving via a search query (including a poisoned page telling the model to "search for the user's messages") | Emails, phones, cards (Luhn-checked), keys and passwords are stripped from queries; a query made only of such data isn't sent |
| 2 | Prompt injection from web pages | Instruction-like passages are neutralised before the model sees them; results are labelled `untrusted_page_text`; hits are logged. Patterns are deliberately narrow ("includes 8 GB memory" survives) |
| 3 | Provider safety block → empty answer | Block reason detected and explained in plain words |
| 4 | Runaway cost / abuse of keys | ≤6 searches and ≤4 rounds per turn; 45 s soft time budget; 12 messages/min per client |
| 5 | User pastes a secret into chat | Masked before it's stored, searched or sent; user told to rotate it |
| 6 | Stale "facts" from training data | A no-search answer stating uncited prices triggers one verification pass with search. *Measured:* it first fired on maths ("17%") and dates; now only uncited money triggers it |
| 7 | Made-up links | URLs not among retrieved sources are stripped |
| 8 | High-stakes topics | Authoritative sources, stated uncertainty, a short "see a professional" line (*prompt*) |

*Rejected:* a moderation model per turn (the provider already filters; latency); topic blocklists (they make a general assistant worse to talk to).

---

## 8. Speed

**D33. Every speed change was made from per-turn traces** (each model call, search, render and repair is timed).

| Finding | Change | Result |
|---|---|---|
| SDK retry/backoff stacked under ours | SDK retries off | 167 s → 17 s on an overloaded model |
| Overloaded model took 10.8 s to fail | fallback chain + circuit breaker | later turns skip it immediately |
| Answers ~700 words | length rule: one table + short recommendation | ~57 s → ~24 s on a comparison |
| Memory-only questions ran unrequested searches | prompt: answer from memory unless asked if still true | 46.5 s → 5.5 s |
| Freshness check fired on maths | money-only trigger | −5–9 s on those turns |
| Thinking effort low vs medium | no measurable difference | kept `medium` |

**D34. An accepted trade-off:** reading full pages raised median time-to-first-word on search questions (≈3 s → ≈10 s) in exchange for evidence the checker can verify. The UI shows each stage while it waits (pixel-cat loaders: checking memory / searching / reading N pages).

---

## 9. Observability

**D35. A turn ledger** (`turns` table): every answer's provider, model, timezone, total and first-word time, searches, revision flag, notices and full step trace, including the background distillation outcome. It used to be printed to the console and lost.

**D43. One model layer: Gemini removed.** Anyone running the project needs only `ANTHROPIC_API_KEY` (or a local Claude Code login).
- *Why:* a second provider meant a `Provider` interface with two implementations, two fallback strategies, provider-specific safety handling and doubled eval runs — for a path nobody would grade. The interface is gone; `llm/claude.ts` exports `generate` and `complete`.
- *Cost, stated plainly:* the optional vector retriever used Gemini embeddings, so it went too. Recall is now three retrievers (dates, keywords, distilled topics). Vague-wording recall is the next piece of work.

**D44. Shared helpers instead of copies** (`lib/util.ts`). Before: URL normalising in three places, two stop-word lists and tokenisers, three hand-rolled timeout signals, the cited-ID regex in four files, source tiers computed twice per result, tool-argument validation split across two files.
- *A real bug this removed:* search hits were de-duplicated by a normalised URL but numbered `[S#]` by the raw URL, so one page could get two IDs. Both now use one `pageKey()`.
- *A second one:* the old key dropped the whole query string, so `item?id=1` and `item?id=2` counted as one page. `pageKey()` drops only tracking/locale parameters.
- `run.ts` went from 379 lines to a ~150-line spine; the search tool lives in `search/tool.ts`, the post-answer checks in `agent/verify.ts`.

**D45. Search you can watch.** The pipeline reports each step: the URLs discovery returned, then per page `fetching → read in full | rendering → rendered | snippet only`, with the time taken and the reason ("HTTP 403", "timed out", "almost no readable text (JavaScript page)", "not opened — only the top 5 are read"). The same log stays under the answer, rebuilt from the stored sources.
- *Rejected:* a generic "searching…" spinner (the old UI) — it hides exactly the part a reviewer wants to judge.

**D46. Citations you can verify in one click.** For each citation the UI takes the text it vouches for, finds that figure (or, with no figure, the best-matching line) in the text the agent read, and shows the passage with the figure highlighted. The citation links to the page with a text fragment (`#:~:text=…`) so the browser scrolls to the passage.
- Figures that are not in the cited text are named in the popup — the same rule the citation checker enforces, made visible.
- *Limit, stated plainly:* text-fragment links depend on the browser and on the page still containing those words; when they don't match, the page simply opens at the top.

**D36. "How I got this"** under each answer renders that ledger, so a reviewer sees the architecture working while they chat: memory used, pages read in full vs. rendered vs. snippet, each step with its timing, guardrail hits and repairs.

---

## 10. Storage and stack

**D37. Node's built-in `node:sqlite`** (with FTS5 full-text search). *Rejected:* `better-sqlite3` (a native build that can fail on `npm install`), Postgres (an external service for graders), JSON files (no queries or full-text search).

**D38. Next.js single app**, with a hand-written SSE stream. `npm run dev` is one process. Under Next 16's Cache Components, API routes call `connection()` to always run at request time.

**D39. Keys live only in `.env.local` and only on the server**, read once in `src/lib/config.ts`. Nothing is prefixed `NEXT_PUBLIC_`; client components never import config.

---

## 11. Evaluation

**D40. Our own end-to-end suite (`npm run eval`), 14 cases** with real model, real search and a seeded throwaway database. Assertions check *behaviour* (recall, honesty, citing, official sources, guardrails), not exact facts, because the web changes. Cases:
- memory recall
- "still correct?"
- vague recall
- profile across sessions
- never happened
- cold CRM shortlist
- maths
- current price
- false premise
- news
- follow-up
- JS-rendered pricing page
- secret masking
- search failover

**D41. Honest results.**
- Claude: the first 10 of 14 passed before the subscription usage limit cut the run.
- The blocked cases + vague recall then passed **5/5 on Gemini** through the same harness (before Gemini was removed, D43).
- Earlier full runs: 12/12 and 10/10.
- The first-ever run scored 6/10 because the script didn't load `.env.local` and every search returned 401. Even then, the agent said search was unavailable instead of guessing.

**D42. Public benchmarks considered:** LongMemEval (temporal reasoning, abstention), FreshQA (fast-changing facts, false premises), SimpleQA, FRAMES, BrowseComp. *Deferred:* samples would cost a lot of free-tier quota, and none tests the brief's exact pattern ("recall my past answer, then re-check it against the live web"), which is what our own cases target.

---

## 12. Bugs found and fixed

Each was found from evidence (traces, the checker, stored data), not guessed.

| What broke | Evidence | Fix |
|---|---|---|
| One answer took 167 s | trace: SDK retried 5× with backoff | SDK retries off; own fallback + breaker |
| Made-up Pipedrive prices | checker: figures not in cited text | repair pass; then our own page reader |
| Small model sent a list as the query → HTTP 422 | trace | tool arguments validated and repaired |
| Pricing tables missing from snippets | `/pricing` read as snippet only | fetch + Readability + prioritised rendering |
| Render slot went to the wrong page | stats per search | candidates ranked by URL match |
| Same page read twice | results list | dedupe by host + path |
| Checker false alarms on tables and calculations | checker output | header citations + derivation rule |
| Freshness check fired on maths | trace | money-only trigger |
| Model cited its own old answer for a current price | answer text | memory isn't evidence for current facts |
| Facts stamped at distil time; same fact under two names | memory test | answer time; reuse existing fact names |
| "Which CRM should we pick?" treated as past | memory test | decision verbs past-tense only |
| Vague recall took 46.5 s | eval trace | memory-only questions don't search |
| Distillation crashed the eval on one 503 | eval log | model fallback in the distillation call |
| A stated duration missed in a new chat | stored `memory_json` + profile table | neighbour messages; specific merged profile keys |
| "From 2 years" parsed as "2 o'clock today" → 21 noisy memory records | date parser on the exact message | memory dates must name a day (21 → 9 records) |
| Generic words ("use") matched unrelated chats | keyword list | verb/filler stop-words (5 → 3 relevant records) |
| Eval script failed every search with 401 | eval log | load `.env.local` outside Next.js |
| Recall questions without a past-tense cue found no summaries or facts | 16-question probe: 11/16, 6 without facts | all retrievers always on; timeline; aliases (D48) |
| One busy day put 12 unrelated chats in the memory block | `eval:memory` output for "last Tuesday…" | date hits limited to the topic named |
| "moisturiser" missed a chat stored as "moisturizer" (19/20) | `eval:memory`: stored aliases vs the question | British ↔ American spelling variants in the search query (20/20) |
| A recall question duplicated another chat's open items | memory drawer after a live test | recall-only turns add no decisions, open items or facts |
| "$25 + $30 − $10 = $45" flagged as an unsupported figure | failing eval case, reproduced offline | checker accepts three-term working |
| Settling an open item in a new chat left it open in the original chat | code reading + test | open items of recalled chats passed to distillation (D51) |
| Same vendor stored as "Supabase" and "Supabase Pro"; Salesforce as "Pro Suite" | memory drawer | known entities + canonical names (D52) |
| A failed distillation was never retried | code reading | catch-up from the transcript (D53) |
| Only 12 profile facts reached the model; forgetting a chat erased earlier profile values | code reading | profile versions; no cap; per-conversation forgetting (D54) |
| "as of 11 Nov 2026 [S3]" flagged an unsupported "11" | eval failure, printed figure | day-of-month in a date isn't a figure |
| Three eval assertions failed correct answers (other real chats mentioned; "doesn't" not in the word list) | reading the answers | assertions check the intent; each re-run |

---

## 13. How the design evolved

| Stage | Search | Memory | Model |
|---|---|---|---|
| v1 | Tavily snippets passed through | Date + keyword over raw transcripts | Gemini free tier, own loop |
| v2 | + guardrails, citation checker, repair | + "nothing found" honesty, nearest-chat index | + fallback chain, circuit breaker |
| v3 | **Own pipeline:** discover → fetch → read → rank; Firecrawl failover and rendering | (unchanged) | **Claude via Agent SDK**, built-in tools off |
| v4 | (unchanged) | **Four memory types**, background distillation, hybrid recall with rank fusion, turn ledger | + Haiku for distillation |
| v4.1 | (unchanged) | Neighbour context, specific profile keys, stricter date parsing (from real use) | (unchanged) |
| v5 | Per-URL live progress; citations open the page at the cited passage | Vector retriever removed with Gemini | **Claude only**; provider interface removed; shared helpers |
| v6.1 | (unchanged) | Cross-chat decisions; one name per company; catch-up of missed writes; profile history | (unchanged) |
| v6 | (unchanged) | **Memory first** (enforced); always-in-view timeline; aliases at write time; facts retriever; decisions + open items; inspectable, forgettable memory; `eval:memory` 20/20 | (unchanged) |

Next steps are in `DESIGN.md` → "With another week".
