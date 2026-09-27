#!/usr/bin/env node
/**
 * SCORE THE STUDY — from the ledger, without a key, deterministically.
 *
 * Reads `calls.jsonl`, the OHLCV tapes and the resolution files that
 * `study.mjs` wrote, and produces:
 *
 *   verdicts.json      the DAILY arm's tournament, in the shape the MCP server
 *                      already serves (six segments × three horizons, one
 *                      Bonferroni bar, two kinds of failure)
 *   study.json         every arm side by side, the leak (H2), coverage, the
 *                      convention probe, and the spend
 *   sweep.json         the daily arm scored at every cost, for the page
 *
 * H1 is published from the daily arm — labels resolved within one day of the
 * flow. H2 is the paired difference between a window's flow as the venue
 * returns it in one call (labels resolved at the window's end) and the SAME
 * window built by summing the daily calls (labels resolved each day). Same
 * tokens, same windows, same engine; only label resolution differs, so the
 * difference is the leak and nothing else. It is reported at the flow level
 * (how much the number moves) and at the verdict level (how much measured
 * edge it manufactures), with a bootstrap error on each.
 *
 *   node src/score-study.mjs --ledger ledger/study [--cost 12] [--out ledger/study]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { HISTORICAL_SEGMENTS, SEGMENT_LABEL } from './nansen.mjs'
import { SIGNAL_SPEC, specHash, matureForecast } from './forecast.mjs'
import { forecastsFromFlowSeries, priceLookup, tapeToSeries } from './forecast-flow.mjs'
import { tournament, blockBootstrap } from './assay.mjs'
import { buildSweep } from './sweep.mjs'

const args = process.argv.slice(2)
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const LEDGER_DIR = process.env.ASSAY_LEDGER_DIR ?? argOf('--ledger', 'ledger/study')
const OUT_DIR = argOf('--out', LEDGER_DIR)
const COST_RT_BPS = Number(argOf('--cost', '12'))
const NO_SWEEP = args.includes('--no-sweep')

const DAY = 86_400_000
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`)
const COHORTS = HISTORICAL_SEGMENTS.map((s) => SEGMENT_LABEL[s])

// ───────────────────────────────────────────────────────────── load

export function loadStudy(ledgerDir) {
  const callsPath = join(ledgerDir, 'calls.jsonl')
  if (!existsSync(callsPath)) throw new Error(`no calls.jsonl under ${ledgerDir} — run study.mjs first`)
  const calls = readFileSync(callsPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  // the newest ok row per key wins (a retried call appends; it never edits)
  const byKey = new Map()
  for (const c of calls) if (c.state === 'ok') byKey.set(c.key, c)
  const ok = [...byKey.values()]
  const tapes = {}
  const ohlcvDir = join(ledgerDir, 'ohlcv')
  if (existsSync(ohlcvDir)) for (const f of readdirSync(ohlcvDir)) {
    if (!f.endsWith('.json') && !f.endsWith('.json.gz')) continue
    const buf = readFileSync(join(ohlcvDir, f))
    const t = JSON.parse((f.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8'))
    tapes[t.symbol] = t
  }
  const readJson = (n) => (existsSync(join(ledgerDir, n)) ? JSON.parse(readFileSync(join(ledgerDir, n), 'utf8')) : null)
  return { calls, ok, tapes, universe: readJson('universe-resolved.json'), convention: readJson('convention-probe.json'), manifest: readJson('study-manifest.json'), spend: readJson('spend-report.json') }
}

/** rows for one arm: (symbol, window, segment flows) */
const armRows = (ok, arm) => ok.filter((c) => c.arm === arm && c.segments)

/** the daily arm summed over the windows of another arm — labels each day, aggregation the same */
export function sumDailyOver({ daily, windows }) {
  const byToken = new Map()
  for (const d of daily) {
    const k = `${d.chain}|${d.symbol}`
    if (!byToken.has(k)) byToken.set(k, new Map())
    byToken.get(k).set(d.window.fromDate, d)
  }
  const out = []
  for (const w of windows) {
    const days = byToken.get(`${w.chain}|${w.symbol}`)
    if (!days) continue
    const segments = {}
    let complete = true
    const covered = []
    for (let t = dayMs(w.window.fromDate); t <= dayMs(w.window.toDate); t += DAY) {
      const d = days.get(new Date(t).toISOString().slice(0, 10))
      if (!d) { complete = false; break }
      covered.push(d)
    }
    if (!complete) continue
    for (const s of HISTORICAL_SEGMENTS) {
      const vals = covered.map((d) => d.segments?.[s]?.netFlowUsd ?? null)
      // a window with ANY absent day is absent for that segment: never a partial sum passed off as a whole
      segments[s] = { netFlowUsd: vals.some((v) => v === null) ? null : vals.reduce((a, b) => a + b, 0), days: covered.length }
    }
    out.push({ ...w, arm: `${w.arm}-from-daily`, lookAheadBoundDays: 1, segments, key: `${w.arm}-from-daily|${w.chain}|${w.address}|${w.window.fromDate}|${w.window.toDate}` })
  }
  return out
}

// ───────────────────────────────────────────────────────────── score

function scoreArm({ rows, arm, priceAt, seriesOf, costRtBps }) {
  const forecasts = []
  const skipped = {}
  const nulls = {}
  for (const s of HISTORICAL_SEGMENTS) {
    const series = rows.map((r) => ({ symbol: r.symbol, chain: r.chain, windowEndDate: r.window.toDate, netFlowUsd: r.segments?.[s]?.netFlowUsd ?? null, arm, lookAheadBoundDays: r.lookAheadBoundDays }))
    nulls[s] = series.filter((x) => x.netFlowUsd === null).length
    const f = forecastsFromFlowSeries({ segment: s, rows: series, priceAt })
    forecasts.push(...f.forecasts)
    skipped[s] = f.skipped
  }
  const outcomes = forecasts.map((f) => matureForecast({ forecast: f, series: seriesOf(f.subject) }))
  const byPair = new Map()
  for (const f of forecasts) { const k = `${f.cohort}|${f.horizonHours}`; if (!byPair.has(k)) byPair.set(k, []); byPair.get(k).push(f) }
  const outcomeById = new Map(outcomes.map((o) => [o.forecastId, o]))
  const t = tournament({
    opts: { costRtBps }, cohorts: COHORTS, horizons: SIGNAL_SPEC.horizonsHours,
    forecastsFor: (c, h) => byPair.get(`${c}|${h}`) ?? [],
    outcomesFor: (c, h) => (byPair.get(`${c}|${h}`) ?? []).map((f) => outcomeById.get(f.id)).filter(Boolean),
  })
  return { arm, rowsUsed: rows.length, nullFlowsBySegment: nulls, skippedBySegment: skipped, forecasts, outcomes, tournament: t }
}

/** per-forecast excess, keyed so the same claim can be paired across two arms */
function excessRows({ forecasts, outcomes }) {
  const byId = new Map(outcomes.map((o) => [o.forecastId, o]))
  const out = new Map()
  for (const f of forecasts) {
    const o = byId.get(f.id)
    if (!o || o.exitPriceUsd === null || o.controlReturnBps === null) continue
    const sign = f.direction === 'long' ? 1 : -1
    const signalBps = sign * Math.log(o.exitPriceUsd / f.entryPriceUsd) * 1e4
    out.set(`${f.segment}|${f.horizonHours}|${f.subject}|${f.windowEndDate}`, { excessBps: signalBps - o.controlReturnBps, direction: f.direction, flowUsd: f.flowUsd })
  }
  return out
}

/**
 * H2. Flow level: for every token-window both arms answered, the difference
 * between the one-call flow and the summed-daily flow, per segment. Verdict
 * level: for every claim BOTH arms formed (same segment, horizon, token,
 * window), the paired difference in excess — the edge the longer resolution
 * manufactured or destroyed — with a block-bootstrap error on the mean.
 */
function leak({ called, summed, calledScore, summedScore }) {
  const summedByKey = new Map(summed.map((r) => [`${r.chain}|${r.symbol}|${r.window.fromDate}|${r.window.toDate}`, r]))
  const flow = {}
  for (const s of HISTORICAL_SEGMENTS) {
    const diffs = []
    let signFlips = 0, pairs = 0, absCalled = 0
    for (const c of called) {
      const m = summedByKey.get(`${c.chain}|${c.symbol}|${c.window.fromDate}|${c.window.toDate}`)
      const a = c.segments?.[s]?.netFlowUsd ?? null
      const b = m?.segments?.[s]?.netFlowUsd ?? null
      if (a === null || b === null) continue
      pairs++
      diffs.push(a - b)
      absCalled += Math.abs(a)
      if (Math.sign(a) !== Math.sign(b) && (Math.abs(a) >= SIGNAL_SPEC.minFlowUsd || Math.abs(b) >= SIGNAL_SPEC.minFlowUsd)) signFlips++
    }
    const meanAbsDiff = diffs.length ? diffs.reduce((x, y) => x + Math.abs(y), 0) / diffs.length : null
    flow[s] = { pairs, meanAbsDiffUsd: meanAbsDiff === null ? null : Math.round(meanAbsDiff), meanAbsCalledUsd: pairs ? Math.round(absCalled / pairs) : null, relativeMove: meanAbsDiff !== null && absCalled > 0 ? +(meanAbsDiff / (absCalled / pairs)).toFixed(4) : null, signFlipsAboveThreshold: signFlips }
  }
  const a = excessRows(calledScore)
  const b = excessRows(summedScore)
  const verdict = []
  for (const s of HISTORICAL_SEGMENTS) for (const h of SIGNAL_SPEC.horizonsHours) {
    const d = []
    for (const [k, va] of a) {
      if (!k.startsWith(`${s}|${h}|`)) continue
      const vb = b.get(k)
      if (!vb) continue
      d.push(va.excessBps - vb.excessBps)
    }
    const boot = d.length >= 2 ? blockBootstrap(d, { seed: 20260916 }) : null
    const mean = d.length ? d.reduce((x, y) => x + y, 0) / d.length : null
    const calledRes = calledScore.tournament.results.find((r) => r.provenance.cohort === SEGMENT_LABEL[s] && r.provenance.horizonHours === h)
    const summedRes = summedScore.tournament.results.find((r) => r.provenance.cohort === SEGMENT_LABEL[s] && r.provenance.horizonHours === h)
    verdict.push({
      segment: s, cohort: SEGMENT_LABEL[s], horizonHours: h, pairedClaims: d.length,
      leakBps: mean === null ? null : +mean.toFixed(2), leakSeBps: boot ? boot.seBps : null, leakP: boot ? boot.p : null,
      calledExcessBps: calledRes?.detail?.excessMeanBps ?? null, calledVerdict: calledRes?.verdict ?? null,
      summedExcessBps: summedRes?.detail?.excessMeanBps ?? null, summedVerdict: summedRes?.verdict ?? null,
    })
  }
  return { flow, verdict }
}

// ───────────────────────────────────────────────────────────── main

export function scoreStudy({ ledgerDir, outDir = ledgerDir, costRtBps = 12, withSweep = true }) {
  const L = loadStudy(ledgerDir)
  const tapes = {}
  for (const [sym, t] of Object.entries(L.tapes)) tapes[sym] = tapeToSeries(t)
  const priceAt = priceLookup(tapes)
  const seriesOf = (sym) => tapes[sym] ?? []

  const arms = {}
  const daily = armRows(L.ok, 'daily')
  const weekly = armRows(L.ok, 'weekly')
  const monthly = armRows(L.ok, 'monthly')
  const naive = armRows(L.ok, 'naive')
  if (daily.length) arms.daily = scoreArm({ rows: daily, arm: 'daily', priceAt, seriesOf, costRtBps })
  if (weekly.length) arms.weekly = scoreArm({ rows: weekly, arm: 'weekly', priceAt, seriesOf, costRtBps })
  if (monthly.length) arms.monthly = scoreArm({ rows: monthly, arm: 'monthly', priceAt, seriesOf, costRtBps })
  const leaks = {}
  if (daily.length && weekly.length) {
    const summed = sumDailyOver({ daily, windows: weekly })
    arms['weekly-from-daily'] = scoreArm({ rows: summed, arm: 'weekly-from-daily', priceAt, seriesOf, costRtBps })
    leaks.weekly = leak({ called: weekly, summed, calledScore: arms.weekly, summedScore: arms['weekly-from-daily'] })
  }
  if (daily.length && monthly.length) {
    const summed = sumDailyOver({ daily, windows: monthly })
    arms['monthly-from-daily'] = scoreArm({ rows: summed, arm: 'monthly-from-daily', priceAt, seriesOf, costRtBps })
    leaks.monthly = leak({ called: monthly, summed, calledScore: arms.monthly, summedScore: arms['monthly-from-daily'] })
  }
  // the naive arm is one row per token: no series, no forecasts — its flows are compared to the daily sum over the whole range
  let naiveFlow = null
  if (daily.length && naive.length) {
    const summed = sumDailyOver({ daily, windows: naive })
    naiveFlow = leak({ called: naive, summed, calledScore: { forecasts: [], outcomes: [], tournament: { results: [] } }, summedScore: { forecasts: [], outcomes: [], tournament: { results: [] } } }).flow
  }

  const published = arms.daily ?? null
  const strip = (a) => a && ({ arm: a.arm, rowsUsed: a.rowsUsed, nullFlowsBySegment: a.nullFlowsBySegment, skippedBySegment: a.skippedBySegment, forecastsFormed: a.forecasts.length, summary: a.tournament.summary, searchCount: a.tournament.searchCount, results: a.tournament.results.map((r) => ({ cohort: r.provenance.cohort, horizonHours: r.provenance.horizonHours, verdict: r.verdict, n: r.provenance.matured, pending: r.provenance.pendingCount, noControl: r.provenance.noControlCount, excessMeanBps: r.detail?.excessMeanBps ?? null, netMeanBps: r.prior?.netMeanBps ?? null, standardErrorBps: r.prior?.standardErrorBps ?? null, effectiveN: r.prior?.effectiveN ?? null, pValue: r.prior?.pValue ?? null })) })

  const study = {
    asOf: new Date().toISOString(),
    ledgerDir,
    specHash: specHash(),
    spec: SIGNAL_SPEC,
    costRtBps,
    segments: HISTORICAL_SEGMENTS,
    universe: L.universe ? { included: L.universe.included.map((t) => `${t.chain}:${t.symbol}`), excluded: L.universe.excluded.map((t) => ({ token: `${t.chain}:${t.symbol}`, why: t.why })) } : null,
    convention: L.convention ? { verdict: L.convention.verdict, scores: L.convention.scores } : null,
    calls: { total: L.calls.length, ok: L.ok.length, byArm: Object.fromEntries(['naive', 'monthly', 'weekly', 'daily'].map((a) => [a, L.ok.filter((c) => c.arm === a).length])) },
    spend: L.spend ? { calls: L.spend.calls, creditsSpent: L.spend.creditsSpent, accountRemaining: L.spend.accountRemaining, status: L.spend.status } : null,
    publishedFrom: published ? 'daily (labels resolved within one day of the flow)' : null,
    arms: Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, strip(v)])),
    leak: { ...leaks, naiveFlow, note: 'leakBps = mean over paired claims of (excess with labels resolved at the window end) − (excess with labels resolved each day). Positive = the longer resolution manufactured edge.' },
  }

  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'study.json'), JSON.stringify(study, null, 2))
  if (published) {
    const v = { asOf: study.asOf, specHash: specHash(), spec: SIGNAL_SPEC, costRtBps, arm: 'daily', lookAheadBoundDays: 1, observationsUsed: published.rowsUsed, forecastsFormed: published.forecasts.length, forecastsSkipped: published.skippedBySegment, ...published.tournament }
    writeFileSync(join(outDir, 'verdicts.json'), JSON.stringify(v, null, 2))
    if (withSweep) {
      const sweep = buildSweep({ forecasts: published.forecasts, outcomes: published.outcomes, cohorts: COHORTS, observationsUsed: published.rowsUsed, groundTruth: null, extra: { source: 'nansen live study, daily arm', ledgerDir, universe: study.universe, leak: study.leak } })
      writeFileSync(join(outDir, 'sweep.json'), JSON.stringify(sweep))
    }
  }
  return study
}

function report(study) {
  console.log(`\nASSAY STUDY — scored from ${study.ledgerDir} at ${study.costRtBps} bps round trip`)
  if (study.universe) console.log(`  universe: ${study.universe.included.length} included, ${study.universe.excluded.length} excluded${study.universe.excluded.length ? ` (${study.universe.excluded.map((e) => e.token).join(', ')})` : ''}`)
  if (study.convention) console.log(`  window convention: ${study.convention.verdict}`)
  console.log(`  calls ok by arm: ${Object.entries(study.calls.byArm).map(([a, n]) => `${a} ${n}`).join(', ')}`)
  for (const [name, a] of Object.entries(study.arms)) {
    console.log(`\n  ARM ${name} — ${a.rowsUsed} rows, ${a.forecastsFormed} forecasts; ${a.summary.headline}`)
    console.log(`  ${'SEGMENT'.padEnd(14)} ${'HRZN'.padStart(5)}  ${'VERDICT'.padEnd(15)} ${'EXCESS'.padStart(8)} ${'NET'.padStart(8)} ${'±SE'.padStart(7)} ${'n'.padStart(6)} ${'effN'.padStart(6)}  p`)
    for (const r of [...a.results].sort((x, y) => (y.netMeanBps ?? -1e9) - (x.netMeanBps ?? -1e9))) {
      console.log(`  ${r.cohort.padEnd(14)} ${String(r.horizonHours).padStart(4)}h  ${r.verdict.padEnd(15)} ${(r.excessMeanBps === null ? '—' : r.excessMeanBps.toFixed(1)).padStart(8)} ${(r.netMeanBps === null ? '—' : r.netMeanBps.toFixed(1)).padStart(8)} ${(r.standardErrorBps === null ? '—' : r.standardErrorBps.toFixed(1)).padStart(7)} ${String(r.n).padStart(6)} ${String(r.effectiveN ?? '—').padStart(6)}  ${r.pValue ?? '—'}`)
    }
    const nulls = Object.entries(a.nullFlowsBySegment).filter(([, n]) => n > 0).map(([s, n]) => `${s} ${n}`).join(', ')
    if (nulls) console.log(`  absent (null) flows: ${nulls}`)
  }
  for (const [w, l] of Object.entries(study.leak)) {
    if (!l || w === 'note' || w === 'naiveFlow') continue
    console.log(`\n  LEAK — ${w} window, one call vs summed daily calls`)
    console.log(`  ${'SEGMENT'.padEnd(14)} ${'pairs'.padStart(6)} ${'|Δflow|/|flow|'.padStart(15)} ${'sign flips'.padStart(11)}`)
    for (const s of study.segments) { const f = l.flow[s]; console.log(`  ${s.padEnd(14)} ${String(f.pairs).padStart(6)} ${(f.relativeMove === null ? '—' : (f.relativeMove * 100).toFixed(1) + '%').padStart(15)} ${String(f.signFlipsAboveThreshold).padStart(11)}`) }
    console.log(`  ${'SEGMENT'.padEnd(14)} ${'HRZN'.padStart(5)} ${'claims'.padStart(7)} ${'leak bps'.padStart(9)} ${'±SE'.padStart(7)}  ${'called'.padEnd(15)} ${'summed'.padEnd(15)}`)
    for (const v of l.verdict) console.log(`  ${v.cohort.padEnd(14)} ${String(v.horizonHours).padStart(4)}h ${String(v.pairedClaims).padStart(7)} ${(v.leakBps === null ? '—' : v.leakBps.toFixed(1)).padStart(9)} ${(v.leakSeBps === null ? '—' : v.leakSeBps.toFixed(1)).padStart(7)}  ${String(v.calledVerdict ?? '—').padEnd(15)} ${String(v.summedVerdict ?? '—').padEnd(15)}`)
  }
  if (study.leak.naiveFlow) {
    console.log(`\n  LEAK — whole range in one call vs summed daily calls (flow level only; one row per token)`)
    for (const s of study.segments) { const f = study.leak.naiveFlow[s]; console.log(`  ${s.padEnd(14)} ${String(f.pairs).padStart(6)} ${(f.relativeMove === null ? '—' : (f.relativeMove * 100).toFixed(1) + '%').padStart(15)} ${String(f.signFlipsAboveThreshold).padStart(11)}`) }
  }
  console.log(`\n  written: study.json, verdicts.json (daily arm, MCP-ready), sweep.json (the page)\n`)
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
if (isMain) report(scoreStudy({ ledgerDir: LEDGER_DIR, outDir: OUT_DIR, costRtBps: COST_RT_BPS, withSweep: !NO_SWEEP }))
