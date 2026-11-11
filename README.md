# research chat

A chat agent with one tool, web search, that remembers your past conversations and cites every claim.
- **Search** is our own pipeline: an API only supplies the URLs; we fetch, read and rank the pages ourselves.
- **Memory** has four layers: transcripts, conversation summaries, a versioned facts ledger and a user profile, recalled by hybrid retrieval.
- **"How I got this"** under every answer shows the model, timings, searches and checks for that turn.

Ask it things like:
- *"Compare HubSpot, Pipedrive and Salesforce pricing for a 20-person sales team"*
- *"What did I ask you on 3 November? Is your answer still correct today?"*
- *"Last Tuesday I asked you about Postgres hosting. Has any pricing changed since?"*

How it works and why it's built this way: **[DESIGN.md](DESIGN.md)**.

## Run it

Requires Node **22.13+**, because it uses the built-in `node:sqlite`.

```bash
npm install
cp .env.example .env.local   # then fill in the keys below
npm run dev                  # http://localhost:3000
```

| Variable | Required | What for |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes* | The model (Claude Sonnet 5.5 via the Claude Agent SDK). *For local development the SDK can also use an existing Claude Code login on the machine. |
| `TAVILY_API_KEY` | one of these two | Search discovery provider #1 (free 1,000 credits/month) |
| `FIRECRAWL_API_KEY` | one of these two (both recommended) | Discovery provider #2, used automatically if Tavily fails, and the renderer for pages that need JavaScript (free 1,000 credits/month) |
| `CLAUDE_MODEL`, `CLAUDE_EFFORT`, `CLAUDE_MEMORY_MODEL`, `DB_PATH` | no | Tuning. Defaults are in `.env.example`. |

Everything is stored in `data/agent.db` (SQLite, gitignored):
- **Tables:** transcripts, conversation summaries, facts ledger, profile and the turn ledger.
- **Starting fresh:** delete the file.
- **Forgetting one conversation:** use the × in the past-chats drawer. It also removes the summaries, facts and profile entries derived from that conversation.

## Test it

```bash
npm run eval                 # all cases
npm run eval memory-recall   # one case by id
npm run eval:memory          # memory recall only (no web search)
```

`npm run eval:memory` tests memory on its own: it seeds 17 conversations, distils them with the real write path, and asks 20 questions that mostly avoid the words the chats used. It writes `eval/memory.md`. It makes about 20 small-model calls and no searches.

`npm run eval` runs real turns (real model, real search) against a throwaway database seeded with known history. It checks behaviour with deterministic assertions: recall, honesty about missing memory, citations, official sources, false premises, guardrails and timing. It writes `eval/results.md`. One run costs roughly 20–30 Tavily credits.

## Layout

```
src/lib/agent/run.ts         one user turn, end to end (the agent's spine)
src/lib/agent/verify.ts      what happens to a draft: freshness check, URL guard, citation repair
src/lib/agent/guardrails.ts  privacy, injection, secrets, URL, rate-limit guards
src/lib/agent/citations.ts   deterministic citation/number checks
src/lib/agent/prompt.ts      system prompt (static, cacheable)
src/lib/memory/              db.ts (schema) · query.ts (reading the question: dates, terms) · retrieve.ts (recall) · distill.ts (write path)
src/app/api/memory/route.ts  what the agent remembers: read it, forget any item
src/lib/search/              tool.ts (the one tool: schema, guardrails, [S#] ids) · pipeline.ts: discover (provider chain) → read → rank, + source tiers
src/lib/llm/claude.ts        the model: Claude via the Agent SDK, built-in tools off
src/lib/evidence.ts          claim → the passage in the cited page that backs it (for the citation popup and deep link)
src/lib/util.ts              shared helpers: URL identity, tokeniser, citation ids, timeouts, dates
src/app/api/chat/route.ts    streaming endpoint (server-sent events)
src/components/              chat UI
scripts/eval.ts              end-to-end test suite
scripts/memory-probe.ts      memory recall test
```
