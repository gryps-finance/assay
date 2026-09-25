---
type: audit
venture: gryps
project: assay
date: 2026-09-20
status: measured on the live ledger (12,756 ok rows, 20 tokens, 1,558 weekly / 380 monthly / 20 whole-range windows); the mechanism is [VERIFY] with Nansen
inputs: ledger/study/calls.jsonl
outputs: ledger/study/convention-audit.json, ledger/study/convention-audit-report.txt
reproduce: node src/audit-convention.mjs --ledger ledger/study ; node test/audit-convention.test.mjs (67 checks on planted conventions)
---

# What a multi-day window returns

## Why this was run

The score report's leak tables say a week asked for in one call differs from
the same week built from seven daily calls by 280%–1,568% of the flow's own
size, with hundreds of sign flips — for every segment, `exchange` included.
Amendment 1 §4 attributes that difference to label look-ahead, on a premise
that is testable: *"same tokens, same days, same aggregation, same engine; the
only thing that differs is when membership was resolved."* If the premise
holds, the one-call window equals the sum of the daily calls up to membership
drift, and for `exchange` the drift inside a week should be small. It read
351% and 478 sign flips out of 1,556. Either exchange membership churns
violently inside a week, or a window is not the sum of its days.

So before the number is published under the word *leak*, the audit rebuilds
every one-call window from the daily series nine ways — the inclusive sum,
the `to`-exclusive sum, the sum shifted a day either way, the last day alone,
the first day alone, the mean of the days, the trailing K days and the
leading K days for every K up to the window — and asks which rebuild the
one-call value is. A rebuild *matches* when the one-call value lands within
5% of it on nearly every pair. The verdict is read on the non-zero pairs,
because a sparse segment is mostly both-zero and those match trivially.

## What the ledger says

**1. `fresh_wallets` is the last day, exactly.** The one-call value for any
window `{from, to}` is bit-identical to the daily call for `{to, to}`:
1,557 of 1,557 weekly pairs, 380 of 380 monthly, 20 of 20 whole-range;
Spearman 1.00. Two readings, one consequence. Either a wallet "fresh at `to`"
did not exist before `to`, so the window's flow from it is `to`'s flow by
construction; or the range is ignored for this field. Either way a "weekly
fresh-wallet flow" from one call is a one-day number, and seven daily calls
summed are a different quantity, about seven times larger — the report's 600%
median for this segment is exactly that arithmetic.

**2. For the other five segments, nothing matches.** On the dense segments,
the inclusive sum is within 5% of the one-call value on 2.4% (whale), 3.1%
(top PnL) and 2.7% (exchange) of weekly pairs; rank correlation 0.26 / 0.27 /
0.33; sign agreement, where both sides clear the study's $250k threshold,
66.5% (n=188) / 70.6% (n=323) / 66.4% (n=812) against 50% for coin-flips.
Monthly: 17.5% / 7.7% / 8.2% within, correlation 0.46 / 0.46 / 0.35. No
other rebuild does better than 8% on these segments, at either length. The
disagreement is uniform across tokens (exchange weekly, median |Δ|/|W| by
token: 236% to 820%) and across periods (2025-H1 395%, 2025-H2 350%, 2026
438%); it is not a few bad rows and it does not age.

**3. Recent days weigh more.** The one-call value correlates better with the
last two or three days of the window than with the whole of it: weekly,
trail-2/3 gives Spearman 0.43 (whale), 0.44 (top PnL), 0.48 (exchange)
against 0.26–0.33 for the full week, and sign agreement 85.5% / 80.1% / 74.8%
against 66–71%; monthly, trail-7 gives 0.59 / 0.58 / 0.68 against 0.46 /
0.46 / 0.35. Still not a match — within 5% on 7% of pairs at best — but the
direction is the same in every dense segment at both lengths.

**4. The daily series is a daily series.** Lag-1 autocorrelation, median
across tokens: whale 0.05, public figure 0.00, top PnL −0.02, smart trader
0.00, exchange 0.05; fresh wallets 0.39. A trailing seven-day window would
read about 0.85. Nothing here touches the daily arm.

**5. The convention probe did not generalise.** The run's probe — one token,
two adjacent days, WETH exchange on 2026-08-24/25 — found the two-day window
equal to the two days summed within 2.4%, and the run correctly read the
window as `to`-inclusive on that. Over 1,556 weekly pairs the inclusive sum
is within 5% of the one-call value 2.7% of the time. A probe of one pair
settled the inclusivity question and nothing else, and should not have been
read as evidence of additivity.

## What this does to the study

**H1 stands.** The published arm is the daily arm: one call per token-day,
`from = to`, labels resolved that day, look-ahead bounded at one day. The
audit shows that series behaving as a daily series and finds nothing that
touches it. The negative control read `fail-signal` at 24h, 48h and 168h;
no segment clears the 18-hypothesis bar. That result is unchanged.

**H2, as designed, is withdrawn as a measurement of leak.** Its premise —
same aggregation, different resolution — is false for this endpoint. The
flow-level numbers in the score report are real, reproducible from the
ledger, and important; they measure *one call ≠ the sum of its days*, not
label look-ahead, and they are relabelled accordingly in the record. The
verdict-level "leak bps" rows compare tournaments run on two different
quantities and are not leak either; they stay in `study.json` under their
original name for reproducibility and are not to be quoted as leak. The
prereg committed to reporting agreement within the standard error as loudly
as a large leak. This is the third outcome — the comparison cannot be made as
designed — and it is reported as loudly.

**The weekly, monthly and whole-range arms** remain valid tournaments on
whatever those calls return. All of them read `fail-signal` or
`insufficient`; nothing changes.

## For anyone using this endpoint

- Ask at the resolution you will act on. A daily signal is a daily call.
- Do not build a longer window by summing shorter one-call windows, and do
  not compare a one-call window with summed daily calls as if they measured
  the same thing. On this ledger they do not.
- `fresh_wallets` over a range is a point-in-time value at `to`.
- The mechanism is Nansen's to name — [VERIFY]. The documented behaviour
  (labels resolved at `date_to`, membership that turns over inside the
  window) could produce this on the dynamic segments; that it appears in
  `exchange` at the same strength, and that recent days weigh more, suggests
  the aggregation over the range is not a sum over days. The ledger cannot
  separate the two; the vendor can, and the request IDs for every pair are in
  `calls.jsonl`.

## Erratum (2026-09-24)

- Item 2 mixes two bases. On windows where either value is non-zero, the basis the verdict is read on, the weekly
  inclusive-sum match is 2.4% (whale), 2.0% (top PnL) and 2.7% (exchange), and the monthly 2.8%, 6.4% and 8.2%.
  Counting both-zero windows as matches gives weekly 21.6%, 3.1% and 2.7%, and monthly 17.5%, 7.7% and 8.2%. On the
  non-zero basis the best other rebuild reaches 9.5% (whale, monthly, the trailing ten days), not 8%. No conclusion
  changes.
- The request ids are in `ledger/study/receipts.jsonl` in the public repository. `calls.jsonl`, which holds the
  responses, stays with the account that made the calls, under Nansen's redistribution terms.
