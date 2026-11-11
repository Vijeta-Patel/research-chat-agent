# DESIGN

*One-page summary. Every decision with its options, evidence and the bugs that shaped it: **[docs/DECISIONS.md](docs/DECISIONS.md)**.*

## How it works

```
message ─► mask secrets
        ─► RECALL (no LLM, ~9 ms): memory is looked through BEFORE the model runs → fixed-budget <memory> block
               always in view: profile + a timeline of recent chats (summary · decided · left open)
               recalled: dates (SQL) · keywords · topics + aliases · facts (BM25) ──► rank fusion
        ─► Claude Sonnet 5.5 (Agent SDK, built-in tools off) ⇄ web_search, the only tool
               web_search = our pipeline: discover (Tavily → Firecrawl, circuit breakers)
               → fetch + read (Readability; JS pages rendered) → rank (BM25 passages) → guard
               every URL and what happened to it is streamed to the UI as it happens
        ─► CHECKS (no LLM): past question → answer must cite a memory record or say "no record"
               · cited IDs exist · figures appear in cited text · no unretrieved URLs
               └─ on failure: one repair pass
        ─► stream to UI · save transcript + turn ledger (SQLite)
        ─► DISTIL (background, cheap model): summary + topics + aliases · decisions + open items
               · facts ledger · user profile
```

## Memory: four kinds, one write path, one read path

| Type | Table | Written by | Answers |
|---|---|---|---|
| Episodic | `messages` + full-text index | every turn | "what exactly did I ask on 3 Nov?" |
| Conversation summary + topics + **aliases** | `conversation_memory` | distil step | "that database thing we talked about" |
| **Decisions and open items** | `conversation_memory` | distil step, kept current as the chat goes on | "which one did we pick?" · "what's still undecided?" |
| Facts ledger (versioned, never overwritten) | `claims` | distil step, **only facts the answer cited** | "has Neon's pricing changed?" → `$19/month (3 Nov) → usage-based (10 Nov)` |
| User profile, **with history** | `profile` + `profile_history` | distil step, only what the user said about themselves | a *new* chat knows "20-person sales team", and that it used to be 15 |

- **Write path:** after each answer, in the background (it never delays the reply). One Haiku call returns JSON; the code validates it: claims must reference a source the answer actually cited, and secrets are never stored. Existing company and fact names are passed in and enforced, so a restated fact lines up as a new version of the same fact. The same call can close an open item of an *earlier* chat when the user states the outcome ("we went with HubSpot"). If a write fails, the next turn rebuilds it from the saved transcript.
- **Memory first, as a rule in code.** Recall runs before the model on every message, so the model cannot answer ahead of it. If a question about our past comes back without citing a memory record (or saying there is none), the checker sends it back once with the records attached.
- **Recall without the right words.** Two mechanisms, neither needing a model call or embeddings at read time: (1) the profile and a timeline of the six most recent chats are always in view, so the model itself matches "the tools for my reps" to the CRM chat; (2) for older history, the distiller writes **aliases** at write time ("moisturiser", "notebook", "db hosting") into the full-text index — semantics are paid for once, in the background.
- **Measured:** `npm run eval:memory` seeds 17 chats, distils them with the real write path, and asks 20 questions that mostly avoid the chats' own words, with the targets pushed out of the timeline. **20/20** select the right conversation, in ~9 ms each ([eval/memory.md](eval/memory.md)). Before this change the same idea scored 11/16, and 6 of those 11 found only the user's old message without the recorded facts.
- **Read path:** runs *before* the model, so the model keeps one tool and skips a round-trip. Four retrievers are merged by rank fusion, then a fixed budget is filled, most reliable first: profile → (in long chats) the earlier-in-this-chat summary → exact date hits → facts with their value history → summaries → raw excerpts.
- **Dates only trigger a lookup when the message is about *our* past** ("I asked…"). "News from last month" doesn't.
- **The memory block always says what was searched and found, including "nothing on 5 Nov",** plus an index of the conversations that do exist. That's why the agent says "I don't have that — did you mean the 3 Nov Postgres chat?" instead of inventing one.
- **Vectors were measured, not assumed.** Local embedding models ranked "that database thing" closer to the CRM or F1 chats than to Postgres, so they were rejected. Hosted Gemini embeddings ranked all test questions correctly, but only by small margins, and needed a second vendor's key — so they were removed along with the Gemini provider. Distilled general topics ("managed databases") plus stemmed full-text search do most of the fuzzy matching, exactly and instantly.

## Search: we own everything except finding the URLs

"Plain Tavily" and "our own search" are both just a tool call; the difference is who reads the page. Snippets caused a real error: the model quoted Pipedrive prices that weren't in the 500-character excerpt. So `web_search` fetches pages itself, extracts the main text with Readability, renders JavaScript pages through Firecrawl (prioritising pages that match the question, e.g. `/pricing`), and ranks passages with BM25. Discovery is a swappable chain with circuit breakers.

## Verification and guardrails (in code, not prompts)
- **Citations:** source IDs (`[S3]`, `[M1]`); the model never writes URLs. Every cited ID must exist, and every figure must appear in the cited text (calculations from cited inputs are allowed).
- **Sources:** reliability tiers (official / primary / news / community / roundup); prices must come from official sources.
- **Search queries:** personal data and secrets are stripped.
- **Web pages:** instruction-like text is neutralised.
- **Chat input:** pasted secrets are masked.
- **Output:** URLs that weren't retrieved are stripped.
- **Limits:** search and time budgets, plus a rate limit.
- **Safety blocks:** explained to the user.

**Memory you can inspect:** the drawer shows everything distilled — what it knows about you, what you decided, what is still open, each tracked fact with its value history — and every item can be forgotten. It all lives in one local SQLite file.

**Verify it yourself:** each search shows live which URLs were found and whether each page was read in full, rendered, or only available as a snippet (and why). Hovering a citation shows the passage the agent actually read with the cited figure highlighted; clicking it opens the real page scrolled to that passage (a text-fragment link). Figures that aren't in the cited text are called out in the popup.

**Observability:** a `turns` ledger stores every answer's model, timings, searches, fallbacks, guardrail hits and step trace, shown in the UI as **"how I got this"** under each answer.

## Considered and rejected

| Rejected | Why |
|---|---|
| A `recall_memory` tool | Breaks the one-tool brief; adds a round-trip |
| Whole history in the prompt | Doesn't scale; a fixed memory budget does |
| Local embeddings / a vector database | Measured wrong on vague questions; 25–130 MB download; overkill at this scale |
| Search snippets as the tool output | A black box; misses pricing tables (measured) |
| Own crawler/index; scraping Google/Bing/DuckDuckGo results | Not feasible / against terms of service, fragile |
| treg.to gateway | A middleman with unclear failover; failover is what we should design |
| Built-in web tools (the Agent SDK's WebSearch/WebFetch) | No date filters, tiers or guardrails; two tools, not one; the checker can't see the page text |
| A judge model on every turn | Latency and cost; code checks catch wrong figures for free |
| Gemini (the first build ran on its free tier) | Hit 503s and quota limits in testing; a second provider doubled every code path for no gain, so it was removed — one model layer, Claude |

## Measured
`npm run eval`: **14 end-to-end cases** on a seeded database (real model, real search). Latest full run, 11 Nov: **13/14**, median first word 3.5 s, median total 13.2 s ([eval/results.md](eval/results.md)). The failure was the test, not the agent: it correctly said Supabase "doesn't appear to have shut down its free tier", which the assertion's word list missed. The assertion was widened and the case passes on its own. Memory on its own: `npm run eval:memory`, **20/20 recall + 8/8 write-path checks**, three runs in a row ([eval/memory.md](eval/memory.md)).

## With another week
- **Speed:** stream an opening line while pages are read.
- **Official-site discovery:** Wikidata → sitemap/RSS changelogs, for dated "what shipped since Monday?" answers.
- **Scheduled re-checks of stored facts** ("tell me when Neon's pricing changes").
- **Bigger evals:** LongMemEval, FreshQA and SimpleQA samples, plus an LLM judge for each claim against its citation.
- **Own Claude loop** on the Messages API (native citations, prompt caching) instead of the Agent SDK; multi-user accounts.
