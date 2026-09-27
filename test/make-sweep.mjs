#!/usr/bin/env node
/**
 * COST SWEEP — the same measurement, scored at every cost.
 *
 * The demo page has a cost slider on it, and there are two ways to build that.
 * The dishonest way is to let the page recompute verdicts in JavaScript from a
 * stored excess: the slider then demonstrates the page's arithmetic rather than
 * the engine's. The honest way is this file — call the engine's own
 * `tournament()` once per cost on the SAME forecasts and outcomes, and ship the
 * resulting verdict sets. The page then renders engine output and computes
 * nothing.
 *
 * The forecasts and outcomes are built once because neither depends on cost.
 * That is not an optimisation, it is the claim being demonstrated: across the
 * whole sweep the signal measurement is byte-identical and only the economic
 * threshold moves.
 *
 *   node test/make-sweep.mjs fixtures docs/sweep.json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { forecastsFromNetflow, matureForecast, SIGNAL_SPEC, specHash } from '../src/forecast.mjs'
import { tournament } from '../src/assay.mjs'
import { agents, BOOK } from '../src/economics.mjs'
import { SMART_MONEY_COHORTS } from '../src/nansen.mjs'

const FIX = process.argv[2] ?? 'fixtures'
const OUT = process.argv[3] ?? 'docs/sweep.json'
/** 0 to 200 bps in 2 bps steps: 0 is the frictionless limit, 200 is a bad fill on a thin book */
const COSTS = Array.from({ length: 101 }, (_, i) => i * 2)

const observations = readFileSync(join(FIX, 'observations.jsonl'), 'utf8')
  .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => r.kind === 'observation' && r.state === 'ok' && Array.isArray(r.data))
const prices = JSON.parse(readFileSync(join(FIX, 'prices.json'), 'utf8'))
const groundTruth = JSON.parse(readFileSync(join(FIX, 'GROUND-TRUTH.json'), 'utf8'))

const priceAt = (symbol, atIso) => {
  const s = prices[symbol]
  if (!Array.isArray(s) || s.length === 0) return null
  const t = Date.parse(atIso)
  let best = null
  for (const p of s) if (p.tsMs <= t && (best === null || p.tsMs > best.tsMs)) best = p
  return best && t - best.tsMs <= 2 * 3_600_000 ? best.priceUsd : null
}

process.stderr.write('forming forecasts... ')
const allForecasts = []
for (const obs of observations) {
  const { forecasts } = forecastsFromNetflow({
    cohort: obs.cohort, rows: obs.data, atIso: obs.atIso,
    priceAt: (sym) => priceAt(sym, obs.atIso),
  })
  allForecasts.push(...forecasts)
}
process.stderr.write(`${allForecasts.length}\nmaturing... `)
const outcomes = allForecasts.map((f) => matureForecast({ forecast: f, series: prices[f.subject] ?? [] }))
process.stderr.write(`${outcomes.length}\n`)

// index once; the per-cost loop must not pay for this 101 times
const byPair = new Map()
for (const f of allForecasts) {
  const k = `${f.cohort}|${f.horizonHours}`
  if (!byPair.has(k)) byPair.set(k, { forecasts: [], ids: new Set() })
  byPair.get(k).forecasts.push(f)
  byPair.get(k).ids.add(f.id)
}
const outcomeById = new Map(outcomes.map((o) => [o.forecastId, o]))
const outcomesFor = (c, h) => {
  const p = byPair.get(`${c}|${h}`)
  if (!p) return []
  const out = []
  for (const id of p.ids) { const o = outcomeById.get(id); if (o) out.push(o) }
  return out
}
const forecastsFor = (c, h) => byPair.get(`${c}|${h}`)?.forecasts ?? []

/**
 * The invariant this whole demo rests on: across every cost in the sweep, the
 * measured signal must be identical. If it is not, the slider is changing the
 * measurement and the argument is void — so it is checked, not asserted.
 */
let signalFingerprint = null
const frames = []

/** string interning table for the engine's readings — see readingRef below */
const readings = []
const readingIndex = new Map()
const intern = (str) => {
  if (str === undefined || str === null) return null
  if (readingIndex.has(str)) return readingIndex.get(str)
  const i = readings.length
  readings.push(str)
  readingIndex.set(str, i)
  return i
}

for (const costRtBps of COSTS) {
  const t = tournament({
    opts: { costRtBps },
    cohorts: SMART_MONEY_COHORTS,
    horizons: SIGNAL_SPEC.horizonsHours,
    forecastsFor,
    outcomesFor,
  })

  const fp = createHash('sha256').update(JSON.stringify(
    t.results.map((r) => [r.provenance.cohort, r.provenance.horizonHours, r.detail?.excessMeanBps,
      r.prior?.pValue, r.provenance.matured, r.detail?.rawSignalMeanBps, r.detail?.controlMeanBps]),
  )).digest('hex').slice(0, 16)
  if (signalFingerprint === null) signalFingerprint = fp
  else if (fp !== signalFingerprint) {
    console.error(`\nSIGNAL MEASUREMENT CHANGED at cost ${costRtBps} (${fp} vs ${signalFingerprint}).`)
    console.error('The slider would be moving the measurement, not the threshold. Refusing to emit.')
    process.exit(1)
  }

  frames.push({
    costRtBps,
    summary: t.summary,
    cells: t.results.map((r) => ({
      cohort: r.provenance.cohort,
      horizonHours: r.provenance.horizonHours,
      verdict: r.verdict,
      netMeanBps: r.prior ? +r.prior.netMeanBps.toFixed(2) : null,
      /**
       * Interned, not inlined. A `fail-signal` reading never mentions cost, so
       * the same sentence would otherwise be written 101 times — the readings
       * are two thirds of this file at full length and a fifth of it deduped.
       * Interning is lossless: every cell still carries the engine's exact
       * prose for its exact cost.
       */
      readingRef: intern(r.reading),
    })),
  })
  if (costRtBps % 20 === 0) process.stderr.write(`  cost ${String(costRtBps).padStart(3)} — ${t.summary.economic} economic, ${t.summary.realButCostly} real-but-costly\n`)
}

/**
 * THE INVARIANT THE WHOLE PROJECT RESTS ON, checked rather than claimed.
 *
 * A signal is real or it is not, and cost cannot make it unreal. So as cost
 * rises, a pair may move `economic` -> `fail-economic` and stop there. A pair
 * that drops to `fail-signal` on the way has collapsed the two verdicts into
 * one — which is the exact failure Assay exists to prevent, and finding it in
 * our own output at the eleventh hour is the only reason to check.
 */
const trail = new Map()
for (const f of frames) {
  for (const c of f.cells) {
    const k = `${c.cohort}|${c.horizonHours}`
    if (!trail.has(k)) trail.set(k, [])
    trail.get(k).push({ cost: f.costRtBps, verdict: c.verdict })
  }
}
const violations = []
for (const [k, seq] of trail) {
  const everReal = seq.some((x) => x.verdict === 'economic' || x.verdict === 'fail-economic')
  if (!everReal) continue
  const firstReal = seq.findIndex((x) => x.verdict === 'economic' || x.verdict === 'fail-economic')
  for (let i = firstReal; i < seq.length; i++) {
    if (seq[i].verdict === 'fail-signal') {
      violations.push(`${k} went real at ${seq[firstReal].cost} bps and fail-signal at ${seq[i].cost} bps`)
      break
    }
  }
}
if (violations.length) {
  console.error('\nVERDICT COLLAPSE — cost changed whether a signal is REAL, which it must never do:')
  for (const v of violations) console.error('  ' + v)
  process.exit(1)
}
process.stderr.write(`  invariant holds: no pair crosses from real to fail-signal as cost rises\n`)

/** cost-invariant facts, emitted once rather than 101 times */
const base = tournament({
  opts: { costRtBps: 0 }, cohorts: SMART_MONEY_COHORTS, horizons: SIGNAL_SPEC.horizonsHours,
  forecastsFor, outcomesFor,
})
const measured = base.results.map((r) => ({
  cohort: r.provenance.cohort,
  horizonHours: r.provenance.horizonHours,
  excessMeanBps: r.detail?.excessMeanBps ?? null,
  rawSignalMeanBps: r.detail?.rawSignalMeanBps ?? null,
  controlMeanBps: r.detail?.controlMeanBps ?? null,
  standardErrorBps: r.prior ? +r.prior.standardErrorBps.toFixed(2) : null,
  iidStandardErrorBps: r.prior?.iidStandardErrorBps ?? null,
  effectiveN: r.prior?.effectiveN ?? null,
  varianceInflation: r.prior?.varianceInflation ?? null,
  sdBps: r.prior ? +r.prior.sdBps.toFixed(1) : null,
  pValue: r.prior?.pValue ?? null,
  n: r.provenance.matured,
  hitRate: r.detail?.hitRate ?? null,
  brier: r.detail?.calibration?.brier ?? null,
  curve: r.detail?.calibration?.curve?.filter((b) => b.n > 0) ?? [],
  noControlCount: r.provenance.noControlCount,
  pendingCount: r.provenance.pendingCount,
}))

mkdirSync(dirname(OUT), { recursive: true })
/**
 * The three-agent economics per cost. Computed here, from the same measured
 * pairs the verdicts use, so the page renders arithmetic the engine did rather
 * than arithmetic a browser improvised.
 */
const adjustedAlpha = base.results[0]?.provenance.adjustedAlpha ?? null
/**
 * Built from the UNROUNDED priors, not from the `measured` array above, whose
 * figures are rounded for display. Feeding rounded inputs to a Kelly fraction
 * moves the annual figure by a dollar — small, and exactly the kind of drift
 * that makes a page disagree with its own engine. docs/verify.mjs re-derives
 * from the priors too, so the two only agree if this does.
 */
const econPairs = base.results.filter((r) => r.prior).map((r) => ({
  cohort: r.provenance.cohort,
  horizonHours: r.provenance.horizonHours,
  excessMeanBps: r.detail.excessMeanBps,
  sdBps: r.prior.sdBps,
  standardErrorBps: r.prior.standardErrorBps,
  pValue: r.prior.pValue,
}))

for (const f of frames) {
  const e = agents({ pairs: econPairs, costRtBps: f.costRtBps, adjustedAlpha })
  // per-leg detail is 300KB across 101 frames and nothing renders it; the page
  // gets the totals, and anyone who wants the legs re-runs agents() themselves
  const trim = ({ legs, ...rest }) => rest
  f.economics = { ...e, ungated: trim(e.ungated), gated: trim(e.gated), sized: trim(e.sized) }
}
process.stderr.write(`  economics attached: at 12 bps gating is worth $${frames.find((f) => f.costRtBps === 12).economics.gatingWorthUsdPerYear.toLocaleString('en-US')}/yr on a $${BOOK.equityUsd.toLocaleString('en-US')} book\n`)

writeFileSync(OUT, JSON.stringify({
  generatedAtIso: new Date().toISOString(),
  book: BOOK,
  specHash: specHash(),
  spec: SIGNAL_SPEC,
  searchCount: base.searchCount,
  adjustedAlpha: base.results[0]?.provenance.adjustedAlpha ?? null,
  signalFingerprint,
  observationsUsed: observations.length,
  forecastsFormed: allForecasts.length,
  cohorts: SMART_MONEY_COHORTS,
  horizons: SIGNAL_SPEC.horizonsHours,
  groundTruth,
  measured,
  costs: COSTS,
  readings,
  frames,
}))

console.log(`\nsweep written to ${OUT}`)
console.log(`  ${COSTS.length} cost frames, signal fingerprint ${signalFingerprint} constant across all of them`)
