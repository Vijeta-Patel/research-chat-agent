# DESIGN

*One-page summary. Every decision with its options, evidence and the bugs that shaped it: **[docs/DECISIONS.md](docs/DECISIONS.md)**.*

## How it works

```
message ─► mask secrets
        ─► RECALL (no LLM): hybrid retrieval over 4 memory types → fixed-budget <memory> block
               dates (SQL) · keywords (BM25 over transcripts) · topics (BM25 over distilled summaries)
               · vectors (optional) ──► reciprocal rank fusion
        ─► Claude Sonnet 5.5 (Agent SDK, built-in tools off) ⇄ web_search, the only tool
               web_search = our pipeline: discover (Tavily → Firecrawl, circuit breakers)
               → fetch + read (Readability; JS pages rendered) → rank (BM25 passages) → guard
        ─► CHECKS (no LLM): cited IDs exist · figures appear in cited text · no unretrieved URLs
               └─ on failure: one repair pass
        ─► stream to UI · save transcript + turn ledger (SQLite)
        ─► DISTIL (background, cheap model): summary + topics · facts ledger · user profile
```

## Memory: four kinds, one write path, one read path

| Type | Table | Written by | Answers |
|---|---|---|---|
| Episodic | `messages` + full-text index | every turn | "what exactly did I ask on 3 Nov?" |
| Conversation summary + topics | `conversation_memory` | distil step | "that database thing we talked about" |
| Facts ledger (versioned, never overwritten) | `claims` | distil step, **only facts the answer cited** | "has Neon's pricing changed?" → `$19/month (3 Nov) → usage-based (10 Nov)` |
| User profile | `profile` | distil step, only what the user said about themselves | a *new* chat knows "20-person sales team" |

- **Write path:** after each answer, in the background (it never delays the reply). One Haiku call returns JSON; the code validates it: claims must reference a source the answer actually cited, and secrets are never stored. Existing fact names are passed in, so a restated fact lines up as a new version of the same fact.
- **Read path:** runs *before* the model, so the model keeps one tool and skips a round-trip. Four retrievers are merged by rank fusion, then a fixed budget is filled, most reliable first: profile → (in long chats) the earlier-in-this-chat summary → exact date hits → facts with their value history → summaries → raw excerpts.
- **Dates only trigger a lookup when the message is about *our* past** ("I asked…"). "News from last month" doesn't.
- **The memory block always says what was searched and found, including "nothing on 5 Nov",** plus an index of the conversations that do exist. That's why the agent says "I don't have that — did you mean the 3 Nov Postgres chat?" instead of inventing one.
- **Vectors were measured, not assumed.** Local embedding models ranked "that database thing" closer to the CRM or F1 chats than to Postgres, so they were rejected. Hosted Gemini embeddings ranked all test questions correctly, but by small margins, so they're optional and count half in fusion. Distilled general topics ("managed databases") plus stemmed full-text search do most of the fuzzy matching, exactly and instantly.

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
| Built-in web tools (Claude Code / Gemini) | No date filters, tiers or guardrails; breaks the one-tool rule and the Gemini path |
| A judge model on every turn | Latency and cost; code checks catch wrong figures for free |
| Gemini free tier as default | Hit 503s and quota limits in testing; kept as `LLM_PROVIDER=gemini` |

## Measured
`npm run eval`: **14 end-to-end cases** on a seeded database. Latest Claude run: **the first 10 of 14 passed**, including the new `vague-recall` and `profile-cross-session`. The last 4 never reached the model: the Claude **subscription hit its usage limit** mid-run. Those 4 (plus vague-recall) were re-run on **Gemini through the same harness: 5/5 passed** ([eval/results.md](eval/results.md), [eval/results-gemini-rerun.md](eval/results-gemini-rerun.md)). The suite therefore passes on both model providers. A fix from these runs: vague recall dropped from 46.5 s to 5.5 s once questions only about our past stopped triggering web searches. It's a small sample, so treat it as a regression suite, not a benchmark. Every speed change came from per-turn traces. For example, effort `low` vs `medium` made no measurable difference, and reading full pages costs a few seconds per search in exchange for evidence the checker can verify.

## With another week
- **Speed:** stream an opening line while pages are read.
- **Official-site discovery:** Wikidata → sitemap/RSS changelogs, for dated "what shipped since Monday?" answers.
- **Scheduled re-checks of stored facts** ("tell me when Neon's pricing changes").
- **Bigger evals:** LongMemEval, FreshQA and SimpleQA samples, plus an LLM judge for each claim against its citation.
- **Own Claude loop** once an API key is available (the Gemini path already uses one); multi-user accounts.
