---
type: prereg
venture: gryps
project: assay
from: mango
date: 2026-09-16
status: SEALED — written before any Nansen API call was made
re: what Nansen's flow segments are worth, and what their own backtesting endpoint's label resolution costs
---

# Pre-registration — Assay live study

**Sealed 2026-09-16, before the API key existed.** Nothing below was chosen
after seeing data, because at the time of writing there is no data: the account
is unfunded and zero calls have been made. That is the only circumstance in
which a pre-registration means anything, and it is why this is being written
during the wait rather than after it.

Every number here is binding. A change after the first call is an **amendment**,
filed separately, dated, and carried into the output — not an edit.

---

## 1. The two questions

**H1 — are the segments worth anything?** For each of six flow segments at each
of three horizons: does a segment's net flow into a token predict that token's
excess return over a drift-matched control?

**H2 — what does the label-resolution convention cost?** Nansen's
`tgm/historical-token-flow-summary` resolves segment membership at `date_to`,
so a multi-month request applies today's cohort backwards across the whole
window. H2 asks how much measured edge that manufactures, by running H1 twice
under two calling conventions and differencing them.

H2 is the finding we expect to be more valuable, and it is the one that is
useful to Nansen whether the answer is large or zero.

## 2. The universe — fixed now, before any call

Twenty-two tokens across the four chains `historical-token-flow-summary`
covers. **SEI is not covered by this endpoint** and is therefore not in the
universe, which is worth stating plainly so nobody later reads its absence as a
result.

| chain | tokens |
|---|---|
| ethereum | WETH, WBTC, LINK, UNI, AAVE, LDO, CRV, ONDO, PEPE, ENA |
| solana | SOL, JUP, JTO, PYTH, WIF, BONK |
| base | AERO, DEGEN, BRETT |
| bnb | CAKE, XVS, TWT |

**Why these, and the reason is deliberately not about returns.** They are
large, continuously traded, and present across the whole window on their chain —
chosen so that a flow signal has enough depth behind it to be a signal at all,
and so that the price tape has no holes. They were **not** screened on flow, on
return, on volatility, or on anything the study measures. The list is written
here before any call so that "we picked the ones that worked" is not available
as an explanation later.

Contract addresses are resolved at run time and **recorded in
`ledger/universe-resolved.json` before the first flow call**, with the source of
each. Address resolution is mechanical; the universe is the commitment.

If a token turns out to lack coverage for part of the window, it is **excluded
and counted** in provenance, never silently dropped, and never replaced with a
substitute chosen after the fact.

## 3. The signal

| parameter | value |
|---|---|
| segments | `whale`, `public_figure`, `top_pnl`, `smart_trader`, `exchange`, `fresh_wallets` |
| horizons | 24h, 48h, 168h |
| signal field | `{segment}_net_flow_usd` |
| minimum flow | **$250,000** absolute, per token per day |
| direction | `long` if net flow > 0, `short` if < 0 |
| top-K | **10** strongest flows per segment per day |
| window | **2025-03-11 → 2026-09-01** |

The window starts at 2025-03-11 because that is where whale / public_figure /
top_pnl / exchange coverage begins. `smart_trader` is available from 2020, and
the longer history is deliberately **not** used: a study where one arm has six
years and the others eighteen months compares coverage as much as skill.

`minFlowUsd` and `topK` carry over unchanged from the synthetic spec, and they
are the numbers the engine already hashes into every verdict (`specHash`).
Changing either makes it a different study, which the hash makes visible.

**`exchange` is the negative control.** Exchange flow is custody movement, not
conviction, and it must read `fail-signal`. If it does not, the measurement is
wrong, and that is a more useful result than any positive finding in the same
run. It is stated here so it cannot be quietly dropped from the reporting if it
misbehaves.

## 4. The control

Unchanged from the engine as built: same token, same direction, same holding
period, entered at a random offset within **±3 days**, drawn from the fixed seed
**20260916**. The seed is published, travels with every verdict, and is never
re-rolled.

## 5. The three arms — H2's design

The same tokens, the same window, the same engine. Only the calling convention
differs, so any difference in measured excess is attributable to label
resolution and to nothing else.

| arm | calls/token | look-ahead bound | credits (22 tokens) |
|---|---|---|---|
| **naive** — one call, whole range | 1 | ~18 months | 110 |
| **monthly** — `date_to` = each month's end | 18 | ≤30 days | 1,980 |
| **weekly** — `date_to` = each week's end | 26 (6mo subset) | ≤7 days | 2,860 |

The weekly arm runs over a **six-month subset** (2026-03-01 → 2026-09-01) rather
than the full window, on cost. That makes the weekly-vs-monthly comparison a
same-period comparison over that subset only, and the monthly arm is re-scored
over the same six months for it. Stating this now because a reader who assumes
all three arms cover the same period would over-read the three-way difference.

**Primary H2 statistic:** paired difference in mean excess (bps) between the
naive and monthly arms, over the full window, per segment-horizon. Paired
because it is the same tokens and the same dates.

**H2 falsifier, and it is a real one:** if the naive and windowed arms agree
within the block-bootstrap standard error, there is no meaningful leak. That
would be good news for Nansen and it gets reported exactly as loudly as a large
leak would.

## 6. Statistics — committed in advance

- **Primary statistic:** mean paired excess, in bps, per segment-horizon.
- **Uncertainty:** block-bootstrap standard error, K = 2000, block length √n.
  **Not** `sd/√n`. Daily flow observations at 24–168h horizons overlap, and the
  iid error understated by 3.6–4.4× on a comparable structure in testing.
- **Multiplicity:** 6 segments × 3 horizons = **18 hypotheses**. Bonferroni bar
  **0.05/18 = 2.78e-3**. `searchCount` is a required argument with no default;
  the arms are not additional hypotheses because they test the same 18 claims
  under different measurement conditions, and the H2 comparison is reported as a
  difference rather than as a new significance test.
- **Economic threshold:** reported across a cost grid of 0–200 bps. The cost is
  a property of the reader's execution, not of the cohort, so no single cost is
  privileged.
- **n floor:** 30 matured pairs. Below it, `insufficient` — absence, not a
  negative result.

## 7. Budget and the call count

| item | calls | credits |
|---|---|---|
| OHLCV (1h, one call per token) | 22 | 110 |
| naive arm | 22 | 110 |
| monthly arm | 396 | 1,980 |
| weekly arm (6mo subset) | 572 | 2,860 |
| **total** | **1,012** | **5,060** |

Pro includes 2,000 credits, so this needs roughly **3,060 credits of top-ups**.
The client refuses any call that would breach the declared budget **before the
request leaves the process**, so an overrun is a refusal with a number on it
rather than a surprise on the invoice.

The 1,012 calls clear the contest's 1,000-call requirement as a by-product of
the study rather than as padding, which was the intent.

## 8. What would make me abandon this

Stated now, so that continuing is a choice rather than momentum:

- **Coverage is worse than documented.** If more than a quarter of token-days
  come back with null segment columns, the universe or the window is wrong and
  the honest move is to narrow both and say so, not to pool across gaps.
- **The negative control fails.** If `exchange` reads economic at the adjusted
  bar, the measurement has a fault and no positive result from the same run may
  be published until it is found.
- **Truncated tapes.** If OHLCV comes back truncated at 1h over the window, the
  range is narrowed until it does not. A short tape makes unmaturable forecasts
  look like absent outcomes, and the client refuses a truncated reply rather
  than returning it.
- **The budget runs out mid-arm.** A partial arm is not reported as an arm. It
  is reported as a partial arm, with its own n.

## 9. What is published either way

Every verdict, including `fail-signal` ones. Every skipped row, counted by
reason. The spec hash, the control seed, the search count, the calling
convention and its look-ahead bound, and the resolved universe.

A study that only publishes when it finds something is not a study, and this
project's entire argument is that a tool able to return a disappointing answer
is the only kind whose good answers mean anything. That applies to the tool's
authors first.

---

**Sealed by:** M. Dogwood, 2026-09-16, before the API key existed and before any
call was made.

Amendments, if any, are filed as `PREREGISTRATION-AMENDMENT-n.md`, dated, with
the reason, and are carried into the published output. Nothing above is edited.
