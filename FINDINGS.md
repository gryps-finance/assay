# Findings

What the study measured, what the audit found, and what it means for an agent. Every number here is re-derivable from `ledger/study`: `node src/cli.mjs leaderboard` prints the table, `node src/cli.mjs audit` prints the audit, and `ledger/study/score-report.txt` has all four arms.

## The run

- **Pre-registered** 2026-09-16 (`PREREGISTRATION.md`), amended once on 2026-09-19 before any call (`PREREGISTRATION-AMENDMENT-1.md`: the endpoint returns one aggregated row per call, so a daily signal is a daily call, and the plan was re-costed accordingly).
- **Run** 2026-09-19: 12,781 API calls answered, 63,900 credits (`ledger/study/spend-report.json`). Of 12,763 attempts at `tgm/historical-token-flow-summary`, 12,758 came back with data and 5 did not (timeouts, a 503, a dropped connection); 20 calls went to `tgm/historical-token-ohlcv`, and one account check was refused with a 405. The ledger keeps one row per call key, its final answer: 12,760 rows, each with a receipt in `ledger/study/receipts.jsonl`.
- **Universe**: 22 tokens fixed in advance; 20 included. `solana:SOL` was excluded because the endpoint does not serve native tokens (HTTP 422), and `solana:PYTH` because the venue echoed an empty symbol for the address. Neither was replaced.
- **Window convention**: probed on the first calls, not assumed. A date range is inclusive of its end date.
- **Range**: 2025-03-11 (the first date every segment has coverage) to 2026-09-01. The daily arm is 10,798 token-days, 14,353 claims, and 43,059 forecasts across the three horizons.

## H1: does a segment's flow predict returns beyond drift?

A net flow of at least $250k into a token (the segment's ten strongest that day) is a claim that the token beats its own drift over 24, 48 or 168 hours, entered at the first hourly open after the day closes. Each claim is paired with a control on the same token, direction and horizon, entered at a random offset within three days from a fixed seed. Six segments times three horizons is 18 hypotheses; the bar is p < 0.05/18 = 0.00278, on a block-bootstrap null, with round-trip cost 12 bps.

**No pair clears the bar. All 18 read `fail-signal`.**

| segment | 24h net ± SE (n) | 48h net ± SE (n) | 168h net ± SE (n) |
|---|---|---|---|
| Whale | -48.1 ± 21.1 (1,358) | -49.6 ± 24.3 (1,358) | -34.7 ± 21.7 (1,358) |
| Public Figure | +47.5 ± 51.9 (128) | -11.8 ± 78.1 (128) | -24.0 ± 50.9 (128) |
| Top PnL | -22.0 ± 15.1 (2,420) | +2.7 ± 18.5 (2,420) | +11.3 ± 17.5 (2,420) |
| Smart Trader | -40.4 ± 47.1 (222) | -81.7 ± 59.8 (222) | +13.9 ± 82.1 (222) |
| Exchange (control) | -9.6 ± 9.7 (4,912) | -26.9 ± 10.6 (4,912) | -10.9 ± 12.7 (4,911) |
| Fresh Wallets | -19.6 ± 9.0 (5,308) | -28.6 ± 13.3 (5,307) | -31.0 ± 19.3 (5,305) |

Net is the paired excess over the control minus 12 bps, in basis points. The smallest p-value is Whale at 24h, 0.085: about 30 times the bar, and on the negative side.

**The negative control holds.** `Exchange` flow is movement between wallets and venues, not conviction. It reads `fail-signal` at every horizon (gross excess +2.4, -14.9 and +1.1 bps; p 0.80, 0.17, 0.93). The instrument is not manufacturing edge.

**The instrument would have seen an edge.** On the seeded synthetic world in `test/`, the same code recovers a planted 160 bps edge as 159.0 and a planted 81.3 bps edge as 82.7, reads a planted faint 16.6 bps edge as `fail-signal` (18 hypotheses buy a bar it cannot clear, correctly), and reads the planted noise segments as `fail-signal`.

Read plainly: on these 20 tokens over 18 months, knowing that a Nansen-labelled group net-bought or net-sold $250k or more of a token yesterday told you nothing tradeable about the next one, two or seven days.

### What an agent that traded them anyway would expect

On the measured means, with the closed-form economics in `src/economics.mjs` (a $100,000 book, 10% of it per signal, every pair traded back to back through a year):

| round trip | ungated agent (trades every signal) | gated agent (trades only what cleared the bar) |
|---|---|---|
| 0 bps | -$30,172 a year | $0 |
| 12 bps | -$73,347 a year | $0 |
| 40 bps | -$174,087 a year | $0 |

The gated agent has no better data and no cleverer model. It declines the signals that were never measured to work, and here that is all of them. This is an expectation over measured means with wide errors, not a backtest; slippage beyond the flat cost, capacity, funding and correlation between positions would each make the ungated figure worse.

## The window audit: what a multi-day window returns

The study also called the same windows three other ways (one call per week, one per month, and one for the whole range), planning to compare a one-call window with the same days summed from daily calls. That comparison was pre-registered as a measure of label look-ahead, since the docs say segment labels are resolved at `date_to`.

The flows disagreed by far more than label drift could explain: 280% to 1,568% of the flow at weekly resolution, with 478 sign flips in `exchange` alone. So `src/audit-convention.mjs` rebuilt every one-call window from the daily series nine ways (inclusive, end-exclusive, shifted a day either way, trailing and leading K days, first day, last day, the mean):

- **`fresh_wallets`**: a multi-day window is **exactly its last day**, on 1,957 of 1,957 windows across the three arms.
- **The other five segments**: **no rebuild reproduces the window.** Over windows where either value is non-zero, the inclusive sum lands within 5% on 2.0% to 2.7% of weekly windows for the three dense segments (whale, top PnL, exchange) and 6% to 9% for the two sparse ones, with rank correlation 0.26 to 0.33. The closest rebuild is usually a short trailing window (the last two days at weekly resolution, seven to ten at monthly), and even that lands within 5% on at most 29% of weekly windows.
- The daily series is not smoothed: the median lag-1 autocorrelation of a token's daily flow is between -0.02 and 0.05 for five segments (0.39 for fresh wallets), so the daily calls are not averaging either.

So the look-ahead reading was withdrawn: the premise that only label resolution differs between the two quantities does not hold. What stands is the practical rule for anyone backtesting on this endpoint: **call at the resolution you will act on; never sum short windows into long ones, and never read a long window as a sum.** H1 is untouched; it never used a multi-day window. The mechanism is for Nansen to confirm; the request ids are in `ledger/study/receipts.jsonl`.

## Things that look like findings and are not

The summed-from-daily arms (built for the withdrawn comparison, not pre-registered as hypotheses) show a handful of uncorrected p < 0.05 excesses: Whale 48h -105.6 ± 38.2 bps (p 0.008), Smart Trader 168h -123.3 ± 60.2, Public Figure 48h -160 ± 77.5, and monthly Fresh Wallets 48h +262 ± 89.5 (p 0.003). Thirty-six unregistered tests produce about that many by chance, and the one at p 0.003 misses its own arm's bar. The consistent negative lean of the dynamic labels at weekly aggregation is a hypothesis to pre-register and test on new data. It is not a trade.

## Hyperliquid positioning: not yet a finding

`PREREGISTRATION-HL.md` fixes six tests for the sampled positioning panel (crowding against funding at 24 and 72 hours; liquidation proximity against realised volatility and cascades at 24 hours; smart-money skew against returns at 24 and 72 hours), each against a label-free control, block bootstrap and permutation reference, Bonferroni over six, and a 30-day floor below which the scorer refuses to run. Until then the positioning tools serve measurements with an age and a provenance, and say so on every answer.
