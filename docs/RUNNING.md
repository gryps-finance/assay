# Running Assay on a schedule, and running your own study

Two things in Assay are worth running unattended: the **daily live pull** (today's signals against their priors) and the **Hyperliquid sampler** (Nansen's positioning endpoints answer only for now, so their history exists only if something samples them on a clock and never misses an hour). And one thing is worth running once, carefully: **your own study**.

Everything below assumes a Linux box with Node 18+, the repository cloned, and `NANSEN_API_KEY` in an environment file only root and the job's user can read (for example `/etc/assay.env`, mode 600, containing `export NANSEN_API_KEY=…` and `export NANSEN_TIER=pro`). The key never goes in the crontab, the repository, or a log.

---

## 1. Before spending anything

```bash
cd /path/to/assay
npm test                                                     # 206 checks against mock venues; no key
node src/now.mjs --dry-run                                   # the day's calls and credits
node src/hl-sample.mjs --dry-run --pass all --markets 10 --top-positions 2000 --per-day 4
```

The dry runs print the arithmetic. The price of a positions call is taken from the cost table until the probe below reads the real one off Nansen's reply headers.

## 2. A probe (at most 100 credits)

```bash
. /etc/assay.env
node src/hl-sample.mjs --pass all --markets 2 --top-positions 1000 --budget 100 --reserve 5000 \
  --tier ${NANSEN_TIER:-free} --ledger ledger/hl-probe
node src/hl-derive.mjs --ledger ledger/hl-probe
```

Then read `ledger/hl-probe/samples.jsonl`:

1. `credits.used` on a `tgm/perp-positions` row: the real price of a positions call. If it is not 5, change the row in `src/nansen.mjs` `CREDIT_COST` marked as assumed.
2. Whether the screener accepted the `whale` and `public_figure` trader types (`state: ok`, or the venue's error).
3. Any `shape-refused` row. Its note names the fields the venue sent; a field renamed upstream needs a one-line reader fix before the clock starts.
4. `coverage` for the two markets in `derived/series.jsonl`. Below 0.7 means `--top-positions` is too small for that market.
5. `credits.remaining` on the last row.

Keep the probe's ledger apart from the clock's: it is a schema and cost check, not part of the panel.

## 3. The clock (UTC)

```cron
# Hyperliquid positioning: screener hourly, full books every six hours, the smart-money tape every two
5  *    * * *  cd /path/to/assay && . /etc/assay.env && node src/hl-sample.mjs --pass screener --ledger ledger/hl --tier ${NANSEN_TIER:-free} >> ledger/hl.log 2>&1
10 */6  * * *  cd /path/to/assay && . /etc/assay.env && node src/hl-sample.mjs --pass positions --markets 10 --top-positions 2000 --ledger ledger/hl --tier ${NANSEN_TIER:-free} >> ledger/hl.log 2>&1
15 */2  * * *  cd /path/to/assay && . /etc/assay.env && node src/hl-sample.mjs --pass tape --interval-hours 2 --ledger ledger/hl --tier ${NANSEN_TIER:-free} >> ledger/hl.log 2>&1
25 *    * * *  cd /path/to/assay && node src/hl-derive.mjs --ledger ledger/hl >> ledger/hl.log 2>&1

# today's flow signals against their priors, once the day's data exists
40 1    * * *  cd /path/to/assay && . /etc/assay.env && node src/now.mjs --budget 150 --tier ${NANSEN_TIER:-free} >> ledger/now.log 2>&1
```

At these defaults the sampler spends about 1,400 credits a day (screener about 100, positions about 1,200, tape about 120) and the daily pull about 100. Every sampler pass is keyed by its sample hour: a re-run inside the same hour asks Nansen for nothing it already has, so overlapping cron runs or a manual re-run cost nothing. Each pass stops at its own budget (2,000 by default) and refuses any call that would take the account below its reserve (5,000 by default).

`ledger/hl/derived/` (`latest.json`, `recent.json`, `series.jsonl`, `tape.jsonl`, `maps/`) is what the MCP tools serve and what a dashboard reads. It is small: kilobytes an hour. The raw pages stay under `ledger/hl/raw/`.

A systemd timer works the same way: one service per pass with `EnvironmentFile=/etc/assay.env` and `WorkingDirectory=/path/to/assay`, and a timer with the same `OnCalendar` times.

## 4. Stop and look if

- `credits.remaining` on any row falls below a floor you care about (10,000 is a reasonable one);
- any row is `shape-refused` (read its note);
- `coverage` on a top-three market stays below 0.7 for more than a day;
- the log shows `STOPPED on budget` on a screener pass (the screener is four calls; a budget stop there means the cost table is wrong).

`node src/cli.mjs` has no daemon of its own and holds no state between runs beyond the ledgers, so stopping is removing the cron lines.

---

## 5. Your own study

The instrument that produced the shipped priors will measure your tokens, your dates, and your arms. It is the same code, the same rules and the same scorer.

```bash
# 1. declare the universe before you pull anything: a JSON list of { chain, symbol, address }
cat > my-universe.json <<'JSON'
[
  { "chain": "ethereum", "symbol": "WETH", "address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
  { "chain": "solana",   "symbol": "WIF",  "address": "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" }
]
JSON

# 2. the arithmetic, before a single call
node src/study.mjs --dry-run --universe my-universe.json --arms daily --from 2026-03-01 --to 2026-08-31 --ledger ledger/my-study

# 3. run it (resumable: a stop leaves a ledger the next run continues without paying twice)
. /etc/assay.env
node src/study.mjs --universe my-universe.json --arms daily --from 2026-03-01 --to 2026-08-31 \
  --ledger ledger/my-study --budget 5000 --tier ${NANSEN_TIER:-free}

# 4. score it (no key)
node src/score-study.mjs --ledger ledger/my-study --cost 12

# 5. serve it to your agent
ASSAY_LEDGER_DIR=ledger/my-study node src/mcp-server.mjs
```

What the runner does, in order: resolves every address against the token symbol Nansen echoes back (a mismatch is excluded and counted, never substituted); probes whether a date range is inclusive at its end; pulls the hourly price tape once per token; then makes one flow-summary call per token per day (and per window, for the windowed arms), cheapest arm first, every call keyed on the ledger with its request id and cost. The manifest written before the first call records the spec hash, the pre-registration hashes, and the hash of your universe file.

**How much data you need.** The scorer judges 18 hypotheses against p < 0.05/18, with a block-bootstrap error and an effective sample size. Two tokens over six months at daily resolution gives each segment at most about 360 claims before the $250k threshold and the top-ten rule thin them, which is usually `insufficient` or a wide error, and says so. The shipped study used 20 tokens over 18 months: 10,798 token-days and 14,353 claims.

**A different universe is a different study.** Its priors are yours; don't publish them as the shipped study's, and declare the universe before you look at any of its data, as the shipped study did.

Two rules from the audit apply to anything built on the historical flow summary: call at the resolution you will act on, and never sum short windows into long ones (`node src/cli.mjs audit`).
