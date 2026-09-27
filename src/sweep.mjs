/**
 * THE COST SWEEP AS A FUNCTION — the same measurement, scored at every cost,
 * with the same two checks `test/make-sweep.mjs` makes on the fixtures:
 *
 *   · the signal fingerprint must be identical at every cost (the slider moves
 *     the threshold, never the measurement), or the sweep refuses to emit;
 *   · a pair may move economic → fail-economic as cost rises and must never
 *     fall to fail-signal on the way (cost cannot make a real signal unreal).
 *
 * Shared so the live study's page is built by the exact code path the
 * synthetic page was verified against. `docs/verify.mjs` drives the built page
 * and diffs it against `tournament()`; a sweep built any other way would not
 * survive that.
 */
import { createHash } from 'node:crypto'
import { tournament } from './assay.mjs'
import { agents, BOOK } from './economics.mjs'
import { SIGNAL_SPEC, specHash } from './forecast.mjs'

export const SWEEP_COSTS = Object.freeze(Array.from({ length: 101 }, (_, i) => i * 2))

export function buildSweep({ forecasts, outcomes, cohorts, horizons = SIGNAL_SPEC.horizonsHours, observationsUsed = null, groundTruth = null, costs = SWEEP_COSTS, extra = {} }) {
  const byPair = new Map()
  for (const f of forecasts) {
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

  let signalFingerprint = null
  const frames = []
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

  for (const costRtBps of costs) {
    const t = tournament({ opts: { costRtBps }, cohorts, horizons, forecastsFor, outcomesFor })
    const fp = createHash('sha256').update(JSON.stringify(
      t.results.map((r) => [r.provenance.cohort, r.provenance.horizonHours, r.detail?.excessMeanBps, r.prior?.pValue, r.provenance.matured, r.detail?.rawSignalMeanBps, r.detail?.controlMeanBps]),
    )).digest('hex').slice(0, 16)
    if (signalFingerprint === null) signalFingerprint = fp
    else if (fp !== signalFingerprint) throw new Error(`SIGNAL MEASUREMENT CHANGED at cost ${costRtBps} (${fp} vs ${signalFingerprint}): the slider would be moving the measurement, not the threshold. Refusing to emit.`)
    frames.push({
      costRtBps,
      summary: t.summary,
      cells: t.results.map((r) => ({ cohort: r.provenance.cohort, horizonHours: r.provenance.horizonHours, verdict: r.verdict, netMeanBps: r.prior ? +r.prior.netMeanBps.toFixed(2) : null, readingRef: intern(r.reading) })),
    })
  }

  // the invariant, checked
  const trail = new Map()
  for (const f of frames) for (const c of f.cells) {
    const k = `${c.cohort}|${c.horizonHours}`
    if (!trail.has(k)) trail.set(k, [])
    trail.get(k).push({ cost: f.costRtBps, verdict: c.verdict })
  }
  const violations = []
  for (const [k, seq] of trail) {
    const firstReal = seq.findIndex((x) => x.verdict === 'economic' || x.verdict === 'fail-economic')
    if (firstReal < 0) continue
    for (let i = firstReal; i < seq.length; i++) if (seq[i].verdict === 'fail-signal') { violations.push(`${k} went real at ${seq[firstReal].cost} bps and fail-signal at ${seq[i].cost} bps`); break }
  }
  if (violations.length) throw new Error(`VERDICT COLLAPSE — cost changed whether a signal is REAL:\n  ${violations.join('\n  ')}`)

  const base = tournament({ opts: { costRtBps: 0 }, cohorts, horizons, forecastsFor, outcomesFor })
  const measured = base.results.map((r) => ({
    cohort: r.provenance.cohort, horizonHours: r.provenance.horizonHours,
    excessMeanBps: r.detail?.excessMeanBps ?? null, rawSignalMeanBps: r.detail?.rawSignalMeanBps ?? null, controlMeanBps: r.detail?.controlMeanBps ?? null,
    standardErrorBps: r.prior ? +r.prior.standardErrorBps.toFixed(2) : null, iidStandardErrorBps: r.prior?.iidStandardErrorBps ?? null,
    effectiveN: r.prior?.effectiveN ?? null, varianceInflation: r.prior?.varianceInflation ?? null, sdBps: r.prior ? +r.prior.sdBps.toFixed(1) : null,
    pValue: r.prior?.pValue ?? null, n: r.provenance.matured, hitRate: r.detail?.hitRate ?? null, brier: r.detail?.calibration?.brier ?? null,
    curve: r.detail?.calibration?.curve?.filter((b) => b.n > 0) ?? [], noControlCount: r.provenance.noControlCount, pendingCount: r.provenance.pendingCount,
  }))
  const adjustedAlpha = base.results[0]?.provenance.adjustedAlpha ?? null
  const econPairs = base.results.filter((r) => r.prior).map((r) => ({ cohort: r.provenance.cohort, horizonHours: r.provenance.horizonHours, excessMeanBps: r.detail.excessMeanBps, sdBps: r.prior.sdBps, standardErrorBps: r.prior.standardErrorBps, pValue: r.prior.pValue }))
  for (const f of frames) {
    const e = agents({ pairs: econPairs, costRtBps: f.costRtBps, adjustedAlpha })
    const trim = ({ legs, ...rest }) => rest
    f.economics = { ...e, ungated: trim(e.ungated), gated: trim(e.gated), sized: trim(e.sized) }
  }

  return {
    generatedAtIso: new Date().toISOString(),
    book: BOOK,
    specHash: specHash(),
    spec: SIGNAL_SPEC,
    searchCount: base.searchCount,
    adjustedAlpha,
    signalFingerprint,
    observationsUsed,
    forecastsFormed: forecasts.length,
    cohorts,
    horizons,
    groundTruth,
    measured,
    costs,
    readings,
    frames,
    ...extra,
  }
}
