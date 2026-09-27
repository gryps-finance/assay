---
name: assay
description: >
  This skill should be used when the user asks what a Nansen smart-money signal
  is worth, whether a flow segment "has edge", how to size a position on an
  on-chain signal, "is this cohort tradeable", "show me the assay leaderboard",
  "what's the prior for smart traders at 48 hours", asks how Nansen's
  historical flow endpoint behaves over multi-day windows, or asks about
  Hyperliquid perp positioning: "where do the liquidations sit on HYPE", "is
  smart money short ETH", "what did smart money do on Hyperliquid today",
  "which markets have a carry setup", "show me the liquidation map". It reads
  measured priors and sampled positioning from the Assay MCP server and never
  supplies a number the ledger has not earned.
---

# Assay — measured priors, not badges

Assay turns "smart money is accumulating X" into a number an agent can size
on: the paired excess return of a flow segment at a horizon, net of a stated
round-trip cost, with its block-bootstrap standard error, effective sample
size, p-value and the Bonferroni bar it was judged against. Every verdict is
one of four, and the middle two are never collapsed:

| verdict | meaning | what it licenses |
|---|---|---|
| `economic` | real, clears costs | a position, sized on the standard error |
| `fail-economic` | real, costs eat it | a cheaper venue, a longer horizon, a passive expression — not abandonment |
| `fail-signal` | no content beyond drift | nothing; and not the reverse trade |
| `insufficient` | too few matured pairs | nothing; absence is not a negative result |

## How to answer

1. For a specific segment and horizon, call `assay_prior` with the segment's
   display name (`Whale`, `Public Figure`, `Top PnL`, `Smart Trader`,
   `Exchange`, `Fresh Wallets`) and the horizon in hours (24, 48 or 168).
   Report `netMeanBps`, `standardErrorBps`, `effectiveN`, `pValue` and the
   verdict. Size on `standardErrorBps` (the block-bootstrap one), never on
   `iidStandardErrorBps`, and say so if the user is sizing.
2. For "what's tradeable", call `assay_leaderboard` and report the split:
   how many pairs are `economic`, how many `fail-economic` (real but priced
   out — the set a cheaper execution path converts), how many `fail-signal`.
3. For "why", call `assay_explain` and relay `whatThisDoesNotLicense`
   verbatim — it is the part people skip.
4. For today's signals, call `assay_now` to pull them live (it spends about
   5 Nansen credits per token and needs a key in the server's environment;
   if it refuses for want of a key, say so and carry on with the priors), then
   report its headline: how many signals, how many are tradeable, and the
   measured net of acting on them. For one segment afterwards, call
   `assay_signal_now`; each signal carries its decision (trade, hold, skip,
   refuse) and the reason. If it refuses, say plainly that the pair has not
   been measured, which is different from having been measured and found
   empty. Never size on the flow's dollar amount: the prior decides.
5. If the user is building a backtest on Nansen's historical flow summary,
   call `assay_lookahead` first and relay its headline: a multi-day window is
   NOT the sum of daily calls over the same days (for `fresh_wallets` it is
   exactly the last day; for the other segments no rebuild from daily calls
   reproduces it). Tell them to call at the resolution they will act on and
   never to sum short windows into long ones. Do not call the disagreement
   "look-ahead leak" — the audit withdrew that reading.

## Hyperliquid positioning (hl_*)

The `hl_` tools serve what a scheduled sampler has kept of Nansen's
point-in-time Hyperliquid endpoints. These are measurements with a sample
hour and an age, not validated signals; say so when the user is about to act.

6. Start with `hl_status` if anything refuses, or if the user asks how fresh
   the data is. Report the sample hours and their ages; if `stale` is set, say
   the sampler may have stopped. If nothing has been sampled, or it is stale
   and the user wants a live read, call `hl_refresh` (a light live pass: the
   venue-wide screener and the top markets' books, about 25 to 80 credits,
   needs a key) and then answer from it.
7. For "where are the liquidations" call `hl_liquidation_map` with the market
   and relay the `read` lines: the share of long notional liquidating within
   3 / 5 / 10 percent below the mark, the same for shorts above, the heaviest
   half-percent band on each side and who holds it, and the coverage of the
   book. A screener-only market is refused as absence — its positions were not
   pulled — and that is the answer, not an empty map.
8. For "is smart money short", "who is on the other side", "carry setup" call
   `hl_crowding` (one market, or all ranked by divergence). Report smart-money
   skew, crowd skew, divergence, funding annualised, and the `carrySetup`
   sentence when present. Skew is by notional: +1 all long, −1 all short.
9. For "what did smart money do" call `hl_smart_money_tape` with the window in
   hours; report net direction and the largest traders. It is what they did,
   not what they will do.
10. For history call `hl_series` with the metric name; `divergence`,
    `funding`, `smSkew`, `crowdSkew`, `liq.below.w5`, `liq.above.w5` are the
    usual ones.

## Rules

- A refusal from the server is the answer. Do not estimate around it.
- Always carry the cost the prior was measured at (`costRtBps`); a verdict at
  12 bps is not a verdict at 90.
- `Exchange` is the study's negative control. If it ever reads `economic`,
  say the measurement is suspect before reporting anything else from the same run.
- Never present a synthetic (replay) verdict as a finding about a real segment;
  the `source` field says which it is.
- An `hl_` answer is a measurement at a sample hour. Always carry the sample
  hour and its age; never describe the crowding index or a liquidation band as
  a prediction — the pre-registered tests (PREREGISTRATION-HL.md) decide what,
  if anything, they predict, and until they do the honest word is "measured".
