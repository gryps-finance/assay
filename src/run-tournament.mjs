#!/usr/bin/env node
/**
 * THE TOURNAMENT RUNNER.
 *
 * Six Nansen Smart Money cohorts × three horizons = eighteen hypotheses, scored
 * against one shared Bonferroni bar, each with a drift-matched control.
 *
 * TWO MODES, and the second one matters more than it looks:
 *
 *   --live      hit Nansen with a real key, append observations to the ledger
 *   --replay    run the identical pipeline over recorded fixtures, no key
 *
 * Replay exists because a result nobody else can reproduce is a claim, not a
 * finding. Every live run records its raw responses, so any verdict in this repo
 * can be re-derived by someone who has never held our API key. That is also why
 * the fixtures ship: a judge should be able to clone, run, and get the same
 * numbers in under a minute.
 *
 *   node src/run-tournament.mjs --replay fixtures/
 *   NANSEN_API_KEY=... node src/run-tournament.mjs --live --budget 2000
 *
 * The runner is deliberately boring. All the judgement lives in assay.mjs and
 * forecast.mjs, both pure; this file only moves bytes.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { NansenClient, SMART_MONEY_COHORTS } from './nansen.mjs'
import { forecastsFromNetflow, matureForecast, SIGNAL_SPEC, specHash } from './forecast.mjs'
import { tournament } from './assay.mjs'

const args = process.argv.slice(2)
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const LIVE = args.includes('--live')
const REPLAY_DIR = args.includes('--replay') ? args[args.indexOf('--replay') + 1] : null
const LEDGER_DIR = process.env.ASSAY_LEDGER_DIR ?? argOf('--ledger', 'ledger')
const BUDGET = Number(argOf('--budget', '2000'))
const CHAINS = (argOf('--chains', 'ethereum,solana,base,arbitrum') || '').split(',').filter(Boolean)
/**
 * Round-trip cost, in bps, and the single most consequential knob here.
 *
 * The SAME measured signal is tradeable at one cost and not at another, which is
 * exactly why the two-verdict split exists. 12 bps is a liquid perp taker round
 * trip; 50 is a thinner book or a retail venue; 6 is a maker rebate or size that
 * earns one. Re-running a study at a different cost is not p-hacking — the
 * signal measurement is untouched and only the economic threshold moves, which
 * is a question about YOUR execution rather than about the cohort.
 */
const COST_RT_BPS = Number(argOf('--cost', '12'))

mkdirSync(LEDGER_DIR, { recursive: true })
const OBS = join(LEDGER_DIR, 'observations.jsonl')
const VERDICTS = join(LEDGER_DIR, 'verdicts.json')

const nowIso = () => new Date().toISOString()

// ───────────────────────────────────────────────────────────── live capture

async function captureLive() {
  const key = process.env.NANSEN_API_KEY
  if (!key) {
    console.error('\nNANSEN_API_KEY is not set.')
    console.error('Get one at https://app.nansen.ai and export it, or run --replay fixtures/ to reproduce')
    console.error('the published verdicts without a key.\n')
    process.exit(2)
  }
  const client = new NansenClient({ apiKey: key, creditBudget: BUDGET })

  console.log(`\nASSAY — live capture across ${SMART_MONEY_COHORTS.length} cohorts, budget ${BUDGET} credits\n`)
  const atIso = nowIso()
  let captured = 0

  for (const cohort of SMART_MONEY_COHORTS) {
    // Smart HL Perps Trader lives on the perps endpoint; the rest on netflow.
    const res =
      cohort === 'Smart HL Perps Trader'
        ? await client.smartMoneyPerpTrades({ cohort })
        : await client.smartMoneyNetflow({ chains: CHAINS, cohort })

    const row = {
      atIso,
      kind: 'observation',
      cohort,
      endpoint: cohort === 'Smart HL Perps Trader' ? 'smart-money/perp-trades' : 'smart-money/netflow',
      state: res.state,
      rows: res.ok ? (res.data.data?.length ?? 0) : 0,
      note: res.note,
      // the raw payload is kept so any verdict can be re-derived later
      data: res.ok ? res.data.data ?? [] : null,
      specHash: specHash(),
    }
    appendFileSync(OBS, JSON.stringify(row) + '\n')
    captured += row.rows
    console.log(`  ${cohort.padEnd(24)} ${String(row.state).padEnd(14)} ${String(row.rows).padStart(4)} rows`)
  }

  const spend = client.spendReport()
  console.log(`\n  credits ${spend.creditsSpent} / ${BUDGET}   calls ${spend.calls}   ${spend.contestProgress}`)
  console.log(`  ${captured} observation rows appended to ${OBS}\n`)
  appendFileSync(OBS, JSON.stringify({ atIso, kind: 'spend-report', ...spend }) + '\n')
  return spend
}

// ──────────────────────────────────────────────────────────── replay + score

function loadObservations(dir) {
  const path = join(dir, 'observations.jsonl')
  if (!existsSync(path)) {
    const alt = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    if (alt.length === 0) { console.error(`no observations.jsonl or *.jsonl under ${dir}`); process.exit(2) }
    return readFileSync(join(dir, alt[0]), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  }
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function loadPriceSeries(dir) {
  const path = join(dir, 'prices.json')
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8'))
}

function score(dir) {
  const rows = loadObservations(dir).filter((r) => r.kind === 'observation' && r.state === 'ok' && Array.isArray(r.data))
  const prices = loadPriceSeries(dir)

  const priceAt = (symbol, atIso) => {
    const s = prices[symbol]
    if (!Array.isArray(s) || s.length === 0) return null
    const t = Date.parse(atIso)
    let best = null
    for (const p of s) if (p.tsMs <= t && (best === null || p.tsMs > best.tsMs)) best = p
    return best && t - best.tsMs <= 2 * 3_600_000 ? best.priceUsd : null
  }

  const allForecasts = []
  const skippedTotals = { belowThreshold: 0, noPrice: 0, unparseable: 0, notTopK: 0 }
  for (const obs of rows) {
    const { forecasts, skipped } = forecastsFromNetflow({
      cohort: obs.cohort,
      rows: obs.data,
      atIso: obs.atIso,
      priceAt: (sym) => priceAt(sym, obs.atIso),
    })
    allForecasts.push(...forecasts)
    for (const k of Object.keys(skippedTotals)) skippedTotals[k] += skipped[k] ?? 0
  }

  const outcomes = allForecasts.map((f) =>
    matureForecast({ forecast: f, series: prices[f.subject] ?? [] }),
  )

  const t = tournament({
    opts: { costRtBps: COST_RT_BPS },
    cohorts: SMART_MONEY_COHORTS,
    horizons: SIGNAL_SPEC.horizonsHours,
    forecastsFor: (c, h) => allForecasts.filter((f) => f.cohort === c && f.horizonHours === h),
    outcomesFor: (c, h) => {
      const ids = new Set(allForecasts.filter((f) => f.cohort === c && f.horizonHours === h).map((f) => f.id))
      return outcomes.filter((o) => ids.has(o.forecastId))
    },
  })

  const out = {
    asOf: nowIso(),
    specHash: specHash(),
    spec: SIGNAL_SPEC,
    costRtBps: COST_RT_BPS,
    observationsUsed: rows.length,
    forecastsFormed: allForecasts.length,
    forecastsSkipped: skippedTotals,
    ...t,
  }
  writeFileSync(VERDICTS, JSON.stringify(out, null, 2))
  return out
}

function report(out) {
  console.log(`\nASSAY TOURNAMENT — ${out.searchCount} hypotheses, Bonferroni bar ${(0.05 / out.searchCount).toExponential(2)}, round-trip cost ${out.costRtBps} bps\n`)
  console.log(`  ${out.observationsUsed} observation passes -> ${out.forecastsFormed} forecasts`)
  const s = out.forecastsSkipped
  console.log(`  skipped: ${s.belowThreshold} below threshold, ${s.notTopK} outside top-K, ${s.noPrice} no price, ${s.unparseable} unparseable`)
  console.log(`\n  ${'COHORT'.padEnd(24)} ${'HRZN'.padStart(5)}  ${'VERDICT'.padEnd(15)} ${'NET bps'.padStart(9)} ${'±SE'.padStart(7)} ${'n'.padStart(5)}  p`)
  console.log(`  ${'-'.repeat(24)} ${'-'.repeat(5)}  ${'-'.repeat(15)} ${'-'.repeat(9)} ${'-'.repeat(7)} ${'-'.repeat(5)}  ------`)
  for (const r of out.ranked) {
    const p = r.provenance
    console.log(
      `  ${p.cohort.padEnd(24)} ${String(p.horizonHours).padStart(4)}h  ${r.verdict.padEnd(15)} ` +
      `${(r.prior ? r.prior.netMeanBps.toFixed(1) : '—').padStart(9)} ` +
      `${(r.prior ? r.prior.standardErrorBps.toFixed(1) : '—').padStart(7)} ` +
      `${String(p.matured).padStart(5)}  ${r.prior?.pValue ?? '—'}`,
    )
  }
  console.log(`\n  ${out.summary.headline}\n`)
  const real = out.results.filter((r) => r.verdict === 'fail-economic')
  if (real.length) {
    console.log('  REAL BUT PRICED OUT — the set a cheaper execution path would convert:')
    for (const r of real) console.log(`    ${r.provenance.cohort} @ ${r.provenance.horizonHours}h — excess ${r.detail.excessMeanBps} bps, net ${r.prior.netMeanBps} bps`)
    console.log('')
  }
  console.log(`  verdicts written to ${VERDICTS}`)
  console.log(`  serve them to any agent:  node src/mcp-server.mjs\n`)
}

// ───────────────────────────────────────────────────────────────────── main

if (LIVE) {
  await captureLive()
  console.log('  Observations captured. Outcomes mature on their own clock — re-run scoring')
  console.log('  once the horizons have elapsed:  node src/run-tournament.mjs --replay ' + LEDGER_DIR + '\n')
} else if (REPLAY_DIR) {
  report(score(REPLAY_DIR))
} else {
  console.log(`
ASSAY — measured priors for Nansen Smart Money cohorts

  node src/run-tournament.mjs --replay fixtures/        reproduce published verdicts, no key needed
  NANSEN_API_KEY=... node src/run-tournament.mjs --live capture a fresh observation pass
  node src/mcp-server.mjs                               serve verdicts to any agent over MCP

The tournament scores six cohorts at three horizons against one shared
Bonferroni bar, each with a drift-matched control, and reports two kinds of
failure separately: a signal that is not real, and a signal that is real and
does not clear costs. Those are opposite instructions.
`)
}
