# Rugplay Stock Market Fork — Plan

Oct 13, 2026 · [Live doc](https://claude.ai/code/artifact/b32e11e4-5b2e-469a-9e8f-9d646251cf01)

## Status

v1 (all five Core items) is built on branch `claude/ecstatic-darwin-dsglqo`. Extra decisions made while building:

- **IPO:** automatic when a funding round ends with at least one investor, at the round price.
- **Trading:** order book with limit and market orders; 0.3% fee paid by the seller (burned); market orders only fill within 20% of the last price.
- **Founder shares:** unlock linearly over 14 days after the round ends.
- **Crowd:** 3 bot accounts (`crowd-retail`, `crowd-fund`, `crowd-trader`) with $5M / $20M / $2M start cash and no refill; each holds at most 1% of its start cash in one stock.
- **Founder trust:** (kept + 2) / (kept + broken + 2) promises; one open promise per founder.
- **Not playtested yet:** all numbers are guesses and will need tuning.

## Vision

The fork adds a stock market with real-ish fundamentals next to Rugplay's existing crypto market, plus an AI-driven crowd that buys and sells like the mass of real traders.

- **Two markets side by side:** crypto stays pure hype and rug pulls; stocks have revenue, profit and cash. The contrast teaches on its own.
- **Players found companies** and must convince both players and the AI crowd to buy shares.
- **Educational through play, not lessons:** bubbles, crashes and hype-vs-fundamentals emerge from the crowd, and players learn by watching (and getting burned).

## Design rules

Every feature must either feed the crowd (give the agents something to react to) or be something players actively do; otherwise it is cut.

- **Few numbers per company:** price, market cap, revenue, profit, cash.
- **One screen per concept:** stock page, company dashboard, portfolio.
- **Crowd logic in one file** with tunable constants (pool sizes, activity rates, noise).
- **One new feature per season**, and watch its effect on the market before adding the next.

## Core v1

The whole v1 loop is: build → pitch → crowd reacts → price moves → players trade → repeat.

```
Build company → Pitch → Crowd reacts → Price moves → Players trade
      ↑                                                     │
      └──────────────── repeat each quarter ────────────────┘
```

1. **Companies:** a player founds a company, picks a sector, writes a pitch, sets a valuation and runs a funding round. Founder shares vest over time (no instant rug pull). At a size threshold the company IPOs and trades publicly on an order book (coins keep the AMM).
2. **Simple business sim:** one spending dial (low / medium / high). Each "quarter" (1 real day, admin-configurable) the server turns spending × sector conditions × randomness into revenue and profit. A short earnings report is published. Cash at zero = bankrupt, shares go to 0.
3. **The 3-agent crowd:** three AI agents (retail, fund, trader) give buy/sell/hold probabilities that become crowd volume. Details below.
4. **CEO announcements + credibility:** founders post announcements; the crowd reacts. Claims that later prove false lower credibility, so retail stops believing that founder.
5. **Sentiment bar + "explain the move":** each stock shows the mood of the three crowd types, and clicking a big price move shows why it happened. This is the educational layer, and it is almost free because the agents already produce the data.

## AI crowd

Three AI agents, each seeing different information, stand in for the whole market; their answer probabilities are converted into how much money the crowd buys or sells. Everything runs locally: a small local LLM reading BUY/SELL/HOLD probabilities from logprobs, or Laya if that falls short.

| Agent | Sees | Ignores | Behaves like |
| --- | --- | --- | --- |
| Retail | 24h chart, trending rank, comments, headlines | financials | emotional, fast, herd |
| Fund | earnings, P/E, cash/runway, sector, pitch quality | hype, comments | slow, rational, big money |
| Trader | volume, order flow, momentum, fresh news | long-term fundamentals | short-term, in and out |

The crowd trades stocks and, if enabled by an admin, coins too.

### Probabilities to volume

Per stock per tick, each agent answers BUY / SELL / HOLD with probabilities, e.g. buy 0.6, sell 0.1, hold 0.3. Each agent type has a capital pool and an activity rate:

```
pressure = pBuy - pSell              // -1..1
activity = 1 - pHold
flow     = pool × activityRate × activity × pressure × noise
```

- The three flows are summed into one net crowd order, placed on the order book as many small randomized orders over the tick so the feed looks like many people; the crowd also keeps resting bid/ask orders so the book is never empty. (Coins: the net order goes into the AMM.)
- Agreement between agents = big price move; disagreement = high volume, flat price.
- Funding rounds use the same system: each agent's buy probability decides how much of the round its crowd fills (traders mostly skip private rounds).

### Crowd state

- Each agent type is a "mega account" per stock with real cash and shares: it cannot sell what it doesn't own or spend cash it doesn't have, so the economy stays closed.
- Sentiment is smoothed (moving average) so prices don't jump between ticks.
- Lag: funds react to earnings immediately, retail reacts to news later, which gives attentive players a window.

### Performance

- 3 calls per stock per tick, batched where possible.
- Re-evaluate only on change: price moves more than X%, earnings, announcements, big player trades, or a slow timer (5–10 min). In between, keep applying the last flow with noise.
- Load: 50 stocks × 3 agents × every 5 min ≈ 30 calls/min, easy for a small local model; no per-call cost.

### Local model

Start with a small local LLM that reads its own answer probabilities; fine-tune Laya later only if speed demands it.

1. **Small LLM + logprobs:** a 3–8B open model (e.g. Qwen or Llama) on llama.cpp, answer constrained to exactly BUY / SELL / HOLD. The token probabilities of those three words are the agent's probabilities. Handles numbers and pitches zero-shot.
2. **Log every decision:** store context + probabilities for each call.
3. **Laya later:** if the LLM is too slow, fine-tune Laya on the logged decisions for a fast, game-specific model.

All models sit behind one `decide()` function so they can be swapped. Zero-shot classifiers (e.g. DeBERTa) are fast but weak on numbers, so they are at most an option for the retail agent.

**Hardware:** a GTX 1060 home server (3GB or 6GB, not yet checked). Use llama.cpp or Ollama (vLLM does not support this card). 6GB: a 3–4B model at 4-bit; 3GB: 1–3B. Estimated under a second per call, enough for ~30 calls/min (untested). Keep the fixed prompt at the start so llama.cpp can reuse it.

- [ ] Check 1060 VRAM (3GB or 6GB)
- [ ] Pick the model and test accuracy on sample stock situations

## Risks and balancing

The main risk is a crowd that is either predictable (farmable) or runs away in a feedback loop.

| Risk | What happens | Counter |
| --- | --- | --- |
| Predictability | players learn the formula and front-run the crowd | noise, random tick timing, hidden pool sizes |
| Feedback loop | crowd buys → "trending" → retail buys more → runaway | cap flow per tick; funds sell when overvalued |
| Hype manipulation | players spam comments to pump a stock | weight comments by account age/reputation; limit what retail sees |
| Infinite money | crowd pools drain or inflate the economy | fixed pools that grow slowly; crowd holds real shares |
| Local model quality | weak or inconsistent decisions | one `decide()` interface so models can be swapped; log answers to fine-tune Laya later |

## Decisions

| Question | Decision |
| --- | --- |
| Audience | mainly teens/students: short words, tooltips, no lectures |
| Quarter length | 1 real day, admin-configurable (daily earnings rhythm) |
| Market type | AMM for coins, order book for stocks |
| Crowd trades coins? | yes; admins can switch it on/off and set the crowd's coin pool size |
| Short selling | skip in v1; add later as a season feature once the order book works |
| AI model | local only: small LLM + logprobs first, Laya later |

## Later and cut

Only v1 gets built first; the rest waits until the core loop proves fun.

**Maybe later:** short selling, interest rate dial, shareholder votes and takeovers, weekly recap newspaper, random events and scandals.

**Cut for now:** options, bonds, mergers, short reports, penny stock market, historical scenarios, insider trading mechanic.

## Sources

- [Jev vs Laya comparison (Respan)](https://www.respan.ai/articles/jev-vs-laya)
- [Jev on LLM Reference](https://www.llmreference.com/model/jev)
