---
type: prereg
venture: gryps
project: assay
from: mango
date: 2026-09-20
sealed: 2026-09-27
status: SEALED by M. Dogwood on 2026-09-27, before the first scheduled sample, from the probe's readings (§10). The probe sample 2026-09-27T12 (schema and cost check, 49 credits) and the one-off run 2026-09-27T17 sit in their own ledger directories and are not part of the panel.
sampling: src/hl-sample.mjs ; derivation: src/hl-derive.mjs ; scoring: src/hl-score.mjs (to be written before the floor is reached; refuses to run before it)
---

# Pre-registration — labelled positioning on Hyperliquid perps

## 0. Why this, after the flow study

The flow study (PREREGISTRATION.md, Amendment 1, RECORD §13) asked whether
Nansen's labelled *flows* predict returns on large tokens at daily resolution
and found they do not, with the negative control passing. It also found that
the endpoint's multi-day windows are not sums of days (AUDIT-CONVENTION.md).
The labels were not the problem; the question was. A perps desk does not need
to know whether whales bought yesterday; it needs to know where the open
positions are, who holds them, where they liquidate, and whether the informed
cohort is on the other side of the crowd while the crowd is paying funding.
Nansen serves exactly that on Hyperliquid — but only as of now. There is no
history to buy. This study builds the history and tests, in advance, what it
should predict.

## 1. What is sampled

Three passes on a clock (UTC), every call kept as a raw page under
`ledger/hl/raw/<sample-hour>/` and one row per call in `ledger/hl/samples.jsonl`:

| pass | cadence | what | calls |
|---|---|---|---|
| screener | hourly, at :05 | every Hyperliquid perp market: volume, buy/sell pressure and trader count over the hour; mark, funding and open interest now; the smart-money, whale and public-figure books (longs, shorts, counts) | 4 |
| positions | every six hours (00 06 12 18 UTC), at :10 | the ten markets with the most open interest at that sample: the largest positions of everyone (the sampler asks for 2,000; the endpoint returns at most 1,000 per market and marks the pull capped, §10), plus every smart-money, whale and public-figure position (address, label, side, notional, leverage, entry, mark, liquidation price, funding paid, unrealised PnL) | 40 |
| tape | every two hours, at :15 | smart-money perp trades over the trailing three hours, de-duplicated by transaction into a continuous record | ~2 |

Derivation (`src/hl-derive.mjs`, no key) runs hourly at :25 and writes one
series row per market per sample hour: funding, open interest, mark, volume,
pressure ratio, the smart-money skew (venue book), the crowd skew (captured
positions, smart money excluded), their divergence, the liquidation shares
within 1/2/3/5/10/20 percent below the mark (longs) and above (shorts), the
heaviest half-percent band on each side with its holders, unmapped notional,
and coverage (captured notional over twice open interest).

## 2. Definitions

- **Skew** of a book = (long notional − short notional) / (long + short).
  +1 all long, −1 all short.
- **Smart-money skew** = the venue's full smart-money book from the screener
  (`current_smart_money_position_longs_usd`, `…shorts_usd`), not the capped
  positions pull.
- **Crowd skew** = skew of the captured all-traders positions with smart-money
  addresses removed.
- **Divergence** = smart-money skew − crowd skew. Negative: the informed cohort
  is shorter than the crowd.
- **Liquidation share within x%** on a side = notional whose liquidation price
  lies within x% of the mark on that side, over the side's mapped notional.
  Positions without a liquidation price are UNMAPPED and excluded from the
  denominator; their share is reported beside it.
- **Funding** as the venue reports it per period; annualised ×24×365 for
  display only.
- **Outcomes** are priced from Nansen's Hyperliquid OHLCV 1h tape
  (`historical-token-ohlcv`, chain `hyperliquid`), fetched at scoring time —
  one vendor's clock for signal and outcome, as in the flow study. Realised
  volatility over a horizon = √Σ(hourly log returns²). A **cascade** on the
  long side within 24h = the low of the next 24 hourly candles at or below
  mark × (1 − 3%); mirror for the short side.

## 3. Hypotheses — six tests, fixed now

| # | predictor at sample t | outcome | control (label-free) | expectation |
|---|---|---|---|---|
| H1a | divergence | mean funding over the next 24h | current funding, pressure ratio, ΔOI over the last 6h | two-sided; sign reported either way |
| H1b | divergence | mean funding over the next 72h | same | two-sided |
| H2a | long share within 5% below + short share within 5% above (the side with the larger share, signed) | realised volatility over the next 24h | trailing 24h realised volatility, open interest | positive |
| H2b | the same shares | a cascade on that side within 24h (binary) | trailing 24h realised volatility | positive |
| H3a | smart-money skew | mark return over the next 24h, in the direction of the skew, net of 12 bps | crowd skew, funding | null expected |
| H3b | smart-money skew | the same over 72h | same | null expected |

**Statistics.** Pooled panel across markets: for each test, the Spearman
rank correlation between the predictor and the outcome residualised on the
controls (rank-IC), and a linear (H2b: logistic) coefficient with market fixed
effects. Standard errors by block bootstrap over calendar days (K = 2,000;
blocks of √n days), because samples six hours apart are not independent.
**Bar:** Bonferroni over the six tests, p < 0.05 / 6 = 0.0083. A test is
`signal` only when it clears the bar in the expected direction (H1: either
direction), `fail-signal` otherwise, `insufficient` below the floor.

**The label-free bar.** Every predictor here uses Nansen's labels. Each test
is run twice: with the labelled predictor alone, and with the label-free
controls that anyone can compute from the venue's public data. The reported
result is the labelled predictor's contribution *beyond* the controls. A
labelled measure that only restates funding and open interest is not a
finding about the labels.

**Reference distribution.** Alongside the bootstrap, a permutation test: the
predictor shuffled across sample hours within each market, 2,000 times. The
observed rank-IC is reported with its rank in that distribution. The
permuted panel must read null on every test; if it does not, the scorer is
wrong and nothing is published until it is understood.

## 4. The floor, and no peeking

Scoring runs only when the panel holds **at least 30 calendar days of
positions samples for at least eight markets** (≥ 120 six-hourly samples
each). `src/hl-score.mjs` checks the ledger and refuses below the floor; there
is no flag to override it. Until then the tools serve every measurement
labelled "not validated", which is what it is. The first eligible scoring
date is written into the ledger when the first scheduled sample lands.

## 5. Universe drift

The ten markets with the most open interest are re-ranked at every positions
sample. A market enters the analysis when it has ≥ 120 samples; a market that
drops out of the top ten keeps its history and stops accruing. This is stated
so that a market entering late is not read as a market with a short history
of signal.

## 6. Budget

Measured on the probe (§10): screener 1, positions 5 and trades 5 credits per
call, whatever the page holds. At those prices: screener 96/day, positions
800/day (40 calls a pass, four passes), tape ~120/day — about **1,000
credits a day, ~31,000 over the 30-day floor**, against a balance of 136,166
after the probe. The sampler refuses any call that would take the account
below a 5,000-credit reserve and stops a pass at its own budget (2,000 credits
per run). The eight-hourly fallback the draft held in reserve, for positions
priced above 10 credits a call, is not triggered; the six-hourly cadence
stands.

## 7. Falsifiers, stated in advance

- **H1 null:** the crowding index is a description of who is positioned
  where, published as such, and is *not* a carry-selection input. The tools
  keep serving it as a measurement.
- **H2 null:** liquidation proximity does not forecast volatility or cascades
  on this panel beyond trailing volatility. The map remains what it is by
  construction — a conditional statement, *if* the mark reaches this level
  this much notional liquidates, held by these cohorts — which is a fact about
  the book and a sizing input for worst cases, not a forecast. It is published
  as that.
- **H3 null:** expected; consistent with the flow study. Published.
- **Any positive:** published with the label-free comparison beside it, the
  permutation rank, and the sample. Nothing trades on it until an
  out-of-sample window (the next 30 days) confirms it under this same
  document.

## 8. What is published either way

The scorer's output (the statistics of §3 for every test, labelled and
label-free, with the permutation rank and the sample), the credits spent by
pass, the coverage per market per sample, every refused or shape-refused row
with the venue's note, a request-id receipt for every call, and this document
with its seal. The sampled and derived files themselves (`ledger/hl/raw/` and
`ledger/hl/derived/`: positions, the smart-money tape, the per-market series
and maps) stay on the machine that sampled them, under Nansen's redistribution
guide, which does not allow smart-money trades to be republished and asks for
significant transformation and Nansen's approval before anything built on
positions is. The draft of this section listed `ledger/hl/derived/` among the
published files; that was wrong, and it is corrected here, before any
scheduled sample.

## 9. Amendments

Any change after the first scheduled sample is an amendment: filed
separately, dated, and carried into the scorer's output. The probe sample is
not the first scheduled sample.

## 10. The probe, read before sealing

One sample of every pass at 2026-09-27T12 UTC, ledger `hl-probe`, two markets
(BTC, ETH), 13 calls, 49 credits, 136,166 left; and one run of the
`positioning` command at 2026-09-27T17 UTC, ledger `hl-oneshot`, three
markets (BTC, ETH, HYPE), 16 calls, 64 credits. Neither is part of the panel.
What they showed, and what this document does about each:

- **Costs.** Screener 1 credit, positions 5, trades 5, per call, whatever the
  page holds. §6 is written at these prices.
- **Screener.** All four trader types accepted (`all`, `smart_money`, `whale`,
  `public_figure`), each in one page: 469 markets at 12h; 504, 504, 310 and 80
  at 17h. No row shape-refused. The derivation wrote 480 series rows for 480
  markets at 12h.
- **Positions, all traders.** The endpoint returns at most 1,000 positions per
  market and marks the pull `capped`, on every market tried. §1 asks for 2,000
  and records what comes back. Coverage (captured notional over twice open
  interest, §1) read 0.4413 on BTC (the screener's trader count 1,165) and
  0.4805 on ETH (463) at 12h. The liquidation map and the crowd skew are
  therefore built on the largest positions, covering about half of the book's
  notional, and every surface that serves them says so beside the number.
- **Positions, labelled.** Smart money 97 to 115 positions per market, public
  figures 36 to 53. The `whale` type returns exactly one row per market, state
  ok, on every market tried. It is recorded as returned; no test in §3 uses the
  whale positions, and the map reports whale holdings as the endpoint gives
  them.
- **Tape.** 893 smart-money trades over the trailing three hours at 12h, one
  call.
- **The key** was never printed by any pass, and no pass was given a market
  list: markets came from the venue-wide screener, ranked by open interest.

The clock is registered after this seal. Its cron lines run on the host's
local clock; the sample hours in §1 are UTC, and the wrappers hold to them.

---

**Sealed by:** M. Dogwood, 2026-09-27, before the first scheduled sample;
probe sample 2026-09-27T12 (ledger `hl-probe`) and the one-off run
2026-09-27T17 (ledger `hl-oneshot`) excluded. The SHA-256 of this file as
sealed is recorded in the commit that carries it and in the go message to the
host; the host checks it before the clock is registered.
