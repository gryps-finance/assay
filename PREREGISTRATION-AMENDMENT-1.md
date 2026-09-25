---
type: prereg amendment
venture: gryps
project: assay
from: mango
date: 2026-09-19
status: SEALED — written before any Nansen API call was made (the account holds 200,000 credits; zero have been spent)
amends: PREREGISTRATION.md (sealed 2026-09-16)
---

# Pre-registration — Amendment 1

**Why an amendment and not an edit.** The prereg says a change after the first
call is an amendment, filed separately, dated, and carried into the output.
No call has been made, so strictly this could be an edit. It is filed as an
amendment anyway, because the thing that changed is a *fact about the
endpoint* that the prereg got wrong, and a reader should be able to see what
was believed on the 16th and what was learned on the 19th.

## 1. The fact

Read from the endpoint's own page on 2026-09-19 (docs.nansen.ai, the
`historical-token-flow-summary` OpenAPI page), verbatim:

> The endpoint returns a single aggregated row per (token_address, date_to).

Not one row per day inside a `date_range` — one row per call, aggregated
over the whole range, with segment labels resolved at the range's `to`. The
prereg (§3, §5, §7) assumed daily rows would arrive inside monthly and weekly
requests. They will not. A daily signal requires a daily call.

Two consequences, both stated here so nothing downstream has to infer them:

- The arithmetic in §7 was wrong by an order of magnitude for the study it
  described. The corrected plan is §3 below.
- H2 as written in §5 compared arms whose *aggregation period* differed as
  well as their label resolution. That confounds the leak with the window.
  The corrected design is §4 below.

## 2. What does not change

The universe (22 tokens, §2), the segments (§3), `minFlowUsd` $250,000,
`topK` 10, the horizons 24/48/168h, the control (±3 days, seed 20260916), the
statistics (block-bootstrap SE, K = 2000, block √n; Bonferroni over 18; n
floor 30; the 0–200 bps cost grid), the negative control (`exchange` must read
`fail-signal`), the abandonment criteria (§8), and what is published either
way (§9). `specHash` is therefore unchanged: `deb117cbb478`.

## 3. The arms, restated, and the budget

| arm | calls per token | look-ahead bound | what it is for |
|---|---|---|---|
| **daily** | one per day, `from` = `to` = that day (~540) | ≤ 1 day | **H1 is published from this arm and this arm only** |
| weekly | one per 7-day window, over the **full** window (78) | ≤ 7 days | H2, against the daily arm summed over the same weeks |
| monthly | one per calendar month, partial months at the ends (19) | ≤ 31 days | H2, against the daily arm summed over the same months |
| naive | one call, whole range (1) | ~18 months | flow-level leak only; never a verdict |

The weekly arm now covers the full window rather than the prereg's six-month
subset, which was a cost concession and is no longer necessary.

| item | calls | credits |
|---|---|---|
| universe resolution (one probe day per token) | 22 | 110 |
| window-convention probe (one token, three calls) | 3 | 15 |
| OHLCV 1h, one call per token, padded 12 days each side | 22 | 110 |
| naive | 22 | 110 |
| monthly | 418 | 2,090 |
| weekly | 1,716 | 8,580 |
| daily | 11,880 | 59,400 |
| **total** | **14,083** | **70,415** |

Budget declared to the client: 80,000 credits. Account reserve: 5,000 — the
client refuses the next call when the account's own `X-Nansen-Credits-Remaining`
would fall below it. The study leaves at least 125,000 credits untouched.

## 4. H2, restated

For each weekly (and monthly) window and token, two numbers exist for the
same window: the flow the venue returns in **one call**, labels resolved at
the window's last day; and the flow built by **summing the daily calls** over
the same days, labels resolved each day. Same tokens, same days, same
aggregation, same engine. The only thing that differs is when membership was
resolved, so the difference is the leak and nothing else.

- **Flow level:** per segment, the mean absolute difference relative to the
  mean absolute one-call flow, and the count of sign flips above threshold.
- **Verdict level (primary):** per segment-horizon, the mean paired
  difference in excess bps over the claims BOTH arms formed (same segment,
  horizon, token, window), with a block-bootstrap standard error and p-value.
  Positive means the longer resolution manufactured edge.
- **Falsifier, unchanged:** agreement within the standard error is "no
  meaningful leak", reported as loudly as a large one.

The naive arm yields one row per token and cannot form a series; it enters
H2 at the flow level only.

## 5. Three mechanical facts, determined rather than assumed

- **Window end-inclusivity.** Whether `{from, to}` includes the `to` day is
  probed with three calls on the first resolved token (day 1, day 2, and the
  two-day window) and scored by additivity on the segments whose membership
  is most stable across two days (`exchange`, then `whale`). The verdict and
  the numbers are written to `convention-probe.json` before any arm runs; the
  arms shift their `to` by one day if the verdict is "exclusive".
- **Address resolution.** Each token's address is confirmed by the venue's
  own `token_symbol` echo on the probe day. A mismatch is an exclusion,
  counted; nothing is substituted.
- **Entry timing.** A claim is dated 00:00 UTC on the day after the window's
  last day — the first instant the window's information exists — and its
  entry price is the open of the 1h candle at that instant. Exit is the open
  at entry + horizon; the control is the same at the seeded offset. The
  prereg did not state this and it is stated now, before any price is read.

## 6. Reproducibility

Every call is appended to `ledger/study/calls.jsonl` with its window, the
venue's `X-Request-Id`, the credits quoted, used and remaining, and the raw
row. The OHLCV tapes are stored gzipped beside it. Scoring reads the ledger
and needs no key; the ledger ships with the repository. The client is
resumable by call key: a stopped run restarted spends nothing twice, and that
is tested against a mock venue that serves the documented contract
(`test/study.test.mjs`).

## 7. One more abandonment criterion

If the convention probe is undetermined, the weekly and monthly arms run on
the inclusive assumption and the H2 comparison is published with that caveat
in its own row; it is not suppressed and it is not presented as clean.

---

**Sealed by:** M. Dogwood, 2026-09-19, with 200,000 credits on the account and
none spent.
