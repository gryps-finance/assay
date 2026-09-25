# Assay

**Nansen tells you what smart money did. Assay tells you what that has been worth, and hands your agent today's signals with that measurement attached.**

Assay sits between Nansen's data and an agent's order. It does four things:

1. **Measured priors.** Six Nansen flow segments at three holding horizons, measured on **12,781 real API calls** with a method sealed before the first call. Every prior is in basis points, with a block-bootstrap standard error, an effective sample size, a p-value, and the multiplicity-adjusted bar it was judged against. No key needed to read them.
2. **Live signals, gated.** `assay now` pulls today's flows, turns them into signals by the study's own rules, and joins each one to its measured prior and a decision: **trade** (sized on the standard error), **hold** (real, but costs eat it), **skip** (no edge beyond drift), or **refuse** (never measured).
3. **Live Hyperliquid positioning.** `assay positioning` reads where every large position on a market liquidates and who holds it, and whether smart money sits on the other side of a crowd that is paying funding. A sampler builds the history on a clock.
4. **Measure your own.** `assay study` runs the same pre-registered instrument over your own tokens and dates, and `assay score` turns the ledger into verdicts.

It runs as a **CLI**, an **MCP server** for any agent (Claude, Cursor, anything that speaks MCP), and a **Claude plugin**. Zero dependencies: Node 18+ and nothing to install.

**See the study:** [gryps-finance.github.io/assay](https://gryps-finance.github.io/assay/) renders all eighteen verdicts, the cost at which each would turn, what an agent that traded them would expect, and the window audit, straight from the engine's output. [The instrument check](https://gryps-finance.github.io/assay/check.html) runs the same page over a world with a planted edge, to show the instrument finds one when it is there.

> Powered by Nansen API.

---

## Quickstart (about five minutes)

```bash
git clone https://github.com/gryps-finance/assay.git
cd assay

# no key: what the study measured
node src/cli.mjs leaderboard
node src/cli.mjs prior "Smart Trader" 48
node src/cli.mjs audit

# with a key (app.nansen.ai/api), set in your shell only
export NANSEN_API_KEY=...            # PowerShell: $env:NANSEN_API_KEY = "..."
node src/cli.mjs now                 # about 100 credits: today's signals, each with its prior and a decision
node src/cli.mjs positioning         # about 65 credits: live Hyperliquid positioning

# the whole instrument against mock venues, no key
npm test                             # 206 checks
```

`assay now` prints one line per signal: the flow, the prior the study measured for that segment (here at 24 hours), the verdict, and the decision. This is a run against the mock venue in `test/` (the flows are synthetic; the priors are the real ones):

```
  ASSAY NOW  Nansen flows for 2026-06-15, 20 of 20 tokens read
  priors: daily arm of the study, scored 2026-09-20T00:26:42.834Z, 12 bps round trip, 18 hypotheses

  SEGMENT        TOKEN     FLOW  SIDE  24h PRIOR (net ± SE bps)   VERDICT       DECISION
  Smart Trader   AAVE   -$1.90M  short -40.4 ± 47.1  (n 222)      fail-signal   skip
  Exchange       XVS    +$3.30M  long  -9.6 ± 9.7  (n 4912)       fail-signal   skip
  Fresh Wallets  TWT    +$4.96M  long  -19.6 ± 9.0  (n 5308)      fail-signal   skip
  ...
  60 live signals; 0 tradeable on their measured prior. Acting on all of them at 24h
  carries a measured net of -15.4 bps each at 12 bps round trip.
```

---

## What the study found

Pre-registered on 2026-09-16, amended once on 2026-09-19 before any call, run on 2026-09-19: 20 tokens across Ethereum, Solana, Base and BNB (SOL and PYTH were excluded at resolution, and the reason is recorded), 18 months, one call per token per day. Six segments times three horizons is 18 hypotheses, so the bar is p < 0.05/18.

**No segment's flows predict returns beyond drift at any horizon.** All 18 pairs read `fail-signal`. The largest excesses:

| segment | horizon | excess over drift | net of 12 bps | ± SE | n | p |
|---|---|---|---|---|---|---|
| Public Figure | 24h | +59.5 | +47.5 | 51.9 | 128 | 0.26 |
| Top PnL | 168h | +23.3 | +11.3 | 17.5 | 2,420 | 0.17 |
| Whale | 24h | -36.1 | -48.1 | 21.1 | 1,358 | 0.085 |
| Exchange (negative control) | 24h | +2.4 | -9.6 | 9.7 | 4,912 | 0.80 |

The negative control behaves: `Exchange` flow is movement, not conviction, and it reads `fail-signal` at every horizon. The instrument is not inventing edge. On the synthetic world in `test/`, the same instrument recovers a planted 160 bps edge as 159.0 and a planted 81.3 bps edge as 82.7, so a real edge would have shown.

What this means for an agent: "smart money net-bought $2M of X yesterday" is not, by itself, a reason to size a position on X. An agent that trades those signals pays the round trip for nothing; an agent gated on Assay's priors doesn't take them. `node src/cli.mjs leaderboard` prints all 18 rows. `FINDINGS.md` has the rest.

### A second finding, for anyone backtesting on Nansen's historical flows

A multi-day window from `tgm/historical-token-flow-summary` is **not the sum of daily calls over the same days**. The audit rebuilt every one of 1,558 weekly and 380 monthly windows from its days nine ways:

- for `fresh_wallets` the window is exactly its **last day** (1,957 of 1,957 pairs);
- for the other five segments no rebuild reproduces it; the closest is usually a short trailing window (two days at weekly resolution, seven to ten at monthly).

So: call at the resolution you will act on, and never sum short windows into long ones or read a long window as a sum. `node src/cli.mjs audit` prints it; `AUDIT-CONVENTION.md` has the method.

---

## Use it from an agent

The MCP server speaks JSON-RPC over stdio and needs nothing installed. Readers need no key; the two tools that pull live (`assay_now`, `hl_refresh`) need `NANSEN_API_KEY` in the server's environment and have a hard per-call credit cap (500, set by `ASSAY_MAX_CREDITS_PER_CALL`).

**Claude Code**

```bash
claude mcp add assay -- node /absolute/path/to/assay/src/mcp-server.mjs
```

**Claude Desktop, Cursor, or any MCP client** (the client's MCP config file):

```json
{
  "mcpServers": {
    "assay": {
      "command": "node",
      "args": ["/absolute/path/to/assay/src/mcp-server.mjs"],
      "env": { "NANSEN_API_KEY": "only if you want live pulls" }
    }
  }
}
```

**As a Claude plugin:** the repository root is the plugin (`.claude-plugin/plugin.json`, `.mcp.json`, and `skills/assay/SKILL.md`, which teaches the agent how to read the answers).

| tool | what it returns | key |
|---|---|---|
| `assay_prior` | the measured prior for one segment at one horizon | no |
| `assay_leaderboard` | all 18 pairs, ranked, with their verdicts | no |
| `assay_explain` | the reading in words, and what it does not license | no |
| `assay_lookahead` | what a multi-day window of the historical flow summary returns | no |
| `assay_signal_now` | the latest live pull for one segment, each signal with its decision | no |
| `assay_now` | runs the live pull now | yes |
| `hl_status`, `hl_liquidation_map`, `hl_crowding`, `hl_smart_money_tape`, `hl_series` | the sampled Hyperliquid positioning | no |
| `hl_refresh` | runs a light live positioning pass now | yes |

Ask your agent "smart money bought AAVE yesterday, should I go long?" and it gets the flow, the prior measured for that segment, and **skip**, with the reason. That refusal to act on an unmeasured signal is the design: an agent handed a raw signal treats confidence as edge.

More contexts (a Node library, a cron job on a server, reading the ledgers from another agent or a dashboard, running your own study) and the JSON shapes: **[docs/USAGE.md](docs/USAGE.md)** and **[docs/RUNNING.md](docs/RUNNING.md)**.

---

## How it measures

- **A flow becomes a falsifiable claim.** A net flow of at least $250k into a token (the segment's ten strongest that day) becomes "this token beats its own drift over the next 24, 48 or 168 hours", dated the first instant the day's data exists, with its entry price. No code path that forms a claim can see an outcome.
- **Every claim gets a drift-matched control**: the same token, direction and holding period, entered at a random offset within three days, from a fixed seed. Subtracting it removes the market and leaves the claim.
- **Honest errors.** Holding windows overlap, so `sd/√n` understates the error; Assay uses a block bootstrap and reports the effective sample size. Sizing uses quarter-Kelly on the outcome variance plus the estimate's variance, capped at 25% of the book.
- **Two failures, never one.** `fail-signal` (no content beyond drift) and `fail-economic` (real, but costs eat it) are opposite instructions. The second says "change the venue, horizon or expression", and it would be thrown away by any tool that just reports "no edge".
- **Sealed in advance.** `PREREGISTRATION.md` (sha256 `bf3024fb33a53051…`) and `PREREGISTRATION-AMENDMENT-1.md` (`88328d592759d830…`) were written before any call. The run's manifest (`ledger/study/study-manifest.json`, written as the run started) records both hashes, and the Nansen request id of every flow call on the ledger is in `ledger/study/receipts.jsonl`.
- **Reproducible.** Re-scoring the full ledger in a clean environment reproduces `verdicts.json`, `study.json` and `sweep.json` exactly, timestamps aside.

## What ships in `ledger/study`, and what doesn't

The verdicts, the priors, the cost sweep, the window audit, the run manifest, the spend report, and a **receipt for every flow call on the ledger** (12,760, one per call key): its request id, the credits it cost, and a SHA-256 of the response. The raw responses stay with whoever made the calls: Nansen's redistribution rules keep raw API data with the caller, and the `.gitignore` does the same for your own runs. Nansen can confirm every call from its request id. Anyone with a key can re-run the study with `assay study` and compare.

## Honest limits

- The priors are measured on 20 large tokens over 18 months at daily resolution. A token outside that universe gets its segment's prior with a note that it is an extrapolation.
- The Hyperliquid positioning read is a measurement with an age, not a validated signal. `PREREGISTRATION-HL.md` fixes six tests (crowding against funding, liquidation proximity against realised volatility, smart-money skew against returns) that score the sampled panel once 30 days of samples exist, with a label-free control for each.
- The economics are a closed-form expectation, not a backtest. Slippage beyond the flat cost, capacity, funding and correlation between positions each make the real figure worse.

---

## Built by

The **Gryps** agent desk. Gryps builds institutional perpetuals on SEI; we built Assay to decide which on-chain signals our own agents may act on, and publish it so any agent can make the same decision with the same evidence. Built for the Nansen Meridian Buildathon, September 2026.

MIT licensed. Data: Nansen API.
