#!/usr/bin/env node
/**
 * assay now — today's Nansen flow signals, each one handed over WITH its measured prior.
 *
 * One call per token (the daily flow summary for the last complete UTC day, `from` = `to`, the exact call the
 * study measured), the study's own rules to turn flows into claims (a flow of at least $250k, the segment's ten
 * strongest, direction by sign), and then the step no other tool takes: every claim is joined to the prior the
 * study measured for its segment and horizon, and gets a decision an agent can act on. Trade it (sized on the
 * standard error), hold it (real but priced out), skip it (no edge beyond drift), or refuse it (never measured).
 *
 * The output is `live-signals.json`, which the MCP server's `assay_signal_now` serves, and a table on stdout.
 *
 *   NANSEN_API_KEY=… node src/now.mjs [--date 2026-09-23] [--tokens WETH,PEPE] [--universe my-tokens.json]
 *                                     [--priors ledger/study] [--out ledger/live] [--budget 200] [--reserve 5000]
 *                                     [--tier free|pro] [--limit 20 | --all] [--json] [--dry-run]
 *
 * The key is read from the environment and nowhere else. No key, no client; a dry run needs none.
 * Raw replies stay in `<out>/calls.jsonl` on your machine; the repository ignores them.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NansenClient, BudgetExhausted, HISTORICAL_FLOW_CHAINS, HISTORICAL_SEGMENTS, SEGMENT_LABEL, readFlowRow } from './nansen.mjs'
import { SIGNAL_SPEC, specHash } from './forecast.mjs'
import { kellySize, BOOK } from './economics.mjs'
import { UNIVERSE } from './universe.mjs'

const DAY = 86_400_000

/** the last complete UTC day before `nowMs` */
export const lastCompleteDay = (nowMs) => new Date(Math.floor(nowMs / DAY) * DAY - DAY).toISOString().slice(0, 10)

/** the universe: the study's resolved tokens by default; a custom list is allowed and marked as such */
export function loadUniverse({ priorsDir, universeFile = null, tokens = null }) {
  let list
  let source
  if (universeFile) {
    const raw = JSON.parse(readFileSync(universeFile, 'utf8'))
    list = (Array.isArray(raw) ? raw : raw.tokens ?? raw.included ?? []).map((t) => ({ chain: t.chain, symbol: t.symbol, address: t.address }))
    source = `custom universe from ${universeFile}`
  } else if (priorsDir && existsSync(join(priorsDir, 'universe-resolved.json'))) {
    list = JSON.parse(readFileSync(join(priorsDir, 'universe-resolved.json'), 'utf8')).included.map((t) => ({ chain: t.chain, symbol: t.symbol, address: t.address }))
    source = 'the study universe as resolved (20 tokens)'
  } else {
    list = UNIVERSE.map((t) => ({ ...t }))
    source = 'the pre-registered universe (unresolved)'
  }
  const bad = list.filter((t) => !t || typeof t.address !== 'string' || typeof t.symbol !== 'string' || !HISTORICAL_FLOW_CHAINS.includes(t.chain))
  if (bad.length) throw new Error(`universe: ${bad.length} entr(y|ies) without a symbol, an address, or a chain the flow summary covers (${HISTORICAL_FLOW_CHAINS.join(', ')})`)
  if (tokens) {
    const want = tokens.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    list = list.filter((t) => want.includes(t.symbol.toUpperCase()))
  }
  const studied = priorsDir && existsSync(join(priorsDir, 'universe-resolved.json'))
    ? new Set(JSON.parse(readFileSync(join(priorsDir, 'universe-resolved.json'), 'utf8')).included.map((t) => `${t.chain}:${t.address.toLowerCase()}`))
    : new Set()
  return { tokens: list.map((t) => ({ ...t, studied: studied.has(`${t.chain}:${t.address.toLowerCase()}`) })), source }
}

/**
 * The study's rules, applied to one day's rows: per segment, a flow below `minFlowUsd` in absolute value is
 * housekeeping; of the rest, the `topK` strongest become claims; the sign is the direction; a null flow is absence.
 * The same rules `forecast-flow.mjs` applied to 18 months of history, so a live signal is the same object the prior
 * was measured on.
 */
export function selectSignals(rows, spec = SIGNAL_SPEC) {
  const out = []
  const skipped = { nullFlow: 0, belowThreshold: 0, notTopK: 0 }
  for (const segment of HISTORICAL_SEGMENTS) {
    const cands = []
    for (const r of rows) {
      const v = r.segments?.[segment]?.netFlowUsd
      if (v === null || v === undefined || !Number.isFinite(v)) { skipped.nullFlow += 1; continue }
      if (Math.abs(v) < spec.minFlowUsd) { skipped.belowThreshold += 1; continue }
      cands.push({ ...r, flow: v })
    }
    cands.sort((a, b) => Math.abs(b.flow) - Math.abs(a.flow))
    skipped.notTopK += Math.max(0, cands.length - spec.topK)
    for (const c of cands.slice(0, spec.topK)) {
      out.push({ segment, cohort: SEGMENT_LABEL[segment], subject: c.symbol, chain: c.chain, studied: c.studied, direction: c.flow > 0 ? 'long' : 'short', flowUsd: Math.round(c.flow), requestId: c.requestId ?? null })
    }
  }
  return { signals: out, skipped }
}

/** the prior the study measured for one segment at one horizon, from verdicts.json */
export function priorFor(verdicts, cohort, horizonHours) {
  return verdicts?.results?.find((r) => r.provenance?.cohort === cohort && Number(r.provenance?.horizonHours) === Number(horizonHours)) ?? null
}

/**
 * What an agent may do with one signal at one horizon, from its measured prior. The prior decides; the size of
 * today's flow does not enter, because the study measured the segment's claims, not their size.
 */
export function decide(result, costRtBps) {
  if (!result || !result.prior) return { action: 'refuse', fraction: 0, why: 'This segment and horizon have not been measured, so the signal cannot be sized. Measure it first.' }
  const p = result.prior
  switch (result.verdict) {
    case 'economic': {
      const k = kellySize(p)
      return { action: 'trade', fraction: k.fraction, why: `Real and clears ${costRtBps} bps: quarter-Kelly on the block-bootstrap standard error gives ${(k.fraction * 100).toFixed(2)}% of the book.` }
    }
    case 'fail-economic':
      return { action: 'hold', fraction: 0, why: `Real, and a ${costRtBps} bps round trip eats it. A cheaper venue, a longer horizon or a passive expression are untested and live.` }
    case 'fail-signal':
      return { action: 'skip', fraction: 0, why: `No content beyond drift in the measured record (net ${p.netMeanBps} ± ${p.standardErrorBps} bps, n ${p.n}). Not the reverse trade either.` }
    default:
      return { action: 'skip', fraction: 0, why: 'Too few matured pairs to say anything; absence, not a negative result.' }
  }
}

/** join every signal to its priors and decisions, one per horizon the study measured */
export function attachPriors(signals, verdicts, spec = SIGNAL_SPEC) {
  const cost = verdicts?.costRtBps ?? null
  return signals.map((s) => ({
    ...s,
    horizons: spec.horizonsHours.map((h) => {
      const r = priorFor(verdicts, s.cohort, h)
      const d = decide(r, cost)
      return {
        horizonHours: h,
        verdict: r?.verdict ?? null,
        prior: r?.prior ? { netMeanBps: r.prior.netMeanBps, standardErrorBps: r.prior.standardErrorBps, sdBps: r.prior.sdBps, n: r.prior.n, effectiveN: r.prior.effectiveN, pValue: r.prior.pValue, adjustedAlpha: r.prior.adjustedAlpha } : null,
        ...d,
      }
    }),
    ...(s.studied ? {} : { note: 'This token was not in the measured universe; its segment prior is carried over, which is an extrapolation.' }),
  }))
}

/** the headline an agent or a person reads first */
export function summarize(joined, verdicts) {
  const decisions = joined.flatMap((s) => s.horizons.map((h) => h.action))
  const tradeable = joined.filter((s) => s.horizons.some((h) => h.action === 'trade')).length
  const at24 = joined.map((s) => s.horizons.find((h) => h.horizonHours === 24)?.prior?.netMeanBps).filter((x) => Number.isFinite(x))
  const meanNet24 = at24.length ? +(at24.reduce((a, b) => a + b, 0) / at24.length).toFixed(1) : null
  return {
    signals: joined.length,
    tradeable,
    byAction: Object.fromEntries(['trade', 'hold', 'skip', 'refuse'].map((a) => [a, decisions.filter((x) => x === a).length])),
    meanMeasuredNet24hBps: meanNet24,
    headline: joined.length === 0
      ? 'No segment moved $250k or more in any token yesterday. A quiet day, not a missing feed.'
      : `${joined.length} live signal${joined.length === 1 ? '' : 's'}; ${tradeable} tradeable on ${tradeable === 1 ? 'its' : 'their'} measured prior${meanNet24 !== null ? `. Acting on all of them at 24h carries a measured net of ${meanNet24 > 0 ? '+' : ''}${meanNet24} bps each at ${verdicts?.costRtBps ?? '?'} bps round trip` : ''}.`,
  }
}

export async function runNow({ client, date, universe, verdicts, say = () => {}, onCall = () => {} }) {
  const rows = []
  const absent = []
  for (const t of universe.tokens) {
    const r = await client.flowSummaryWindow({ chain: t.chain, tokenAddress: t.address, fromDate: date, toDate: date })
    const row = r.ok ? (r.data?.data?.[0] ?? null) : null
    const requestId = r.headers?.requestId ?? null
    onCall({ atIso: new Date().toISOString(), chain: t.chain, symbol: t.symbol, address: t.address, date, state: r.state ?? (r.ok ? 'ok' : 'error'), requestId, credits: { used: r.headers?.creditsUsed ?? null, remaining: r.headers?.creditsRemaining ?? null }, raw: row })
    if (!row) { absent.push({ symbol: t.symbol, state: r.ok ? 'empty' : (r.state ?? 'error'), note: r.note ?? null }); continue }
    const read = readFlowRow(row)
    rows.push({ symbol: t.symbol, chain: t.chain, studied: t.studied, requestId, segments: read.segments, missingFields: read.missingFields })
    say(`  ${t.chain.padEnd(9)} ${t.symbol.padEnd(6)} ${r.state ?? 'ok'}`)
  }
  const { signals, skipped } = selectSignals(rows)
  const joined = attachPriors(signals, verdicts)
  return {
    kind: 'assay-live-signals', asOf: new Date().toISOString(), date, claimAtIso: new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString(),
    universe: { source: universe.source, tokens: universe.tokens.length, read: rows.length, absent },
    spec: SIGNAL_SPEC, specHash: specHash(SIGNAL_SPEC),
    priors: { from: verdicts?.arm ? `${verdicts.arm} arm of the study, scored ${verdicts.asOf}` : 'none', costRtBps: verdicts?.costRtBps ?? null, searchCount: verdicts?.searchCount ?? null, specHash: verdicts?.specHash ?? null },
    skipped, summary: summarize(joined, verdicts), signals: joined,
    source: 'Powered by Nansen API: tgm/historical-token-flow-summary, one call per token per day',
  }
}

// ───────────────────────────────────────────────────────────── the table

const pad = (s, n) => String(s).padEnd(n)
const lpad = (s, n) => String(s).padStart(n)
const usd = (x) => `${x < 0 ? '-' : '+'}$${Math.abs(x) >= 1e6 ? `${(Math.abs(x) / 1e6).toFixed(2)}M` : `${Math.round(Math.abs(x) / 1e3)}k`}`

/**
 * The table a person reads. `limit` caps the rows shown (the strongest flows
 * first) and says how many more there are and where; the file always holds
 * every signal.
 */
export function render(out, { limit = Infinity, file = null } = {}) {
  const L = []
  L.push('')
  L.push(`  ASSAY NOW  Nansen flows for ${out.date}, ${out.universe.read} of ${out.universe.tokens} tokens read`)
  L.push(`  priors: ${out.priors.from}, ${out.priors.costRtBps} bps round trip, ${out.priors.searchCount} hypotheses`)
  L.push('')
  if (out.signals.length === 0) { L.push(`  ${out.summary.headline}`); L.push(''); return L.join('\n') }
  L.push(`  ${pad('SEGMENT', 15)}${pad('TOKEN', 7)}${lpad('FLOW', 9)}  ${pad('SIDE', 6)}${pad('24h PRIOR (net ± SE bps)', 27)}${pad('VERDICT', 14)}DECISION`)
  const shown = out.signals.length > limit ? [...out.signals].sort((a, b) => Math.abs(b.flowUsd) - Math.abs(a.flowUsd)).slice(0, limit) : out.signals
  for (const s of shown) {
    const h = s.horizons.find((x) => x.horizonHours === 24) ?? s.horizons[0]
    const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '?')
    const prior = h?.prior ? `${h.prior.netMeanBps > 0 ? '+' : ''}${f1(h.prior.netMeanBps)} ± ${f1(h.prior.standardErrorBps)}  (n ${h.prior.n})` : 'not measured'
    const dec = h.action === 'trade' ? `trade ${(h.fraction * 100).toFixed(2)}% of book` : h.action
    L.push(`  ${pad(s.cohort, 15)}${pad(s.subject, 7)}${lpad(usd(s.flowUsd), 9)}  ${pad(s.direction, 6)}${pad(prior, 27)}${pad(h?.verdict ?? '—', 14)}${dec}`)
  }
  if (shown.length < out.signals.length) L.push(`  ... ${out.signals.length - shown.length} more, the largest flows shown first; every signal is in ${file ?? 'live-signals.json'} (--all prints them)`)
  L.push('')
  L.push(`  ${out.summary.headline}`)
  L.push(`  ${out.source}.`)
  L.push('')
  return L.join('\n')
}

// ───────────────────────────────────────────────────────────── cli

const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d }
const has = (k) => process.argv.includes(k)

export async function main() {
  const PRIORS = argOf('--priors', process.env.ASSAY_LEDGER_DIR ?? 'ledger/study')
  const OUT = argOf('--out', process.env.ASSAY_LIVE_DIR ?? 'ledger/live')
  const DATE = argOf('--date', lastCompleteDay(Date.now()))
  const BUDGET = Number(argOf('--budget', '200'))
  const RESERVE = Number(argOf('--reserve', '5000'))
  const TIER = argOf('--tier', process.env.NANSEN_TIER ?? 'free')
  const BASE_URL = argOf('--base-url', process.env.NANSEN_BASE_URL ?? 'https://api.nansen.ai')
  const JSON_OUT = has('--json')
  const say = JSON_OUT ? () => {} : (s) => console.log(s)

  if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) { console.error('--date must be YYYY-MM-DD (a complete UTC day)'); process.exit(2) }
  const verdictsPath = join(PRIORS, 'verdicts.json')
  if (!existsSync(verdictsPath)) { console.error(`No priors at ${verdictsPath}. Point --priors at a scored study ledger (the repository ships one at ledger/study).`); process.exit(2) }
  const verdicts = JSON.parse(readFileSync(verdictsPath, 'utf8'))
  const universe = loadUniverse({ priorsDir: PRIORS, universeFile: argOf('--universe', null), tokens: argOf('--tokens', null) })

  if (has('--dry-run')) {
    console.log(`\n  assay now: dry run for ${DATE}\n  ${universe.tokens.length} tokens (${universe.source}): ${universe.tokens.length} calls, ${universe.tokens.length * 5} credits at 5 each\n  priors: ${verdicts.arm} arm, ${verdicts.costRtBps} bps, ${verdicts.searchCount} hypotheses\n  no call made\n`)
    return
  }
  const apiKey = process.env.NANSEN_API_KEY
  if (!apiKey) { console.error('NANSEN_API_KEY is not set in this environment. No call was attempted. Get a key at app.nansen.ai/api and set it in your shell.'); process.exit(2) }
  const client = new NansenClient({ apiKey, creditBudget: BUDGET, tier: TIER, baseUrl: BASE_URL, remainingFloor: RESERVE })
  mkdirSync(OUT, { recursive: true })
  say(`\n  assay now: reading ${universe.tokens.length} tokens for ${DATE} (budget ${BUDGET} credits)`)
  let out
  try {
    out = await runNow({ client, date: DATE, universe, verdicts, say, onCall: (c) => appendFileSync(join(OUT, 'calls.jsonl'), JSON.stringify(c) + '\n') })
  } catch (e) {
    if (e instanceof BudgetExhausted) { console.error(`  STOPPED on budget: ${e.message}`); process.exit(3) }
    throw e
  }
  const spend = client.spendReport()
  out.spend = { calls: spend.calls ?? null, creditsSpent: spend.creditsSpent ?? null, accountRemaining: client.accountRemaining ?? null }
  writeFileSync(join(OUT, 'live-signals.json'), JSON.stringify(out, null, 2))
  if (JSON_OUT) process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  else {
    console.log(render(out, { limit: has('--all') ? Infinity : Math.max(1, Number(argOf('--limit', '20')) || 20), file: join(OUT, 'live-signals.json') }))
    console.log(`  ${out.spend.creditsSpent ?? '?'} credits spent, ${out.spend.accountRemaining ?? '?'} left on the account. Written: ${join(OUT, 'live-signals.json')}\n`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(`assay now failed: ${e instanceof Error ? e.message : e}`); process.exit(1) })
}
