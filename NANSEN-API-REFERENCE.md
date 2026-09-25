# Nansen API — working reference

**Date:** 2026-09-16
**Source:** [docs.nansen.ai](https://docs.nansen.ai) — sitemap, backtesting overview, OpenAPI specs, credits page
**Status:** read from the primary docs, not from a summary. Beta endpoints; schemas may move.

Kept in the repo because anyone building a study on these endpoints needs it. §3 was written before the study ran; the box at its end says what the study then found.

---

## 1. Basics

- **Base URL:** `https://api.nansen.ai`
- **Auth:** `apikey` header (not Bearer)
- **All endpoints POST**, JSON body
- **Rate limits** surfaced as `X-RateLimit-Limit-Second` / `-Minute` headers, plus `RateLimit-Reset` (a *delta in seconds*, not a Unix timestamp)
- **Credit accounting** on every response: `X-Nansen-Credits-Cost` (quoted), `X-Nansen-Credits-Used` (actually deducted — can differ, e.g. 0 when rejected), `X-Nansen-Credits-Remaining`
- **`X-Request-Id`** returned on every response; include it in support requests
- **Stable machine-readable error codes** in an `ErrorEnvelope`: `insufficient_credits`, `rate_limit_exceeded`, `invalid_date_range`, `plan_upgrade_required`, `query_too_large`, etc. Worth switching on rather than parsing messages.

---

## 2. The Backtesting Data family — `/api/v1beta1/`

> *"Pass a past date, and the API reconstructs holders, flows, PnL, screener results, and wallet state using the onchain data, prices, and label cohorts available for that historical cutoff. In short: you can now backtest. No look-ahead bias, no manual snapshotting, no rebuilding label history."*

⚠️ **V1 Beta.** Request shapes, response fields and pricing may change.

Two date contracts:
- **Snapshot endpoints** take a single `as_of_date` (`YYYY-MM-DD`) — "state on this day"
- **Window endpoints** take `date_from` + `as_of_date` — "everything between these dates"
- ISO timestamps accepted; date-only values are UTC midnight

### Endpoint list and pricing

| endpoint | credits |
|---|---|
| `tgm/historical-dex-trades` | 5 |
| `tgm/historical-who-bought-sold` | 5 |
| `tgm/historical-token-flow-summary` | 5 |
| `tgm/historical-token-ohlcv` | 5 |
| `token-screener/historical` | 5 |
| `profiler/address/historical-token-balances` | 5 |
| `profiler/address/historical-transactions` | 5 |
| `profiler/historical-transaction-lookup` | 5 |
| `tgm/historical-top-holders` | 25 |
| `tgm/historical-pnl-leaderboard` | 25 |
| `tgm/historical-token-quant-scores` | 25 |
| `smart-money/historical-token-balances` | 25 |

**Historical endpoints cost 5× their real-time counterparts.** Real-time `tgm/*` endpoints are mostly 1 credit; `smart-money/*` are 5.

---

## 3. The label-resolution note, and what a multi-day window returns — read this before designing any study

From the stability notes on the backtesting overview:

> For `tgm/historical-token-flow-summary`, **segment labels are resolved at `date_to`**. For multi-date ranges, `date_to` is the cohort date used for segment membership across the requested flow window.

### What this means

Request 2025-01-01 → 2026-09-01 in one call and the segment membership is **whoever is labelled Smart Money on 2026-09-01**, applied backwards across the entire window. Wallets enter that list partly *because of trades inside your test window*. Any edge measured this way is inflated by survivorship, and the inflation is invisible.

This sits inside the endpoint family whose headline claim is *"no look-ahead bias"*. The claim is true of prices, balances and activity; it is **not** true of cohort membership across a multi-date flow window. And the naive single-call pattern is also the cheapest, so it is the one most users will reach for.

### The fix

One call per **short** window, with `date_to` set to that window's own end. Look-ahead is then bounded by the window length.

| pattern | calls (20 tokens, 18mo) | credits | look-ahead bound |
|---|---|---|---|
| one call, full range | 20 | 100 | ~18 months |
| monthly windows | 360 | 1,800 | ≤30 days |
| weekly windows | 1,040 | 5,200 | ≤7 days |

### The research opportunity

Run the same tokens under all three patterns and report **how the measured edge decays as the leak closes**. That number has not been published, Nansen's own users need it to call their own endpoint correctly, and it is exactly the kind of result that is hard to argue with.

> **What the study then found (2026-09-19/20, 12,781 calls).** The one-call windows and the same windows summed
> from daily calls differ by far more than label drift could explain: 280% to 1,568% of the flow at weekly
> resolution, with hundreds of sign flips even in `exchange`. The audit (`AUDIT-CONVENTION.md`) rebuilt every
> multi-day window from the daily series nine ways and found that a multi-day window is **not the sum of its
> days**: for `fresh_wallets` it is exactly the last day; for the other five segments no rebuild matches, and the
> closest is usually a short trailing window (two days at weekly resolution, seven to ten at monthly). So the comparison above cannot isolate look-ahead,
> and that reading was withdrawn. The rule that survives is simpler and more useful: **call at the resolution you
> will act on, and never sum short windows into long ones or read a long window as a sum.**

Note the related caveat for the screener: `token-screener/historical` default all-traders mode uses historical activity and historical daily pricing, while **Smart Money and notable-label modes use cohort data prepared for each historical day** — so the screener appears to be point-in-time on labels where the flow summary is not. Worth verifying empirically rather than trusting either way.

### Restatement warning

> *"This does not mean an identical request is guaranteed to remain byte-identical forever. Results may change after late-arriving indexed data, pricing fixes, label-history corrections, symbol or sector reclassification, blacklist updates, or endpoint-specific backfills."*

**Consequence:** every captured response must be persisted with its `X-Request-Id` and timestamp. A verdict that cannot be re-derived from a stored payload is a verdict that can silently change under you. Assay's ledger keeps both for every call (the public copy keeps the request id and a SHA-256 of each response; the responses themselves stay with whoever made the calls, per Nansen's redistribution rules).

---

## 4. `tgm/historical-token-flow-summary`

**Request:**
- `chain` (required): `"base"` | `"bnb"` | `"ethereum"` | `"solana"` — **no arbitrum, no sei**
- `token_address` (required)
- `date_range` (required): `{ "from": ..., "to": ... }`, ISO 8601
- `apply_blacklist_filter` (optional, default `true`)

**Response** — `data[]` with, per segment:
- `{segment}_net_flow_usd`
- `{segment}_avg_flow_usd` (geometric mean of absolute flow)
- `{segment}_wallet_count`
- `token_symbol`

**Segments:** Whale, Public Figure, Top PnL, Smart Trader, Exchange, Fresh Wallets.
All segment columns are **nullable** when temporal coverage does not include the requested date — an absent column is absence, not zero, and must be excluded and counted, never filled.

**Coverage:** whale / public_figure / top_pnl / exchange from **2025-03-11**; **smart_trader from 2020+**.

> Note this is a *token-first* endpoint: you specify the token and ask what each segment did. This inverts a cohort-first pipeline, and it is methodologically **better**, because the token universe becomes a pre-committed input rather than whatever Nansen chose to surface in a "top flows" response. That removes a selection bias we would otherwise have had to argue about.

`Exchange` is a natural **negative control**: it should read `fail-signal`. If it does not, something is wrong with the measurement.

---

## 5. `tgm/historical-token-ohlcv`

**Request:**
- `chain`: `base` | `bnb` | `ethereum` | `hyperliquid` | `solana`
- `token_address` — for `chain="hyperliquid"`, pass the **coin symbol** instead (`"BTC"`, `"HYPE"`, `"@1"`, `"XYZ/USDC"`)
- `date_from` (required), ISO 8601
- `as_of_date` — upper bound of the data window; **or** `as_of_ts` for Hyperliquid (exactly one)
- `timeframe` (required): `5m` `15m` `30m` `1h` `4h` `1d` `1w`. **`1m` and `1M` are not supported.**
- `apply_blacklist_filter` — **high-tf only** (`1d`/`1w`); passing it with a low-tf returns **400**

**Response:** `data[]` of `{ interval_start, open, high, low, close, volume, volume_usd, market_cap }`, ordered by `interval_start`, plus `truncated` and `truncation_note`.

**Traps worth knowing:**
- Cap is **50,000 candles**; on most chains the **most recent** candles are omitted when hit. Hyperliquid is served from HL's own feed with a ~5,000 cap and omits the **oldest** instead. Opposite ends. Always check `truncated`.
- `4h` always excludes its trailing partial bucket. Other low-tf may include one with `as_of_date`.
- Date-only `as_of_date` means end-of-day; a datetime value is an exact instant. `2026-04-15` includes the 20:00–24:00 bucket, `2026-04-15T23:59:59Z` excludes it.
- Asymmetry: `as_of_date` clamps data to the time component if supplied, but evaluates the blacklist at **daily** granularity on the date part only.
- Hyperliquid `volume`/`volume_usd` are `null` before **2025-05-29** (mark-price candles, no volume). Weekly candles start **Thursday 00:00 UTC**.

At 1h resolution, 50,000 candles ≈ **5.7 years** — one call per token covers the whole tape.

---

## 6. Plans and credit economics

| plan | credits | notes |
|---|---|---|
| **Free** | 100 trial, then daily top-up **to a 10-credit balance** | unusable for research |
| **Pro** | $49/mo annual or $69/mo monthly; 2,000 credits | top-up to a **floor**, not a recurring grant |

Details that bite:
- The Pro monthly top-up on the 1st raises the included balance **to** 2,000 only **if it is below** 2,000. It is not +2,000/month, and unused credits do not accumulate above the floor.
- Included credits are spent **before** purchased top-ups; among purchased, soonest-expiring first.
- Purchased credits expire **1 year** from purchase; included plan credits have no expiry.
- A cost of `0` means plan credits do not apply — the endpoint is still subject to access and usage limits.

**Practical ceiling:** 2,000 credits ÷ 5 = **400 historical calls/month** on Pro before top-ups.

---

## 7. Other endpoints worth knowing about

| endpoint | credits | why it might matter |
|---|---|---|
| `tgm/token-ohlcv` | 1 | real-time prices, 5× cheaper than historical |
| `tgm/who-bought-sold` | 1 | current cohort activity per token |
| `tgm/position-intelligence` | 1 | aggregated HL perp analytics by trader cohort |
| `smart-money/perp-trades` | 5 | Hyperliquid smart-money perp flow |
| `tgm/perp-positions` | 5 | open positions by cohort |
| `token-screener` | 1 | cheap universe construction |
| `tgm/indicators` | 5 | "Nansen Indicators" — not yet examined |
| `profiler/address/labels` | **100** | expensive; avoid in loops |
| `profiler/address/premium-labels` | **500** | very expensive |
| `agent/fast` / `agent/expert` | **200 / 750** | Nansen's own LLM agents |

**Chain coverage note:** the historical flow summary covers ethereum, solana, base, bnb only. **SEI and Arbitrum are not covered by these endpoints.** Hyperliquid *is* covered for OHLCV and the perp endpoints.

---

## 8. Documentation access

The docs are GitBook and machine-readable, which is worth knowing:
- Append `.md` to any page URL for clean markdown
- `https://docs.nansen.ai/sitemap.md` — full structure
- `https://docs.nansen.ai/llms-full.txt` — entire corpus in one file
- `GET <page>.md?ask=<question>&goal=<goal>` — query the docs directly

Full OpenAPI specs are embedded in each endpoint page's markdown, so request/response schemas can be read exactly rather than inferred from prose. **That is the primary artifact — read it rather than the surrounding description**, which is where the `date_to` label-resolution detail is easy to miss.
