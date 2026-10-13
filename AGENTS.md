# AGENTS.md

Guide for AI coding agents (Claude Code and others) working on this repo.

## Project

Fork of [Rugplay](https://github.com/outpoot/rugplay) (fake crypto simulator) that adds a stock market, player-founded startups and a local AI crowd. **Read [docs/STOCK_MARKET_PLAN.md](docs/STOCK_MARKET_PLAN.md) before working on new features.** It holds the decisions (AMM for coins, order book for stocks, 1-day quarters, local-only AI, no short selling in v1).

Audience is mainly teens/students: keep UI text short and simple.

## Working style

### Use subagents

The main agent plans and coordinates; subagents do the work. Split tasks into independent pieces and run them in parallel where possible. Pick the cheapest model that can do the job:

| Model | Use for |
| --- | --- |
| **Haiku** | searching/exploring the codebase, reading docs, simple mechanical edits, renames, formatting, writing commit messages |
| **Sonnet** | most implementation: API routes, Svelte components, single-feature changes, migrations, bug fixes with a clear cause |
| **Opus** | planning and architecture, schema design, economy/crowd math (AMM, order book, flow formula), tricky bugs, security- or money-related code, final review of big changes |

Rules:
- Give each subagent a self-contained prompt: goal, files, constraints, what "done" means.
- Subagent output is a report, not truth: verify key claims before acting on them.
- Don't run two subagents that edit the same file at the same time.

### Use the ponytail skill

Agents should use the [ponytail](https://github.com/DietrichGebert/ponytail) skill (MIT, vendored in `.claude/skills/`): before writing new code, check if it already exists in the codebase, the standard library or the platform, and write less code.

- `.claude/skills/ponytail/SKILL.md`: use on every coding task (full level). Subagents: read this file first.
- `.claude/skills/ponytail-review/SKILL.md`: use to review a change before committing.

Never cut security, input validation, error handling or accessibility to save lines.

### Keep it simple

- Follow the plan's design rule: every feature must feed the crowd or be something players actively do.
- Small changes, one feature at a time. No speculative abstractions.
- Match the style of the surrounding code.

## Stack

- **Website:** SvelteKit 2 + Svelte 5 (runes: `$state`, `$derived`, `$props`), TypeScript (strict), Vite, Tailwind v4, shadcn-svelte (bits-ui), adapter-node.
- **DB:** PostgreSQL via Drizzle ORM. **Cache:** Redis.
- **Auth:** better-auth + Google OAuth.
- **Websocket server:** Bun, in `website/websocket/`.
- **AI (existing):** OpenRouter via the `openai` SDK in `website/src/lib/server/ai.ts` (prediction markets). **The new AI crowd must run locally** (llama.cpp/Ollama), not on OpenRouter.

## Commands

Run from `website/` (npm):

| Command | What it does |
| --- | --- |
| `npm run dev` | dev server on http://localhost:5173 |
| `npm run build` | production build |
| `npm run check` | svelte-check + TypeScript |
| `npm run lint` | prettier check (there is no ESLint) |
| `npm run format` | prettier write |
| `npm run db:migrate` | apply migrations |
| `npx drizzle-kit generate` | create a migration from `schema.ts` |

Websocket: `cd website/websocket && bun run src/main.ts`.

**There are no tests.** Before committing, run `npm run check` and make sure your changed files pass prettier. Many older server files are not prettier-formatted: only format files you change, don't reformat the whole repo.

## Layout (`website/src/`)

- `routes/`: pages; API endpoints in `routes/api/**/+server.ts`; public API in `routes/api/v1/`.
- `hooks.server.ts`: auth handler, rate limits, background jobs.
- `lib/server/`: server-only code.
  - `amm.ts`: coin AMM pricing, swaps, 24h metrics.
  - `ai.ts`: OpenRouter AI (prediction question resolution).
  - `job.ts`: periodic jobs.
  - `db/schema.ts`: all Drizzle tables and enums.
  - `ratelimit.ts`, `notification.ts`, `seasons.ts`, `achievements.ts`.
- `lib/components/self/`: app components; `lib/components/ui/`: shadcn primitives.
- `lib/stores/`: Svelte stores (`websocket.ts` = live client).
- `lib/data/constants.ts`: economy constants.
- `website/drizzle/`: SQL migrations + `meta/` snapshots and `_journal.json`.

## Conventions

- Prettier: tabs, single quotes, no trailing commas, print width 100.
- Svelte 5 runes only; no `export let` in new components.
- Server-only code goes in `$lib/server`. Validate input with zod.
- Env vars via `$env/static/private` / `$env/dynamic/private`; never hardcode secrets.

## Money and economy code

Balances, trades, pools and order books are the core of the game. Bugs here break the economy.

- Do every balance/holding change inside a DB transaction, and lock the rows you update.
- Use the existing decimal columns; be careful with float rounding.
- The economy is closed: crowd accounts can't create money, sell shares they don't own, or spend cash they don't have.
- Rate-limit new trading endpoints (see `ratelimit.ts` and `hooks.server.ts`).
- Use Opus for design and review of this code.

## Migrations

- Change `schema.ts`, then generate a migration; never edit applied migrations.
- Every `.sql` file in `website/drizzle/` must have an entry in `meta/_journal.json` and a matching snapshot, or `db:migrate` skips it. `drizzle-kit generate` handles this; if you write SQL by hand, add both.

## Stock market code map

| Area | Files |
| --- | --- |
| Companies, funding rounds, quarter close, IPO, credibility | `lib/server/companies.ts`, `routes/api/companies/**` |
| Order book (the only way to trade stocks) | `lib/server/orderbook.ts` (`placeOrder`, `cancelOrder`) |
| AI crowd | `lib/server/crowd.ts` (tick), `lib/server/crowd-decide.ts` (`decide()`, prompts, rules fallback) |
| Pages | `routes/companies/**`, `lib/components/self/{StockMarket,StockChart,CompanyAnnouncements,CrowdInsights}.svelte`, `routes/admin/crowd` |

- **Lock order (company world):** company row first, then user rows by ascending id. Every new money transaction must follow it.
- **Crowd LLM:** `CROWD_LLM_URL` points at a llama.cpp server; empty = rules only. The crowd must stay local (no OpenRouter).
- **Admin test triggers:** `POST /api/admin/companies/quarter` `{"force":true}` (close a quarter, IPO due rounds) and `POST /api/admin/crowd/tick` `{"force":true}` (run the crowd now).

## Testing locally

There are no automated tests. Verify money changes end to end:

- Postgres 16 + Redis locally. **Known issue:** the SQL migrations lag `schema.ts` (e.g. `user.gems`), so build a test DB with `CREATE EXTENSION pg_trgm;` + `npx drizzle-kit push --force`, not `db:migrate`.
- Fake a logged-in user: insert a `session` row and send the cookie `better-auth.session_token=<token>.<base64 HMAC-SHA256(token, PRIVATE_BETTER_AUTH_SECRET)>` (URL-encoded).
- After money changes, check invariants in SQL: no negative balances, shares conserved (`company.shares_outstanding` = sum of holdings), book never crossed, and total money (balances + buy-order escrow + treasuries + coin pools) changes only by burned fees.

## Git

- Small commits with clear messages. Don't push to `main` unless asked.
- Never commit `.env` or secrets.
- License is CC BY-NC 4.0: keep credit to the original Rugplay.
