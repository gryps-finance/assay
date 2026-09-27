/**
 * FORECAST — turning a Nansen observation into a falsifiable claim.
 *
 * This is the step that makes the rest possible, and it is the step almost
 * nobody takes. "Smart money accumulated SOL" is an observation; it cannot be
 * right or wrong. "The Fund cohort's net inflow to SOL at 14:00 implies SOL
 * outperforms its own drift over the next 48 hours" is a forecast: it has a
 * subject, a direction, a horizon, and a clock, and in 48 hours reality settles
 * it without anyone's opinion.
 *
 * Three rules keep that honest.
 *
 * ── 1. THE FORECAST IS WRITTEN BEFORE THE OUTCOME EXISTS ─────────────────────
 * Every forecast carries `atIso` and an `entryPriceUsd` captured at that moment.
 * Maturation happens later, from a separate call. There is no path in this file
 * that can see an outcome, which is the only structural way to guarantee the
 * claim was not shaped by it.
 *
 * ── 2. THE THRESHOLD IS PRE-COMMITTED ────────────────────────────────────────
 * If every netflow row became a forecast, most forecasts would be noise and the
 * cohort would be scored on its indifference rather than its conviction. So a
 * flow must clear `minFlowUsd` AND rank in the cohort's own top `topK` for that
 * pass. Both are declared before the run and travel with the verdict. Tuning
 * them after seeing results makes it a new study, and the config hash in the
 * output is what makes that visible.
 *
 * ── 3. EVERY FORECAST GETS A DRIFT-MATCHED CONTROL ───────────────────────────
 * Crypto moves together. A cohort that bought anything in a green week looks
 * clairvoyant. The control is the SAME token, the SAME direction, the SAME
 * holding period, entered at a random offset within ±`controlWindowDays`, drawn
 * from a fixed seed. Subtracting it removes the market and leaves the claim.
 *
 * The seed is recorded and never re-rolled. A control re-drawn after seeing a
 * disappointing result is the most reliable way to manufacture an edge, and the
 * only defence is that the seed is part of the published verdict.
 */

import { createHash } from 'node:crypto'

export const SIGNAL_SPEC = Object.freeze({
  /** a flow smaller than this is not conviction, it is housekeeping */
  minFlowUsd: 250_000,
  /** only the cohort's strongest flows this pass become claims */
  topK: 10,
  /** horizons tested. Multiple, because "does it pay" is horizon-dependent and
   *  a single horizon cannot distinguish a dead signal from a slow one. */
  horizonsHours: [24, 48, 168],
  /** the control may be drawn this many days either side of the real entry */
  controlWindowDays: 3,
  /** fixed forever; a changed seed is a changed study */
  controlSeed: 20260916,
})

/** Deterministic id so a re-run produces the same forecast rows, not duplicates. */
export function forecastId({ cohort, subject, atIso, horizonHours }) {
  return createHash('sha256').update(`${cohort}|${subject}|${atIso}|${horizonHours}`).digest('hex').slice(0, 16)
}

/** The config fingerprint that travels with every verdict. */
export function specHash(spec = SIGNAL_SPEC) {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 12)
}

/**
 * Netflow rows -> forecasts.
 *
 * @param {object} o
 * @param {string} o.cohort
 * @param {Array} o.rows          Nansen netflow `data[]`
 * @param {string} o.atIso        observation time — the clock for the whole batch
 * @param {(symbol:string)=>number|null} o.priceAt  entry price lookup; null = skip, never guess
 * @param {object} [o.spec]
 */
export function forecastsFromNetflow({ cohort, rows, atIso, priceAt, spec = SIGNAL_SPEC }) {
  const forecasts = []
  const skipped = { belowThreshold: 0, noPrice: 0, unparseable: 0, notTopK: 0 }

  const scored = []
  for (const r of rows ?? []) {
    const symbol = r.token_symbol ?? r.symbol
    const flow = Number(r.netflow ?? r.value_usd ?? r.net_flow_usd)
    if (!symbol || !Number.isFinite(flow)) { skipped.unparseable += 1; continue }
    if (Math.abs(flow) < spec.minFlowUsd) { skipped.belowThreshold += 1; continue }
    scored.push({ symbol, flow })
  }

  // rank by conviction, keep the top K — pre-committed, not chosen after the fact
  scored.sort((a, b) => Math.abs(b.flow) - Math.abs(a.flow))
  const kept = scored.slice(0, spec.topK)
  skipped.notTopK = scored.length - kept.length

  for (const { symbol, flow } of kept) {
    const entry = priceAt(symbol)
    if (entry === null || entry === undefined || !Number.isFinite(entry) || entry <= 0) {
      // no price is not a zero return; it is a forecast that cannot be made
      skipped.noPrice += 1
      continue
    }
    for (const horizonHours of spec.horizonsHours) {
      forecasts.push({
        id: forecastId({ cohort, subject: symbol, atIso, horizonHours }),
        cohort,
        subject: symbol,
        direction: flow > 0 ? 'long' : 'short',
        atIso,
        horizonHours,
        /** conviction, scaled so tanh() maps it into a probability later */
        strength: Math.sign(flow) * Math.log10(Math.abs(flow) / spec.minFlowUsd + 1),
        flowUsd: flow,
        entryPriceUsd: entry,
        specHash: specHash(spec),
      })
    }
  }

  return { forecasts, skipped, specHash: specHash(spec) }
}

/** Deterministic PRNG so a control is reproducible from (seed, forecastId). */
function seededUnit(seed, key) {
  const h = createHash('sha256').update(`${seed}|${key}`).digest()
  return h.readUInt32BE(0) / 0xffffffff
}

/**
 * Mature one forecast, forming its drift-matched control in the same step.
 *
 * `series` is an ordered array of `{ tsMs, priceUsd }` covering at least
 * [atIso − controlWindow, atIso + horizon + controlWindow]. If it does not, the
 * outcome comes back with nulls and a reason. It never interpolates: a gap in
 * the price tape is a gap, and a study that quietly fills one is measuring its
 * own interpolation.
 */
/**
 * Sorted view of a price series, built once per array and cached by identity.
 *
 * The obvious implementation of "latest price at or before t" is a linear scan,
 * and at a few hundred forecasts nobody notices. At the sample sizes this study
 * actually needs — where `fail-economic` first becomes reachable — it is the
 * difference between a replay a judge runs and a replay a judge abandons.
 *
 * The sort is defensive rather than assumed: a caller handing over an unordered
 * tape gets the same answer, just once slower. The WeakMap keys on the array
 * itself, so a series that is garbage collected takes its index with it.
 */
const sortedSeriesCache = new WeakMap()
function sortedSeries(series) {
  if (!Array.isArray(series) || series.length === 0) return []
  const hit = sortedSeriesCache.get(series)
  if (hit) return hit
  const sorted = [...series].sort((a, b) => a.tsMs - b.tsMs)
  sortedSeriesCache.set(series, sorted)
  return sorted
}

export function matureForecast({ forecast, series, spec = SIGNAL_SPEC }) {
  const atMs = Date.parse(forecast.atIso)
  const exitMs = atMs + forecast.horizonHours * 3_600_000
  const sign = forecast.direction === 'long' ? 1 : -1
  const tape = sortedSeries(series)

  const priceAtOrBefore = (targetMs, toleranceMs = 2 * 3_600_000) => {
    // rightmost entry with tsMs <= targetMs
    let lo = 0, hi = tape.length - 1, idx = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (tape[mid].tsMs <= targetMs) { idx = mid; lo = mid + 1 } else { hi = mid - 1 }
    }
    if (idx < 0) return null
    const best = tape[idx]
    if (targetMs - best.tsMs > toleranceMs) return null
    return best.priceUsd
  }

  const exitPrice = priceAtOrBefore(exitMs)
  if (exitPrice === null) {
    return { forecastId: forecast.id, exitPriceUsd: null, controlReturnBps: null, maturedAtIso: new Date().toISOString(), note: 'not matured: no price within tolerance of the exit timestamp — pending, not zero' }
  }

  // the control: same token, same direction, same holding period, shifted
  const u = seededUnit(spec.controlSeed, forecast.id)
  const offsetMs = Math.round((u * 2 - 1) * spec.controlWindowDays * 86_400_000)
  const cEntryMs = atMs + offsetMs
  const cExitMs = cEntryMs + forecast.horizonHours * 3_600_000
  const cEntry = priceAtOrBefore(cEntryMs)
  const cExit = priceAtOrBefore(cExitMs)

  const controlReturnBps =
    cEntry !== null && cExit !== null && cEntry > 0 ? sign * Math.log(cExit / cEntry) * 1e4 : null

  return {
    forecastId: forecast.id,
    exitPriceUsd: exitPrice,
    controlReturnBps,
    controlEntryIso: new Date(cEntryMs).toISOString(),
    maturedAtIso: new Date().toISOString(),
    note: controlReturnBps === null ? 'matured, but the drift-matched control could not be formed — excluded from the excess, counted in provenance' : undefined,
  }
}
