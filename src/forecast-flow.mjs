/**
 * FORECASTS FROM A TOKEN-FIRST FLOW SERIES.
 *
 * `forecast.mjs` turns a cohort-first netflow response (a list of tokens the
 * cohort moved) into claims. The historical flow summary is the other way
 * round: one call per token per window returns what every segment did in that
 * token. So the series arrives as rows of (token, window, segment → net flow)
 * and the claim is formed per SEGMENT per WINDOW across the pre-committed
 * universe — which is methodologically the better shape, because the token
 * list is the study's commitment and not whatever the venue chose to surface.
 *
 * The rules are the prereg's, unchanged from the synthetic engine:
 *   · a flow below `minFlowUsd` in absolute value is housekeeping, not a claim
 *   · only the segment's `topK` strongest flows in a window become claims
 *   · direction is the sign of the net flow
 *   · the claim is dated the first instant the window's information exists —
 *     00:00 UTC on the day AFTER the window's last day — and its entry price is
 *     the first hourly candle's open at that instant. Nothing in the window is
 *     visible to the forecast before the window closes.
 *   · a null flow is ABSENCE (label coverage does not include the window's
 *     `date_to`): excluded and counted, never zero.
 *
 * Every forecast carries the arm it came from and that arm's look-ahead bound,
 * so a verdict can state its own exposure to the label-resolution leak.
 */
import { forecastId, specHash, SIGNAL_SPEC } from './forecast.mjs'
import { HISTORICAL_SEGMENTS, SEGMENT_LABEL } from './nansen.mjs'

const DAY = 86_400_000

/** the instant a window's information exists: 00:00 UTC the day after its last day */
export function claimTimeIso(windowEndDate) {
  return new Date(Date.parse(`${windowEndDate}T00:00:00Z`) + DAY).toISOString()
}

/**
 * @param {object} o
 * @param {string} o.segment            one of HISTORICAL_SEGMENTS
 * @param {Array}  o.rows               [{ symbol, chain, windowEndDate, netFlowUsd|null, arm, lookAheadBoundDays }]
 * @param {(symbol:string, atIso:string)=>number|null} o.priceAt   entry price; null = skip, never guess
 * @param {object} [o.spec]
 */
export function forecastsFromFlowSeries({ segment, rows, priceAt, spec = SIGNAL_SPEC }) {
  if (!HISTORICAL_SEGMENTS.includes(segment)) throw new Error(`unknown segment '${segment}' — the six are fixed so the search count cannot drift`)
  const cohort = SEGMENT_LABEL[segment]
  const forecasts = []
  const skipped = { nullFlow: 0, belowThreshold: 0, notTopK: 0, noPrice: 0, unparseable: 0 }

  const byWindow = new Map()
  for (const r of rows) {
    if (!r || typeof r.symbol !== 'string' || typeof r.windowEndDate !== 'string') { skipped.unparseable += 1; continue }
    if (r.netFlowUsd === null || r.netFlowUsd === undefined) { skipped.nullFlow += 1; continue }
    const flow = Number(r.netFlowUsd)
    if (!Number.isFinite(flow)) { skipped.unparseable += 1; continue }
    if (Math.abs(flow) < spec.minFlowUsd) { skipped.belowThreshold += 1; continue }
    const arr = byWindow.get(r.windowEndDate) ?? []
    arr.push({ ...r, flow })
    byWindow.set(r.windowEndDate, arr)
  }

  for (const [windowEndDate, cands] of [...byWindow.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    cands.sort((a, b) => Math.abs(b.flow) - Math.abs(a.flow))
    const kept = cands.slice(0, spec.topK)
    skipped.notTopK += cands.length - kept.length
    const atIso = claimTimeIso(windowEndDate)
    for (const c of kept) {
      const entry = priceAt(c.symbol, atIso)
      if (entry === null || entry === undefined || !Number.isFinite(entry) || entry <= 0) { skipped.noPrice += 1; continue }
      for (const horizonHours of spec.horizonsHours) {
        forecasts.push({
          id: forecastId({ cohort: `${cohort}#${c.arm ?? 'arm'}`, subject: c.symbol, atIso, horizonHours }),
          cohort,
          segment,
          subject: c.symbol,
          chain: c.chain ?? null,
          direction: c.flow > 0 ? 'long' : 'short',
          atIso,
          windowEndDate,
          horizonHours,
          strength: Math.sign(c.flow) * Math.log10(Math.abs(c.flow) / spec.minFlowUsd + 1),
          flowUsd: c.flow,
          entryPriceUsd: entry,
          arm: c.arm ?? null,
          lookAheadBoundDays: c.lookAheadBoundDays ?? null,
          specHash: specHash(spec),
        })
      }
    }
  }
  return { forecasts, skipped, specHash: specHash(spec) }
}

/** a price lookup over hourly candles: the OPEN of the candle at or just before `atIso`, within two hours */
export function priceLookup(tapes) {
  const sorted = new Map()
  for (const [symbol, candles] of Object.entries(tapes)) {
    sorted.set(symbol, [...candles].filter((c) => Number.isFinite(c.tsMs) && Number.isFinite(c.priceUsd) && c.priceUsd > 0).sort((a, b) => a.tsMs - b.tsMs))
  }
  return (symbol, atIso) => {
    const s = sorted.get(symbol)
    if (!s || s.length === 0) return null
    const t = Date.parse(atIso)
    let lo = 0, hi = s.length - 1, idx = -1
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (s[mid].tsMs <= t) { idx = mid; lo = mid + 1 } else hi = mid - 1 }
    if (idx < 0) return null
    return t - s[idx].tsMs <= 2 * 3_600_000 ? s[idx].priceUsd : null
  }
}

/** an OHLCV tape from the ledger -> the series matureForecast reads: open per hourly candle */
export function tapeToSeries(tape) {
  return (tape?.candles ?? [])
    .map((c) => ({ tsMs: Date.parse(c.t), priceUsd: c.o }))
    .filter((c) => Number.isFinite(c.tsMs) && Number.isFinite(c.priceUsd) && c.priceUsd > 0)
}
