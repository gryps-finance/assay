#!/usr/bin/env node
/**
 * Tests for the scoring core.
 *
 * The important ones are not the unit tests. They are the four RECOVERY tests:
 * given data where the answer is known, does the engine find an edge that is
 * there, refuse one that is not, keep the two kinds of failure apart, and notice
 * when the market did the work?
 *
 *   node test/assay.test.mjs
 */
import assert from 'node:assert/strict'
import { assayCohort, tournament, calibration, bootstrapP, blockBootstrap, normCdf } from '../src/assay.mjs'
import { forecastsFromNetflow, matureForecast, forecastId, SIGNAL_SPEC } from '../src/forecast.mjs'
import { NansenClient, CREDIT_COST, SMART_MONEY_COHORTS, HISTORICAL_SEGMENTS, HISTORICAL_FLOW_CHAINS } from '../src/nansen.mjs'

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++ }
  catch (e) { console.log(`  FAIL ${name}\n         ${e.message}`); fail++ }
}

// deterministic generator for synthetic worlds with a known answer
let seed = 424242
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 4294967296)
const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) }

/**
 * Build n forecast/outcome pairs where the SIGNAL beats its CONTROL by exactly
 * `trueExcessBps` on average, with `driftBps` of market move affecting both.
 */
function world({ n, trueExcessBps, driftBps = 0, noiseBps = 600 }) {
  const forecasts = []
  const outcomes = []
  for (let i = 0; i < n; i++) {
    const id = `f${i}`
    const entry = 100
    const controlBps = driftBps + noiseBps * gauss()
    const signalBps = controlBps + trueExcessBps + noiseBps * 0.3 * gauss()
    forecasts.push({ id, cohort: 'X', subject: 'TOK', direction: 'long', atIso: '2026-06-01T00:00:00Z', horizonHours: 48, strength: 0.4, entryPriceUsd: entry })
    outcomes.push({ forecastId: id, exitPriceUsd: entry * Math.exp(signalBps / 1e4), controlReturnBps: controlBps, maturedAtIso: '2026-06-03T00:00:00Z' })
  }
  return { forecasts, outcomes }
}

console.log('\nRECOVERY — does it find what is there and refuse what is not?\n')

t('recovers a real edge, and the estimate lands within noise of the truth', () => {
  const { forecasts, outcomes } = world({ n: 4000, trueExcessBps: 60, noiseBps: 500 })
  const r = assayCohort({ cohort: 'X', horizonHours: 48, forecasts, outcomes, searchCount: 1, opts: { costRtBps: 12 } })
  assert.equal(r.verdict, 'economic', `expected economic, got ${r.verdict}: ${r.reading}`)
  const gross = r.detail.excessMeanBps
  assert.ok(Math.abs(gross - 60) < 12, `recovered ${gross} bps against a planted 60`)
})

t('refuses a cohort with NO edge, however much the market moved', () => {
  // +900 bps of drift and zero skill: a measurement without a control would
  // report a triumph here
  const { forecasts, outcomes } = world({ n: 4000, trueExcessBps: 0, driftBps: 900, noiseBps: 500 })
  const r = assayCohort({ cohort: 'X', horizonHours: 48, forecasts, outcomes, searchCount: 1 })
  assert.equal(r.verdict, 'fail-signal', `a drifting market with no skill must read fail-signal, got ${r.verdict}`)
})

t('THE CENTRAL TEST: a real edge that costs eat reads fail-economic, NOT fail-signal', () => {
  const { forecasts, outcomes } = world({ n: 40000, trueExcessBps: 9, noiseBps: 400 })
  const r = assayCohort({ cohort: 'X', horizonHours: 48, forecasts, outcomes, searchCount: 1, opts: { costRtBps: 20 } })
  assert.equal(r.verdict, 'fail-economic',
    `a significant sub-cost edge must be distinguished from an absent one; got ${r.verdict}`)
  assert.ok(r.reading.includes('THE SIGNAL IS REAL AND THE TRADE IS NOT'))
  assert.ok(r.prior && r.prior.tradeable === false, 'the prior must still be published, flagged untradeable')
})

t('the SAME data flips verdict when only the cost changes', () => {
  const { forecasts, outcomes } = world({ n: 20000, trueExcessBps: 40, noiseBps: 400 })
  const cheap = assayCohort({ cohort: 'X', horizonHours: 48, forecasts, outcomes, searchCount: 1, opts: { costRtBps: 12 } })
  const dear = assayCohort({ cohort: 'X', horizonHours: 48, forecasts, outcomes, searchCount: 1, opts: { costRtBps: 80 } })
  assert.equal(cheap.verdict, 'economic')
  assert.equal(dear.verdict, 'fail-economic')
  assert.equal(cheap.detail.excessMeanBps, dear.detail.excessMeanBps,
    'the SIGNAL measurement must be identical — only the economic threshold moved')
})

console.log('\nDISCIPLINE — the refusals\n')

t('too few matured pairs is `insufficient`, which is not a negative result', () => {
  const { forecasts, outcomes } = world({ n: 10, trueExcessBps: 200 })
  const r = assayCohort({ cohort: 'X', horizonHours: 48, forecasts, outcomes, searchCount: 1 })
  assert.equal(r.verdict, 'insufficient')
  assert.equal(r.prior, null, 'no prior may be issued from too little data')
  assert.ok(r.reason.includes('absent'))
})

t('searchCount is mandatory — an unadjusted bar is not an option', () => {
  const { forecasts, outcomes } = world({ n: 100, trueExcessBps: 0 })
  assert.throws(() => assayCohort({ cohort: 'X', horizonHours: 48, forecasts, outcomes }), /searchCount is required/)
})

t('multiplicity actually bites: the same data can pass at k=1 and fail at k=18', () => {
  const { forecasts, outcomes } = world({ n: 3000, trueExcessBps: 33, noiseBps: 600 })
  const alone = assayCohort({ cohort: 'X', horizonHours: 48, forecasts, outcomes, searchCount: 1 })
  const among = assayCohort({ cohort: 'X', horizonHours: 48, forecasts, outcomes, searchCount: 18 })
  assert.ok(alone.provenance.adjustedAlpha > among.provenance.adjustedAlpha)
  assert.equal(alone.prior.pValue, among.prior.pValue, 'the p-value is a property of the data, not of the search')
})

t('pending and control-less rows are EXCLUDED and COUNTED, never filled', () => {
  const { forecasts, outcomes } = world({ n: 200, trueExcessBps: 50 })
  outcomes[0].exitPriceUsd = null                 // not matured
  outcomes[1].controlReturnBps = null             // no control
  const r = assayCohort({ cohort: 'X', horizonHours: 48, forecasts, outcomes, searchCount: 1 })
  assert.equal(r.provenance.pendingCount, 1)
  assert.equal(r.provenance.noControlCount, 1)
  assert.equal(r.provenance.matured, 198)
})

console.log('\nFORECASTS — written before the outcome exists\n')

t('a netflow row becomes a directional, horizoned, priced claim', () => {
  const { forecasts } = forecastsFromNetflow({
    cohort: 'Fund',
    rows: [{ token_symbol: 'SOL', netflow: 3_000_000 }, { token_symbol: 'ARB', netflow: -2_000_000 }],
    atIso: '2026-06-01T00:00:00Z',
    priceAt: () => 100,
  })
  assert.equal(forecasts.length, 2 * SIGNAL_SPEC.horizonsHours.length)
  assert.equal(forecasts.find((f) => f.subject === 'SOL').direction, 'long')
  assert.equal(forecasts.find((f) => f.subject === 'ARB').direction, 'short')
  assert.ok(forecasts.every((f) => f.entryPriceUsd === 100 && f.atIso === '2026-06-01T00:00:00Z'))
})

t('a flow below the pre-committed threshold is not a claim', () => {
  const { forecasts, skipped } = forecastsFromNetflow({
    cohort: 'Fund', rows: [{ token_symbol: 'SOL', netflow: 1000 }],
    atIso: '2026-06-01T00:00:00Z', priceAt: () => 100,
  })
  assert.equal(forecasts.length, 0)
  assert.equal(skipped.belowThreshold, 1)
})

t('no entry price means no forecast — never a guessed one', () => {
  const { forecasts, skipped } = forecastsFromNetflow({
    cohort: 'Fund', rows: [{ token_symbol: 'GHOST', netflow: 9_000_000 }],
    atIso: '2026-06-01T00:00:00Z', priceAt: () => null,
  })
  assert.equal(forecasts.length, 0)
  assert.equal(skipped.noPrice, 1)
})

t('forecast ids are deterministic, so a re-run updates rather than duplicates', () => {
  const a = forecastId({ cohort: 'Fund', subject: 'SOL', atIso: '2026-06-01T00:00:00Z', horizonHours: 48 })
  const b = forecastId({ cohort: 'Fund', subject: 'SOL', atIso: '2026-06-01T00:00:00Z', horizonHours: 48 })
  const c = forecastId({ cohort: 'Fund', subject: 'SOL', atIso: '2026-06-01T00:00:00Z', horizonHours: 24 })
  assert.equal(a, b)
  assert.notEqual(a, c)
})

t('an unmaturable forecast returns nulls and a reason — not a zero', () => {
  const f = { id: 'x', atIso: '2026-06-01T00:00:00Z', horizonHours: 48, direction: 'long', entryPriceUsd: 100 }
  const o = matureForecast({ forecast: f, series: [] })
  assert.equal(o.exitPriceUsd, null)
  assert.ok(o.note.includes('pending, not zero'))
})

t('the drift-matched control is reproducible from the seed', () => {
  const series = Array.from({ length: 400 }, (_, i) => ({ tsMs: Date.UTC(2026, 5, 1) + (i - 100) * 3_600_000, priceUsd: 100 + i }))
  const f = { id: 'stable-id', atIso: '2026-06-01T00:00:00Z', horizonHours: 48, direction: 'long', entryPriceUsd: 100 }
  const a = matureForecast({ forecast: f, series })
  const b = matureForecast({ forecast: f, series })
  assert.equal(a.controlEntryIso, b.controlEntryIso, 'a re-run must draw the SAME control or the study is re-rollable')
})

console.log('\nCLIENT — metered, redacting, drift-refusing\n')

t('refuses to construct without a key', () => {
  assert.throws(() => new NansenClient({ creditBudget: 100 }), /refuses to construct/)
})

t('refuses to construct without a credit budget', () => {
  assert.throws(() => new NansenClient({ apiKey: 'k'.repeat(20) }), /creditBudget is required/)
})

t('refuses a call that would breach the budget, BEFORE sending it', async () => {
  let sent = 0
  const c = new NansenClient({ apiKey: 'k'.repeat(20), creditBudget: 4, fetchImpl: async () => { sent++; return { ok: true, json: async () => ({ data: [] }) } } })
  await c.post('/api/v1/smart-money/netflow', {}).then(() => { throw new Error('should have refused') }, (e) => {
    assert.ok(/exceed the 4-credit budget/.test(e.message))
  })
  assert.equal(sent, 0, 'the request must not leave the process')
})

t('shape drift is refused and NAMES the keys it saw', async () => {
  const c = new NansenClient({ apiKey: 'k'.repeat(20), creditBudget: 100, fetchImpl: async () => ({ ok: true, json: async () => ({ results: [], meta: 1 }) }) })
  const r = await c.post('/api/v1/smart-money/netflow', {})
  assert.equal(r.state, 'shape-refused')
  assert.ok(r.note.includes('results'), 'the refusal must describe the surprise, or it is just a failure')
})

t('the key never appears in an error path', async () => {
  const KEY = 'supersecret-nansen-key-123456'
  const c = new NansenClient({ apiKey: KEY, creditBudget: 100, fetchImpl: async () => { throw new Error(`connect failed for ${KEY}`) } })
  const r = await c.post('/api/v1/smart-money/netflow', {})
  assert.ok(!JSON.stringify(r).includes(KEY), 'the key leaked through an error message')
  assert.ok(!JSON.stringify(c.log).includes(KEY), 'the key leaked into the call log')
})

t('every callable endpoint is priced — an unpriced one is refused', async () => {
  const c = new NansenClient({ apiKey: 'k'.repeat(20), creditBudget: 100 })
  await assert.rejects(c.post('/api/v1/made-up', {}), /unpriced endpoint/)
  assert.ok(Object.keys(CREDIT_COST).length >= 15)
})

t('the cohort list is fixed, so the search count cannot drift', async () => {
  const c = new NansenClient({ apiKey: 'k'.repeat(20), creditBudget: 100 })
  await assert.rejects(c.smartMoneyNetflow({ chains: ['ethereum'], cohort: 'Vibes Trader' }), /unknown cohort/)
  assert.equal(SMART_MONEY_COHORTS.length, 6)
})

console.log('\nBACKTESTING FAMILY — the look-ahead trap and the convention that avoids it\n')

const stubClient = (reply) => new NansenClient({
  apiKey: 'sk-test-NEVER-LOG-THIS', creditBudget: 5000,
  fetchImpl: async () => ({ ok: true, status: 200, headers: new Map(), json: async () => reply ?? { data: [] } }),
})

t('every /api/v1beta1/ endpoint is priced at the 5x historical rate, not its real-time rate', () => {
  assert.equal(CREDIT_COST['/api/v1beta1/tgm/historical-token-ohlcv'], 5,
    'this was 1 credit on the wrong path until 2026-09-16; a budget built on that runs out 5x sooner than it predicts')
  assert.equal(CREDIT_COST['/api/v1beta1/tgm/historical-token-flow-summary'], 5)
  assert.equal(CREDIT_COST['/api/v1beta1/smart-money/historical-token-balances'], 25)
  assert.equal(CREDIT_COST['/api/v1/tgm/historical-token-ohlcv'], undefined,
    'the old mispriced path must be GONE, not shadowed — an unpriced path throws, which is the safe failure')
})

await t('windowing bounds the look-ahead, and the bound travels with the data', async () => {
  const c = stubClient()
  const r = await c.flowSummaryWindowed({
    chain: 'ethereum', tokenAddress: '0xabc',
    fromIso: '2026-01-01', toIso: '2026-04-01', windowDays: 30,
  })
  assert.equal(r.windows.length, 3)
  assert.equal(r.lookAheadBoundDays, 30)
  // the whole point: labels resolve at each window's OWN end, not at the far end
  for (const w of r.windows) assert.equal(w.labelsResolvedAt, w.window.toIso)
  assert.notEqual(r.windows[0].labelsResolvedAt, r.windows[2].labelsResolvedAt)
  assert.equal(c.spendReport().creditsSpent, 15, '3 windows x 5 credits — the price of the study being a study')
})

await t('the naive arm labels itself leaky and names what it is for', async () => {
  const c = stubClient()
  const r = await c.flowSummaryNaive({ chain: 'ethereum', tokenAddress: '0xabc', fromIso: '2026-01-01', toIso: '2026-07-01' })
  assert.ok(r.warning.includes('LEAKY BY CONSTRUCTION'))
  assert.ok(r.lookAheadBoundDays > 150, `expected a large bound, got ${r.lookAheadBoundDays}`)
  assert.equal(c.spendReport().creditsSpent, 5, 'one call — which is exactly why it is the tempting one')
})

await t('an unbounded window is refused — the bound is not optional', async () => {
  const c = stubClient()
  await assert.rejects(
    () => c.flowSummaryWindowed({ chain: 'ethereum', tokenAddress: '0x', fromIso: '2026-01-01', toIso: '2026-02-01', windowDays: 0 }),
    /windowDays must be >= 1/,
  )
})

await t('a chain the endpoint does not cover is refused by name, SEI included', async () => {
  const c = stubClient()
  await assert.rejects(
    () => c.flowSummaryWindowed({ chain: 'sei', tokenAddress: '0x', fromIso: '2026-01-01', toIso: '2026-02-01' }),
    /not covered/,
  )
  assert.ok(!HISTORICAL_FLOW_CHAINS.includes('sei'))
})

await t('a TRUNCATED price tape is refused, not returned short', async () => {
  const c = stubClient({ data: [{ interval_start: '2026-01-01T00:00:00Z', close: 1 }], truncated: true, truncation_note: 'hit the 50,000 candle cap; most recent omitted' })
  const r = await c.historicalOhlcv({ chain: 'ethereum', tokenAddress: '0xabc', fromIso: '2020-01-01', asOfIso: '2026-09-01' })
  assert.equal(r.ok, false)
  assert.equal(r.state, 'truncation-refused')
  assert.ok(r.note.includes('absent outcomes'), 'the refusal must say WHY a short tape is dangerous, not just that it is short')
})

t('the historical segment list is fixed, and carries its negative control', () => {
  assert.equal(HISTORICAL_SEGMENTS.length, 6, 'six segments x three horizons keeps the Bonferroni bar at 18')
  assert.ok(HISTORICAL_SEGMENTS.includes('exchange'),
    'exchange flow is custody movement, not conviction — it is the negative control and must read fail-signal')
  assert.ok(Object.isFrozen(HISTORICAL_SEGMENTS))
})

console.log('\nSTATISTICS\n')

t('the block bootstrap returns a sane p for an obvious effect and a null one', () => {
  const strong = Array.from({ length: 500 }, () => 100 + 10 * gauss())
  const nothing = Array.from({ length: 500 }, () => 10 * gauss())
  assert.ok(bootstrapP(strong) < 0.01)
  assert.ok(bootstrapP(nothing) > 0.05)
})

t('the shipped standard error knows the observations overlap, and the iid one does not', () => {
  // an AR(1) tape: each row shares most of its information with the one before,
  // which is exactly what hourly passes at a 48h horizon produce
  const n = 4000
  const dependent = []
  let prev = 0
  for (let i = 0; i < n; i++) { prev = 0.95 * prev + gauss(); dependent.push(prev) }
  const dep = blockBootstrap(dependent)
  assert.ok(dep.seBps > dep.iidSeBps * 1.8,
    `on serially dependent rows the block SE (${dep.seBps}) must far exceed the iid SE (${dep.iidSeBps}) — if it does not, an agent sizing on it overbets`)
  assert.ok(dep.effectiveN < n / 3,
    `${n} overlapping rows are not worth ${n} independent ones; effectiveN came back ${dep.effectiveN}`)

  // and on genuinely independent rows the two must agree, or the correction is
  // just a constant penalty rather than a measurement
  const iid = Array.from({ length: n }, () => gauss())
  const ind = blockBootstrap(iid)
  assert.ok(Math.abs(ind.varianceInflation - 1) < 0.25,
    `on iid rows the block SE must track the iid SE; inflation came back ${ind.varianceInflation}`)
})

t('a prior ships the honest SE, the iid one beside it, and the deflation between them', () => {
  const { forecasts, outcomes } = world({ n: 4000, trueExcessBps: 60, noiseBps: 500 })
  const r = assayCohort({ cohort: 'Fund', horizonHours: 48, forecasts, outcomes, searchCount: 18 })
  assert.ok(r.prior.standardErrorBps > 0)
  assert.ok(r.prior.iidStandardErrorBps > 0)
  assert.ok(r.prior.effectiveN <= r.prior.n, 'effectiveN can never exceed n')
  assert.ok(r.prior.varianceInflation >= 1 - 1e-9, 'a correction that SHRINKS the standard error is the bug this test exists to catch')
})

t('normCdf is accurate enough at the tails we care about', () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-6)
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3)
  assert.ok(Math.abs(normCdf(-2.58) - 0.00494) < 1e-3)
})

t('calibration reports a reliability curve, not just a Brier score', () => {
  const pairs = Array.from({ length: 600 }, () => { const p = rnd(); return { predicted: p, actual: rnd() < p ? 1 : 0 } })
  const c = calibration(pairs)
  assert.ok(c.brier > 0 && c.brier < 0.3)
  assert.equal(c.curve.length, 5)
  const mid = c.curve[2]
  assert.ok(Math.abs(mid.observedFrequency - mid.meanPredicted) < 0.12, 'a well-calibrated generator must look calibrated')
})

t('the tournament computes its own search count and cannot understate it', () => {
  const { forecasts, outcomes } = world({ n: 200, trueExcessBps: 0 })
  const r = tournament({
    cohorts: ['A', 'B', 'C'], horizons: [24, 48],
    forecastsFor: () => forecasts, outcomesFor: () => outcomes,
  })
  assert.equal(r.searchCount, 6)
  assert.equal(r.results.length, 6)
  assert.ok(r.results.every((x) => x.provenance.searchCount === 6))
})

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILING`} — ${pass + fail} checks.\n`)
process.exit(fail === 0 ? 0 : 1)
