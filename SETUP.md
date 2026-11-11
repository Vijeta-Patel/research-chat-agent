# Setup

## You need

- **Node.js 22.13 or newer** (`node -v` to check)
- **A Claude login or key.** One of:
  - Claude Code installed and signed in on this machine (this is how the project was built), or
  - an Anthropic API key
- **A web search key:** Tavily or Firecrawl, both free, no card
  - Tavily: https://tavily.com
  - Firecrawl: https://firecrawl.dev

## Run it

1. Install:
   ```bash
   npm install
   ```
2. Create your settings file:
   ```bash
   cp .env.example .env.local
   ```
3. Open `.env.local` and fill in:
   - `TAVILY_API_KEY` and/or `FIRECRAWL_API_KEY`: at least one, both is better
   - `ANTHROPIC_API_KEY`: only if you're not signed in to Claude Code
4. Start it:
   ```bash
   npm run dev
   ```
5. Open http://localhost:3000

## Optional

- `CLAUDE_RUNTIME=api` uses our own agent loop on the Anthropic API instead of the Claude Agent SDK. It needs `ANTHROPIC_API_KEY`.
- **Start with an empty memory:** delete `data/agent.db`.
- **Run the tests:**
  ```bash
  npm run eval:memory   # memory only, no web searches
  npm run eval          # everything: real model + real search (uses ~20–30 search credits)
  ```

## If something goes wrong

| You see | Do this |
|---|---|
| "Missing TAVILY_API_KEY or FIRECRAWL_API_KEY" | Add one of them to `.env.local`, then restart `npm run dev` |
| "Claude authentication failed" | Sign in to Claude Code, or set `ANTHROPIC_API_KEY` in `.env.local` |
| An error mentioning `node:sqlite` | Upgrade Node to 22.13 or newer |
