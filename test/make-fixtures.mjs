#!/usr/bin/env node
/**
 * FIXTURE GENERATOR WITH A PLANTED GROUND TRUTH.
 *
 * The only way to know a measurement engine works is to hand it data where you
 * already know the answer. So this builds a synthetic world with four kinds of
 * cohort deliberately mixed together:
 *
 *   Smart HL Perps Trader   a LARGE real edge
 *                           -> `economic` across most of the cost range
 *   Fund                    a MODERATE real edge
 *                           -> `economic` cheap, `fail-economic` dear. The
 *                              same cohort, the same measurement, two verdicts
 *                              depending only on what it costs you to trade —
 *                              which is the distinction the project exists for.
 *   30D Smart Trader        a FAINT real edge
 *                           -> `fail-signal`, because eighteen hypotheses buy a
 *                              Bonferroni bar this edge cannot clear. A real
 *                              effect correctly refused is not a bug; it is the
 *                              price of the search, and a tool that quietly
 *                              waived it here would waive it everywhere.
 *   everyone else           no edge at all, just market drift
 *                           -> `fail-signal`
 *
 * A STRONG MARKET DRIFT is baked in on purpose. Every token trends upward over
 * the window, so a naive measurement that forgets the control will report a
 * handsome edge for all six cohorts. If the drift-matched control is working,
 * that drift subtracts out and only the planted excess survives. A fixture
 * without drift could not tell a working control from a missing one.
 *
 *   node test/make-fixtures.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = process.argv[2] ?? 'fixtures'
mkdirSync(OUT, { recursive: true })

const COHORTS = ['Fund', 'Smart Trader', '30D Smart Trader', '90D Smart Trader', '180D Smart Trader', 'Smart HL Perps Trader']

/**
 * The signal-to-noise knob per cohort. NOT a target in bps — it sets how much of
 * the forward return the cohort "sees" when it picks, and the excess that comes
 * out the other side is an emergent property of that plus the selectivity.
 * GROUND-TRUTH.json therefore reports the REALIZED excess as well, measured the
 * same way the engine measures it, and the expectations below are derived from
 * the realized figures rather than from these knobs. A ground truth stated as
 * prose drifts away from the data the moment anything is retuned; one computed
 * from the data cannot.
 */
const SNR_KNOB = {
  'Smart HL Perps Trader': 55,   // a large edge — tradeable across most cost regimes
  'Fund': 25,                    // a moderate edge — flips to fail-economic partway up the cost range
  '30D Smart Trader': 5,         // a FAINT edge the 18-hypothesis bar should refuse
  'Smart Trader': 0,
  '90D Smart Trader': 0,
  '180D Smart Trader': 0,
}

/**
 * Thirty tokens and twenty-four picks a pass, which is not padding. `fail-economic`
 * is only REACHABLE once n is large enough that the detection threshold falls
 * BELOW the cost threshold — at n≈6k the smallest detectable edge is ~22 bps
 * against a 12 bps cost, so no edge can be both significant and sub-cost and the
 * verdict can never fire. Around n≈25k the two thresholds cross and the case
 * becomes visible. That crossing is a real property of the method and the fixture
 * has to sit past it to exercise the distinction the project exists for.
 */
const TOKENS = ['SOL','ETH','ARB','SEI','SUI','INJ','TIA','JUP','PYTH','WIF','BONK','ONDO','AVAX','LINK','DOT','ATOM','NEAR','APT','OP','MATIC','LDO','AAVE','UNI','CRV','RUNE','FTM','GRT','SAND','MANA','IMX']
const HOUR = 3_600_000
const START = Date.UTC(2026, 5, 1)        // 2026-06-01
const HOURS = 24 * 210                     // 210 days of hourly candles — a realistic backfill
const PASSES = 24 * 200                    // HOURLY observation passes, which is what an agent actually polls

let s = 20260916
const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296)
const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) }

/**
 * Price paths. Each token gets a shared market factor plus idiosyncratic noise,
 * and the market factor TRENDS — that is the drift the control has to remove.
 */
const market = [0]
for (let i = 1; i < HOURS; i++) market.push(market[i - 1] + 0.0004 + 0.004 * gauss())

const prices = {}
for (const tok of TOKENS) {
  const beta = 0.7 + rnd() * 0.6
  const base = 0.5 + rnd() * 50
  let lp = Math.log(base)
  const series = []
  for (let i = 0; i < HOURS; i++) {
    lp += beta * (market[i] - (i ? market[i - 1] : 0)) + 0.006 * gauss()
    series.push({ tsMs: START + i * HOUR, priceUsd: +Math.exp(lp).toFixed(6) })
  }
  prices[tok] = series
}

/**
 * Observations. A cohort with a planted edge preferentially picks tokens that
 * are ABOUT to outperform — which is what a real edge would look like from the
 * outside. Cohorts without one pick at random.
 */
const observations = []
const priceAt = (tok, ms) => {
  const s2 = prices[tok]
  let best = null
  for (const p of s2) if (p.tsMs <= ms && (best === null || p.tsMs > best.tsMs)) best = p
  return best?.priceUsd ?? null
}
const fwdBps = (tok, ms, h) => {
  const a = priceAt(tok, ms), b = priceAt(tok, ms + h * HOUR)
  return a && b ? Math.log(b / a) * 1e4 : null
}

for (let pass = 0; pass < PASSES; pass++) {
  const atMs = START + pass * HOUR
  if (atMs + 168 * HOUR > START + HOURS * HOUR) break
  const atIso = new Date(atMs).toISOString()

  for (const cohort of COHORTS) {
    const edge = SNR_KNOB[cohort]
    // score every token by what a cohort with this edge would "see"
    const ranked = TOKENS.map((tok) => {
      const truth = fwdBps(tok, atMs, 48) ?? 0
      // a cohort with edge E sees the future with signal-to-noise proportional to E
      const perceived = (edge / 55) * truth + 900 * gauss()
      return { tok, perceived }
    }).sort((a, b) => b.perceived - a.perceived)

    const picks = ranked.slice(0, 6)   // 6 of 30 — selectivity is where the edge lives
    observations.push({
      atIso,
      kind: 'observation',
      cohort,
      endpoint: cohort === 'Smart HL Perps Trader' ? 'smart-money/perp-trades' : 'smart-money/netflow',
      state: 'ok',
      rows: picks.length,
      specHash: 'fixture',
      data: picks.map((p, i) => ({
        chain: 'ethereum',
        token_symbol: p.tok,
        token_address: '0x' + 'f'.repeat(40),
        netflow: Math.round((7 - i) * 400_000 + rnd() * 200_000),
        value_usd: Math.round((7 - i) * 1_200_000),
      })),
    })
  }
}

// Compute the REALIZED excess per cohort, so GROUND-TRUTH states what was
// actually produced rather than the SNR knob that produced it. The engine never
// reads this; it exists so a reader can check the verdicts against the truth.
const realized = {}
for (const cohort of COHORTS) {
  const obs = observations.filter((o) => o.cohort === cohort)
  const ex = []
  for (const o of obs) {
    const atMs = Date.parse(o.atIso)
    for (const d of o.data) {
      const sig = fwdBps(d.token_symbol, atMs, 48)
      // the control: same token, same horizon, shifted by a fixed pseudo-random offset
      const off = Math.round((rnd() * 2 - 1) * 3 * 24) * HOUR
      const ctl = fwdBps(d.token_symbol, atMs + off, 48)
      if (sig !== null && ctl !== null) ex.push(sig - ctl)
    }
  }
  realized[cohort] = ex.length ? +(ex.reduce((a, b) => a + b, 0) / ex.length).toFixed(1) : null
}

writeFileSync(join(OUT, 'observations.jsonl'), observations.map((o) => JSON.stringify(o)).join('\n') + '\n')
writeFileSync(join(OUT, 'prices.json'), JSON.stringify(prices))
/**
 * The expectation is COMPUTED from the realized excess, not typed out beside it.
 *
 * A hardcoded sentence ("Fund should read fail-economic") is correct exactly
 * once — until a knob moves, and then the ground truth quietly asserts something
 * the data no longer contains, which is worse than having no ground truth at
 * all. So each cohort's expectation is derived here from the excess the
 * generator actually produced, and the derivation is stated so a reader can
 * check it rather than trust it.
 *
 * The significance rule below is the ONLY thing the fixture assumes about the
 * engine: with roughly 2,000 effective observations the block-bootstrap standard
 * error on a 48h excess runs near 14 bps, so clearing a Bonferroni bar of
 * 0.05/18 takes about three of those — call it 42 bps. That threshold is
 * approximate and stated as approximate; the engine's own p-value is what
 * decides, and the point of the fixture is that the two should agree.
 */
const APPROX_SE_BPS_48H = 14
const APPROX_SIGNIFICANCE_BPS = 3 * APPROX_SE_BPS_48H
const expectation = {}
for (const cohort of COHORTS) {
  const e = realized[cohort]
  if (e === null) { expectation[cohort] = 'insufficient — no matured pairs'; continue }
  if (e < APPROX_SIGNIFICANCE_BPS) {
    expectation[cohort] =
      e < 10
        ? `fail-signal at every cost — realized excess ${e} bps is indistinguishable from drift`
        : `fail-signal at every cost — realized excess ${e} bps is REAL but below what a Bonferroni bar over ${COHORTS.length * 3} hypotheses can certify (~${APPROX_SIGNIFICANCE_BPS} bps here). Correctly refused, not missed.`
  } else {
    expectation[cohort] =
      `economic below roughly ${Math.round(e)} bps of round-trip cost and fail-economic above it — ` +
      `realized excess ${e} bps clears the bar, so the verdict turns on cost alone`
  }
}

writeFileSync(join(OUT, 'GROUND-TRUTH.json'), JSON.stringify({
  note: 'What was planted. The engine has never seen this file — it is here so a reader can check the verdicts against the truth.',
  snrKnob: SNR_KNOB,
  snrKnobNote: 'The generator input: how much of the forward return each cohort "sees" when it picks. NOT a target in bps.',
  realizedExcessBps48h: realized,
  realizedNote: 'The excess the generator actually produced at 48h, measured the same way the engine measures it. This is the column to compare verdicts against.',
  marketDriftPerHourBps: 4,
  expectationDerivedFrom: `realizedExcessBps48h, with an approximate significance threshold of 3 x ${APPROX_SE_BPS_48H} bps block-bootstrap SE = ${APPROX_SIGNIFICANCE_BPS} bps`,
  expectation,
  theTestThatMatters:
    'A cohort whose realized excess clears the bar must move between `economic` and `fail-economic` as cost crosses that excess, and must never fall to `fail-signal` on the way. A signal is real or it is not; cost cannot make it unreal. If any cohort crosses from economic straight to fail-signal as cost rises, the two verdicts have collapsed into one and the engine is broken.',
}, null, 2))

console.log(`fixtures written to ${OUT}/`)
console.log(`  ${observations.length} observation passes across ${COHORTS.length} cohorts`)
console.log(`  ${TOKENS.length} tokens, ${HOURS} hourly candles, market drift baked in`)

