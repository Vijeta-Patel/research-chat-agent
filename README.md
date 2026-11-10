# research chat

A chat agent with one tool, web search, that also remembers your past conversations and cites every claim.

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
| `TAVILY_API_KEY` | yes | Web search. The free plan is 1,000 credits/month. |
| `LLM_PROVIDER` | no | `claude` (default) or `gemini` |
| `GEMINI_API_KEY` | only if `LLM_PROVIDER=gemini` | Google Gemini |
| `CLAUDE_MODEL`, `CLAUDE_EFFORT`, `GEMINI_MODEL`, `SEARCH_DEPTH`, `DB_PATH` | no | Tuning. Defaults are in `.env.example`. |

Memory is stored in `data/agent.db` (SQLite, gitignored). Delete that file to start fresh, or remove a single conversation with the × in the sidebar.

## Test it

```bash
npm run eval                 # all cases
npm run eval memory-recall   # one case by id
```

This runs real turns (real model, real search) against a throwaway database seeded with known history. It checks behaviour with deterministic assertions: recall, honesty about missing memory, citations, official sources, false premises, guardrails and timing. It writes `eval/results.md`. One run costs roughly 20–30 Tavily credits.

## Layout

```
src/lib/agent/run.ts         one user turn, end to end (the agent)
src/lib/agent/guardrails.ts  privacy, injection, secrets, URL, rate-limit guards
src/lib/agent/citations.ts   deterministic citation/number checks
src/lib/agent/prompt.ts      system prompt (static, cacheable)
src/lib/memory/              SQLite store + date-aware retrieval
src/lib/search/              Tavily client + source reliability tiers
src/lib/llm/                 model providers: claude.ts (Agent SDK), gemini.ts
src/app/api/chat/route.ts    streaming endpoint (server-sent events)
src/components/              chat UI
scripts/eval.ts              end-to-end test suite
```
