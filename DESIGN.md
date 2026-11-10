# DESIGN

## How it works

```
message ─► mask secrets ─► memory retrieval (no LLM: date parsing + SQL + full-text search)
        ─► model ⇄ web_search loop (Claude Sonnet 5.5 via Agent SDK; searches run in parallel)
               └─ every search goes through guards: query privacy · injection filter · budgets · source tiers
        ─► checks (no LLM): citations exist · figures appear in the cited text · no unretrieved URLs
               └─ on failure: one repair pass (or a search pass if prices were stated without searching)
        ─► stream to the UI and save (SQLite: conversations, messages, sources, memory used)
```

The model has **one tool**, `web_search` (Tavily). Everything else is in the code around it, so it runs the same every time and never depends on the model choosing to do it.

## Why it's built this way

The three example questions all depend on **memory + dates + freshness**, and they all hide a trap: the conversation they refer to may not exist. So:

- **Memory is retrieved *before* the model runs**, not exposed as a second tool. This keeps the one-tool brief and saves a round-trip. `chrono-node` resolves "last Tuesday" in the user's timezone. Dates only trigger a lookup when the message refers to *our* past ("I asked", "you told me"), so "news from last month" doesn't pull up old chats. Memory fills a fixed budget, so the prompt stays the same size whether there are 10 conversations or 10,000.
- **The memory block always says what was searched and what was found, including "nothing on 5 Nov".** When nothing is found, it also lists the conversations that *do* exist. The agent then says "I don't have that — did you mean the 3 Nov Postgres chat?" instead of inventing one. This is the most important honesty mechanism.
- **"Is it still correct?" answers** compare each item, Then [memory] vs Now [source], marked Changed, Unchanged or Couldn't verify. Memory is never accepted as evidence for a *current* fact.
- **Citations are checked in code, not just requested.** Sources get IDs (`[S3]`, `[M1]`) and the model never writes URLs. After each answer, a checker confirms every cited ID exists and every figure appears in the cited page's text. Calculations from cited inputs (20 × $39) are allowed. This caught a real error: the model quoted Pipedrive prices that weren't on the pages it cited. A failed check triggers one repair pass; the revision is kept only if it has fewer problems.
- **Reliable sources:** each result is tiered in code (official / primary / news / community / roundup). Prices must come from official sources. If a search returns no official results, the tool tells the model to search the vendor's own domain.

**Guardrails, enforced in code:**
- personal data and secrets are stripped from outgoing search queries
- instruction-like text in web pages is neutralised
- secrets pasted into chat are masked before they're stored
- URLs that weren't retrieved are stripped
- search and time budgets, plus a per-client rate limit
- provider safety blocks are explained to the user

The one prompt-only rule is the policy for high-stakes topics (medical, legal, financial).

## What I considered and rejected

| Rejected | Why |
|---|---|
| A `recall_memory` tool | Breaks the one-tool brief and adds a model round-trip. Retrieval before the model runs is faster and gives the same result every time. |
| Putting the whole history in the prompt | Stops fitting after a few dozen chats; a fixed memory budget scales. |
| The provider's built-in web search (Anthropic/Gemini) | No date filter, no source tiers, can't cache or inspect results. |
| Prompt-only citations | Models invent links and misattribute numbers; we measured it. |
| A separate moderation/judge model on every turn | Adds latency and cost on every answer; the code checks catch the common failure (wrong figures) for free. |
| Vercel AI SDK / LangChain | More abstraction around the part we need to own. The Agent SDK is set up with every built-in tool off. |
| Gemini free tier as the default | Built first. In testing it hit 503s and daily quota limits (an overloaded model took 11 s just to fail), so it's kept as `LLM_PROVIDER=gemini`, behind a fallback chain and circuit breaker. |

## Measured

`npm run eval`: 10 end-to-end cases against a seeded database: memory recall, "still correct?", never-happened, the cold CRM shortlist, a false premise, current prices, news, a follow-up, secret masking, maths. Latest run: **10/10 passed**, median time to first word 3.2 s, median total 11.1 s, citation checks clean on 5/5 answers that searched ([eval/results.md](eval/results.md)). It's a small sample, so treat it as a regression suite rather than a benchmark. The first run scored 6/10, but only because of a harness bug: the script never loaded the keys, so every search failed. Even then, the agent said search was unavailable instead of guessing.

Every speed change was made from per-turn traces (each model call, search and repair is timed). For example, effort `low` vs `medium` made no measurable difference (16.0 s vs 15.2 s), so medium stayed. Time is dominated by model reading and writing after search, about 15 s for a three-vendor comparison; questions that don't need search start answering in about 2 s.

## With another week

- **Claims ledger:** extract facts per answer into versioned rows, so "has anything changed?" compares structured values and can run on a schedule ("watch these 5 CRMs, tell me when pricing changes").
- **Semantic recall:** embeddings for vague, undated questions, alongside date and keyword search.
- **Bigger evals:** samples of LongMemEval (temporal reasoning, abstention), FreshQA (fast-changing facts and false premises) and SimpleQA, plus an LLM judge that checks each claim against its citation.
- **Speed:** stream a short opening line while searches run; a headless browser for pricing pages that load their prices with JavaScript.
- Multi-user accounts, a cost dashboard, and source reliability learned from user feedback.
