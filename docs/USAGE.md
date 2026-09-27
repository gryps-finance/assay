# Using Assay

Assay is one tool with four surfaces: a **CLI**, an **MCP server**, a **Claude plugin**, and plain **JSON ledgers** any program can read. They all read and write the same files, so a pull made from the CLI is what the agent sees, and a sampler run by cron is what a dashboard reads.

- [Keys, budgets and safety](#keys-budgets-and-safety)
- [The CLI](#the-cli)
- [In an agent (MCP)](#in-an-agent-mcp)
- [In your own code (Node)](#in-your-own-code-node)
- [Reading the ledgers from anything else](#reading-the-ledgers-from-anything-else)
- [The gating pattern](#the-gating-pattern)

---

## Keys, budgets and safety

- The key is `NANSEN_API_KEY` **in the environment of the process that makes the call**, and nowhere else. Assay never reads a key from a file, never writes one, and redacts it from every error and ledger line it produces. No key, no client: every command that would call Nansen refuses before its first request.
- Every live command has a **credit budget** (`--budget`) and refuses a call that would exceed it. Every one also keeps a **reserve** (`--reserve`, default 5,000): it will not draw the account below that balance, read from Nansen's own `X-Nansen-Credits-Remaining` header.
- The MCP server's live tools (`assay_now`, `hl_refresh`) are additionally capped per call by `ASSAY_MAX_CREDITS_PER_CALL` (default 500), whatever the agent asks for.
- Credits are charged by what Nansen reports (`X-Nansen-Credits-Used`), not by a price table, and every call's request id is kept.
- **What your queries reveal.** The positioning pass chooses its markets venue-wide, by open interest, so nothing in the pull tells a third party which markets you hold. `--market-list` exists for research; it does reveal them.
- **Raw data stays with you.** Raw replies land in `ledger/live/calls.jsonl`, `ledger/hl/raw/` and your study's `calls.jsonl`, all ignored by git. Nansen's redistribution rules keep raw API data with whoever made the call. Before you publish anything derived from it, read Nansen's [redistribution guide](https://docs.nansen.ai/guides/redistribution-guide). As of 2026-09-27 it puts endpoints in three tiers: some may never be redistributed (address labels, smart-money holdings, the PnL and perp leaderboards, smart-money DEX trades, DCAs and perp trades); some need Nansen's approval and significant transformation first (holders and perp positions with the smart-money filter, smart-money inflows); the rest, including the perp screener, the flow endpoints and perp positions without the smart-money filter, may be shown with "Powered by Nansen API" or a link to nansen.ai beside the data. Assay's public outputs follow that: the statistics of its study, request-id receipts, and on its demo page the tool's own tables from real runs with attribution; the sampled positioning files, the smart-money tape and the map's holders by cohort stay on the machine that sampled them.

---

## The CLI

`node src/cli.mjs <command>` (or `assay <command>` if you `npm link`). Defaults point at the repository's own ledgers from any working directory; an explicit flag always wins.

| command | what it does | key | typical credits |
|---|---|---|---|
| `leaderboard` | all 18 measured pairs, ranked, with verdicts | no | 0 |
| `prior <segment> <hours>` | one prior as JSON, e.g. `prior "Top PnL" 168` | no | 0 |
| `audit` | what a multi-day window of the historical flow summary returns | no | 0 |
| `now` | today's flows → signals → priors → decisions | yes | 5 per token (100 for 20) |
| `positioning` | live Hyperliquid positioning for the top N markets | yes | about 65 for 3 markets |
| `study` | run the measured study over your universe and dates | yes | see `--dry-run` |
| `score` | score a study ledger into verdicts, priors and a cost sweep | no | 0 |
| `sample` | one pass of the Hyperliquid sampler (for a scheduler) | yes | see `--dry-run` |
| `derive` | maps, crowding, series and recent history from the sampler's ledger | no | 0 |
| `mcp` | the MCP server over stdio | readers no | 0 |

**`now` options.** `--date YYYY-MM-DD` (default: the last complete UTC day), `--tokens WETH,PEPE`, `--universe my-tokens.json` (a list of `{ chain, symbol, address }` on ethereum, solana, base or bnb), `--priors <dir>` (default the shipped study), `--out <dir>` (default `ledger/live`), `--budget`, `--reserve`, `--tier free|pro`, `--limit 20` (rows printed, the largest flows first; the file keeps every signal), `--all`, `--json`, `--dry-run`.

A token outside the measured universe gets its segment's prior with a note saying that is an extrapolation.

**`positioning` options.** `--markets 3` (1 to 10), `--top-positions 1000`, `--ledger ledger/hl`, `--budget`, `--reserve`, `--tier`, `--json`.

---

## In an agent (MCP)

The server is `src/mcp-server.mjs`: JSON-RPC 2.0 over stdio, zero dependencies.

**Claude Code**

```bash
claude mcp add assay -- node /absolute/path/to/assay/src/mcp-server.mjs
```

Start Claude Code from a shell that has `NANSEN_API_KEY` set if you want the live tools; the readers work without it.

**Claude Desktop, Cursor, Windsurf, or any MCP client**

```json
{
  "mcpServers": {
    "assay": {
      "command": "node",
      "args": ["/absolute/path/to/assay/src/mcp-server.mjs"],
      "env": {
        "NANSEN_API_KEY": "optional: only for assay_now and hl_refresh",
        "NANSEN_TIER": "pro"
      }
    }
  }
}
```

**As a Claude plugin.** The repository root is a plugin: `.claude-plugin/plugin.json` names it, `.mcp.json` starts the server with the ledgers inside the plugin, and `skills/assay/SKILL.md` tells the agent how to read what the server returns (which standard error to size on, why a refusal is not a zero, what a verdict does not license).

**Environment the server reads**

| variable | default | meaning |
|---|---|---|
| `ASSAY_LEDGER_DIR` | `<repo>/ledger/study` | the measured priors |
| `ASSAY_LIVE_DIR` | `<repo>/ledger/live` | where `assay now` / `assay_now` write today's signals |
| `HL_LEDGER_DIR` | `<repo>/ledger/hl` | the Hyperliquid positioning ledger |
| `ASSAY_MAX_CREDITS_PER_CALL` | 500 | hard cap per live tool call |
| `ASSAY_RESERVE` | 5000 | the account balance live tools never draw below |
| `NANSEN_API_KEY`, `NANSEN_TIER` | none, `free` | only for the live tools |

**What to ask.** "Is smart money's flow in AAVE worth trading at 48 hours?" (`assay_prior`), "pull today's signals" (`assay_now`), "anything tradeable today?" (`assay_signal_now` per segment), "where do the liquidations sit on ETH?" (`hl_liquidation_map`), "is smart money on the other side of the crowd anywhere?" (`hl_crowding`), "I'm backtesting on the historical flow summary with weekly windows" (`assay_lookahead`).

---

## In your own code (Node)

Everything is plain ES modules with no dependencies. Import from `src/`.

```js
import { NansenClient } from './src/nansen.mjs'
import { runNow, loadUniverse } from './src/now.mjs'
import { readFileSync } from 'node:fs'

const verdicts = JSON.parse(readFileSync('ledger/study/verdicts.json', 'utf8'))
const client = new NansenClient({
  apiKey: process.env.NANSEN_API_KEY,   // refuses to construct without it
  creditBudget: 150,                    // refuses any call past it
  remainingFloor: 5000,                 // never draws the account below this
  tier: 'pro',
})
const universe = loadUniverse({ priorsDir: 'ledger/study' })
const out = await runNow({ client, date: '2026-09-23', universe, verdicts })

for (const s of out.signals) {
  const h48 = s.horizons.find((h) => h.horizonHours === 48)
  if (h48.action === 'trade') console.log(`${s.cohort} ${s.direction} ${s.subject}: ${(h48.fraction * 100).toFixed(2)}% of book`)
}
console.log(out.summary.headline)
```

Other entry points: `decide(result, costRtBps)` and `priorFor(verdicts, cohort, hours)` in `src/now.mjs`; `kellySize(prior)` and `agents({ pairs, costRtBps, adjustedAlpha })` in `src/economics.mjs`; the sampler (`Sampler` in `src/hl-sample.mjs`), `derive` in `src/hl-derive.mjs`, and `callHlTool(name, args, ledgerDir)` in `src/hl-tools.mjs`, which returns exactly what the MCP tools return.

---

## Reading the ledgers from anything else

A dashboard, a second agent, or a job in another language can read the files directly. All are JSON; all carry their own timestamps.

**`ledger/live/live-signals.json`** (written by `assay now`; example values)

```jsonc
{
  "kind": "assay-live-signals",
  "date": "2026-09-23",                  // the UTC day the flows describe
  "claimAtIso": "2026-09-24T00:00:00Z",  // the first instant that day's data exists
  "priors": { "from": "daily arm of the study, scored …", "costRtBps": 12, "searchCount": 18 },
  "summary": { "signals": 31, "tradeable": 0, "byAction": { "trade": 0, "hold": 0, "skip": 93, "refuse": 0 }, "headline": "…" },
  "signals": [{
    "cohort": "Smart Trader", "subject": "AAVE", "chain": "ethereum", "direction": "short", "flowUsd": -1900000,
    "requestId": "…",
    "horizons": [{ "horizonHours": 24, "verdict": "fail-signal",
                   "prior": { "netMeanBps": -40.41, "standardErrorBps": 47.1, "n": 222, "effectiveN": 190, "pValue": 0.55 },
                   "action": "skip", "fraction": 0, "why": "…" }]
  }],
  "spend": { "calls": 20, "creditsSpent": 100, "accountRemaining": 136105 }
}
```

**`ledger/hl/derived/latest.json`** (written by `assay derive`, and by `positioning`; example values)

```jsonc
{
  "asOf": { "screener": "2026-09-24T16", "positions": "2026-09-24T12", "tape": "2026-09-24T14" },  // sample hours, UTC
  "credits": { "remaining": 128400, "atIso": "…", "spentLast24h": 1416 },
  "markets": {
    "ETH": { "kind": "positions", "mark": 4210.5, "funding": 0.0000125, "fundingAnnualised": 0.1095, "oi": 6.1e8,
             "smSkew": 0.22, "crowdSkew": 0.16, "divergence": 0.06, "coverage": 0.83,
             "liq": { "below": { "w3": 0.001, "w5": 0.321, "w10": 0.321, "largest": { "from": -0.04, "to": -0.035, "share": 0.161 } },
                      "above": { "w3": 0, "w5": 0, "w10": 0 } } },
    "DOGE": { "kind": "screener", "mark": 0.24, "funding": 0.00001, "oi": 1.9e8, "smSkew": -0.31 }
  }
}
```

`kind: "positions"` markets have a full book (liquidation map, crowd skew, divergence); `kind: "screener"` markets carry funding, open interest and the smart-money skew for every market on the venue.

**`ledger/hl/derived/recent.json`**: the last seven days, one point per positions sample per market (`divergence`, `smSkew`, `crowdSkew`, `funding`, `liqBelow5`, `liqAbove5`, `coverage`), small enough to ship every hour. **`series.jsonl`** is the full panel, one row per market per sample hour; **`tape.jsonl`** is the de-duplicated smart-money perp tape.

Skew is `(long notional − short notional) / (long + short)`: +1 all long, −1 all short. Liquidation shares are of mapped notional on that side, within 3, 5 or 10 percent of the mark.

---

## The gating pattern

If you take one thing from Assay into your own agent, take this:

```text
before acting on any on-chain signal:
  look up the measured prior for the signal's segment and horizon
  if none exists           → refuse (never measured is not the same as no edge)
  if verdict = fail-signal → skip   (and never the reverse trade: failing to predict is not predicting the opposite)
  if verdict = fail-economic → hold (real but priced out; a cheaper venue or a longer horizon is the lead)
  if verdict = economic    → size on the prior: fraction = k · μ / (σ² + SE²), capped
```

The size of today's flow never enters the decision: the study measured the segment's claims, not their size, and five sources lighting up at once is five correlated readings of the same thing.
