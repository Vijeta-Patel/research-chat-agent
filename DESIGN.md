# Design

**The model writes the answer. Our code makes sure it's right.** Memory, search and verification are all code we own, and each part was built in response to a failure we measured. → Every decision with its evidence: [DECISIONS.md](DECISIONS.md) · Run it: [SETUP.md](SETUP.md)

## How it works

![Architecture: one message flows through six steps — mask secrets, recall memory, Claude with web search, check the answer, stream and save, distil memory — with the web_search pipeline and the five memory stores](assets/architecture.svg)

## Why it's built this way

### 1. Memory is read first, and doesn't need the right words

- **It can't be skipped.** Recall runs before the model on every message. It isn't a tool the model might forget to call, and a check rejects any answer about the past that cites no memory record.
- **It finds vague references.**
  - The six most recent chats are always in view.
  - When a chat is saved, the background notes add other words a person might use for it later ("db hosting", "moisturiser", "notebook").
  - Four searches (dates, words, topics, facts) are fused, so "that database thing" or "is it still $25?" finds the right chat with no model call.
  - **Measured: 11/16 → 20/20.**
- **It remembers what matters, not just what was said:**
  - **Decisions and open items:** "which one did we pick?" → "you haven't yet: HubSpot vs Pipedrive, after Friday's demo".
  - **A facts ledger that never overwrites:** "has the price changed?" becomes a lookup, e.g. Neon *$19/mo (3 Nov) → usage-based (10 Nov)*.
  - **A profile with history**, which carries across chats.
- **It's honest when there's nothing.** The memory block always says what was searched, including "nothing on 5 Nov", so the agent says so instead of inventing a conversation.
- **It's yours.** Everything lives in one local SQLite file. A drawer shows everything stored, and any item can be forgotten.

### 2. Search reads the pages, not the snippets

- **Why:** passing a search API's snippets through led the model to quote Pipedrive prices that weren't in the text it cited.
- **What we do now:** an API only finds the URLs (Tavily, failing over to Firecrawl). Our code fetches each page, extracts the text, renders JavaScript pricing pages, and ranks passages.
- **Sources are tiered** (official, news, community, roundup), and prices must come from official sources.

### 3. Every claim is checked in code, and you can check it too

- **Citations are IDs (`[S3]`, `[M1]`), never URLs** the model could make up.
- **Every figure must appear in the text of the source it cites.** Calculations from cited figures are allowed. If a check fails, one repair pass runs.
- **One click to verify:**
  - a citation shows the exact passage the agent read, with the figure highlighted
  - the search log shows every URL it opened, and why some were only snippets

### 4. The model: Claude, locked down to the brief

- **Claude Sonnet 5.5 through the Claude Agent SDK, because we had no Anthropic API key.** The SDK also runs on a Claude Code login.
  - Every built-in tool is off; `web_search` is its only tool.
  - Our database is its only memory.
- **For key holders:** `CLAUDE_RUNTIME=api` switches to our own ~100-line loop on the Messages API, with prompt caching and a refusal fallback. It was tested against a local fake of the API, not yet the live one.

## Measured

| | Result |
|---|---|
| Memory: 20 questions that mostly avoid the chats' own words, plus 8 checks on how memory is written | **20/20 and 8/8**, three runs in a row |
| End to end: 14 real conversations, real model, real web | **13/14**; the one failure was the test's wording |
| Speed fixes, from per-step timings | 167 s → 17 s · 46.5 s → 5.5 s · memory recall ~10 ms |

## Considered and rejected

| Rejected | Why |
|---|---|
| A `recall_memory` tool | Breaks the one-tool brief, and the model could skip it |
| Embeddings / a vector database | Measured: local models picked the wrong conversation |
| A model call to route each question | Extra latency on every message; the 20/20 above needed none |
| Search snippets as the answer source | Caused wrong prices (measured) |
| A judge model on every answer | Slower and costlier; code checks catch wrong figures at no cost |
| Gemini as the model | Overloaded and out of quota in testing |

## With another week

- **Run our own API loop live** and make it the default for key holders.
- **Faster first words** on search answers: stream an opening line while pages load.
- **Watch tracked facts:** re-check stored prices on a schedule and flag changes.
- **Public benchmarks:** test on LongMemEval and FreshQA samples, plus a claim-by-claim citation judge.
