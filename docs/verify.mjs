#!/usr/bin/env node
/**
 * VERIFY BOTH PAGES AGAINST THE ENGINE.
 *
 * Each page's whole claim is that it renders engine output and computes no
 * verdict of its own. That claim is worth exactly as much as a check, so this
 * file opens each built page in a real browser, drives the slider to a set of
 * costs, scrapes what the DOM actually shows, and compares it with an
 * independent derivation:
 *
 *   check.html  against `run-tournament` re-run from the seeded fixtures at the
 *               same cost (needs `npm run fixtures` first: 35 MB, not shipped)
 *   index.html  against ledger/study/verdicts.json, the scorer's own output
 *               file, not the sweep the page inlines: every cell's verdict and
 *               net re-derived at every cost with the engine's two-verdict rule,
 *               the money panel re-run through src/economics.mjs, and the audit
 *               table re-read from ledger/study/convention-audit.json. The raw
 *               Nansen responses are not redistributed, so this is the deepest
 *               check a public clone can run; the private ledger re-scores
 *               byte-identically (ledger/study/score-report.txt).
 *
 * It also fails on any console error, because a page that renders its first
 * frame and then throws on interaction looks fine in a screenshot.
 *
 *   node docs/verify.mjs           both pages
 *   node docs/verify.mjs --study   the study page only (no fixtures needed)
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execSync } from 'node:child_process'
import { DEFAULTS, tournament } from '../src/assay.mjs'
import { agents } from '../src/economics.mjs'
import { forecastsFromNetflow, matureForecast, SIGNAL_SPEC } from '../src/forecast.mjs'
import { SMART_MONEY_COHORTS } from '../src/nansen.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CHECK_COSTS = [0, 12, 44, 78, 84, 90, 160, 200]

/**
 * Playwright is a verification dependency, not a shipping one — the repo has
 * zero runtime dependencies and this file is not going to be what changes that.
 * So it is resolved wherever it happens to live, including a global install, and
 * its absence is reported as "cannot verify" rather than swallowed. A check that
 * silently skips is worse than no check, because it reports success.
 */
async function loadChromium() {
  // a CJS playwright imported from ESM lands under .default, a real ESM build
  // exposes .chromium directly — take whichever actually has a browser on it
  const pick = (m) => m?.chromium ?? m?.default?.chromium ?? null
  for (const spec of ['playwright', 'playwright-core']) {
    try { const c = pick(await import(spec)); if (c) return c } catch { /* keep looking */ }
  }
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim()
    for (const pkg of ['playwright', 'playwright-core']) {
      try {
        const c = pick(await import(pathToFileURL(join(root, pkg, 'index.js')).href))
        if (c) return c
      } catch { /* keep looking */ }
    }
  } catch { /* fall through */ }
  console.error('\nCannot verify: playwright is not resolvable from here.')
  console.error('  npm i -D playwright   (or install it globally), then re-run.\n')
  process.exit(2)
}
const chromium = await loadChromium()
const STUDY_ONLY = process.argv.includes('--study')
if (!STUDY_ONLY && !existsSync(join(ROOT, 'fixtures/observations.jsonl'))) {
  console.error('\nCannot verify check.html: no fixtures. Run `npm run fixtures` first (seeded, about 35 MB), or pass --study.\n')
  process.exit(2)
}
const browser = await chromium.launch()
const failures = []
const consoleErrors = []
const usd = (n) => (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US')

// ════════════════════════════════════════════════════════════════════════════
// THE STUDY: index.html against the scorer's own verdicts file
// ════════════════════════════════════════════════════════════════════════════
{
  const V = JSON.parse(readFileSync(join(ROOT, 'ledger/study/verdicts.json'), 'utf8'))
  const alpha = V.results[0].provenance.adjustedAlpha
  const pairs = V.results.map((r) => ({
    cohort: r.provenance.cohort, horizonHours: r.provenance.horizonHours,
    excessMeanBps: r.detail.excessMeanBps, sdBps: r.prior.sdBps, standardErrorBps: r.prior.standardErrorBps, pValue: r.prior.pValue,
  }))
  /** the engine's two-verdict rule (src/assay.mjs), applied to the scorer's measured excess at any cost */
  const verdictAt = (p, cost) => {
    const real = p.pValue !== null && p.pValue <= alpha && p.excessMeanBps > 0
    if (!real) return 'fail-signal'
    return p.excessMeanBps - cost > DEFAULTS.economicMarginBps ? 'economic' : 'fail-economic'
  }
  // the frame at the scored cost must BE the verdicts file, exactly
  const scoredCost = V.costRtBps
  const A = JSON.parse(readFileSync(join(ROOT, 'ledger/study/convention-audit.json'), 'utf8'))

  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ colorScheme: theme, viewport: { width: 1280, height: 1000 } })
    const page = await ctx.newPage()
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[study ${theme}] ${m.text()}`) })
    page.on('pageerror', (e) => consoleErrors.push(`[study ${theme}] pageerror: ${e.message}`))
    const url = pathToFileURL(join(HERE, 'index.html')).href
    await page.goto(url)
    await page.waitForSelector('.cell[data-v]')
    const rest = await page.evaluate(() => ({ cost: Number(document.getElementById('cost').value), pressed: document.querySelector('.cell[aria-pressed="true"]')?.dataset, h1: document.getElementById('h1').textContent, truth: document.getElementById('truth-sec').hidden, audit: document.getElementById('audit-sec').hidden }))
    if (rest.cost !== scoredCost) failures.push(`[study ${theme}] at rest the page opens at ${rest.cost} bps; the study was scored at ${scoredCost}`)
    if (rest.pressed?.c !== 'Whale' || Number(rest.pressed?.h) !== 24) failures.push(`[study ${theme}] at rest the selected pair is ${JSON.stringify(rest.pressed)}`)
    if (!rest.truth || rest.audit) failures.push(`[study ${theme}] the study shows the planted-truth section or hides the audit`)
    await page.screenshot({ path: join(HERE, `../.verify-study-${theme}.png`), fullPage: true })

    for (const cost of CHECK_COSTS) {
      await page.evaluate((c) => { const el = document.getElementById('cost'); el.value = String(c); el.dispatchEvent(new Event('input', { bubbles: true })) }, cost)
      const shown = await page.evaluate(() => ({
        agents: [...document.querySelectorAll('.agent .amt')].map((el) => el.textContent.trim()),
        econ: Number(document.getElementById('t-econ').textContent), costly: Number(document.getElementById('t-costly').textContent), dead: Number(document.getElementById('t-dead').textContent),
        cells: [...document.querySelectorAll('.cell')].map((b) => ({ cohort: b.dataset.c, horizonHours: Number(b.dataset.h), verdict: b.dataset.v, net: b.querySelector('.v').textContent.trim() })),
      }))
      const eq = (what, a, b) => { if (a !== b) failures.push(`[study ${theme}] cost ${cost}: ${what}: page ${a}, derived ${b}`) }
      const want = pairs.map((p) => ({ ...p, verdict: verdictAt(p, cost), net: p.excessMeanBps - cost }))
      eq('economic count', shown.econ, want.filter((x) => x.verdict === 'economic').length)
      eq('fail-economic count', shown.costly, want.filter((x) => x.verdict === 'fail-economic').length)
      eq('fail-signal count', shown.dead, want.filter((x) => x.verdict === 'fail-signal').length)
      for (const c of shown.cells) {
        const w = want.find((x) => x.cohort === c.cohort && x.horizonHours === c.horizonHours)
        if (!w) { failures.push(`[study ${theme}] cost ${cost}: ${c.cohort}@${c.horizonHours}h is not in verdicts.json`); continue }
        eq(`${c.cohort}@${c.horizonHours}h verdict`, c.verdict, w.verdict)
        // the verdicts file carries excess to 2 dp and the page shows net to 1 dp: agree within that rounding
        if (!(Math.abs(Number(c.net.replace('−', '-')) - w.net) <= 0.051)) failures.push(`[study ${theme}] cost ${cost}: ${c.cohort}@${c.horizonHours}h net: page ${c.net}, derived ${w.net.toFixed(2)}`)
        if (cost === scoredCost) {
          const r = V.results.find((x) => x.provenance.cohort === c.cohort && x.provenance.horizonHours === c.horizonHours)
          eq(`${c.cohort}@${c.horizonHours}h verdict at the scored cost`, c.verdict, r.verdict)
          eq(`${c.cohort}@${c.horizonHours}h net at the scored cost`, c.net, (r.prior.netMeanBps > 0 ? '+' : '') + r.prior.netMeanBps.toFixed(1))
        }
      }
      const live = agents({ pairs, costRtBps: cost, adjustedAlpha: alpha })
      eq('ungated $/yr', shown.agents[0], usd(live.ungated.perYearUsd))
      eq('gated $/yr', shown.agents[1], usd(live.gated.perYearUsd))
      eq('sized $/yr', shown.agents[2], usd(live.sized.perYearUsd))
    }

    // the audit table, re-read from the audit's own file
    const auditRows = await page.evaluate(() => [...document.querySelectorAll('#auditbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())))
    const NAME = { whale: 'Whale', public_figure: 'Public Figure', top_pnl: 'Top PnL', smart_trader: 'Smart Trader', exchange: 'Exchange', fresh_wallets: 'Fresh Wallets' }
    const pctx = (x) => (x * 100).toFixed(x < 0.1 ? 1 : 0) + '%'
    const segs = Object.entries(A.arms.weekly.segments)
    if (auditRows.length !== segs.length) failures.push(`[study ${theme}] the audit table has ${auditRows.length} rows, the audit ${segs.length} segments`)
    for (const [k, sg] of segs) {
      const row = auditRows.find((r) => r[0] === NAME[k])
      const inc = sg.rebuilds.inclusive
      if (!row) { failures.push(`[study ${theme}] audit: no row for ${k}`); continue }
      if (row[2] !== pctx(inc.withinNonZero)) failures.push(`[study ${theme}] audit ${k}: inclusive within ${row[2]}, file ${pctx(inc.withinNonZero)}`)
      if (row[3] !== inc.spearman.toFixed(2)) failures.push(`[study ${theme}] audit ${k}: spearman ${row[3]}, file ${inc.spearman.toFixed(2)}`)
      if (!row[4].startsWith(`${sg.best.rebuild}: ${pctx(sg.best.withinNonZero)}`)) failures.push(`[study ${theme}] audit ${k}: best ${row[4]}, file ${sg.best.rebuild} ${pctx(sg.best.withinNonZero)}`)
    }
    const fresh = Object.values(A.arms).reduce((a, arm) => { const r = arm.segments.fresh_wallets.rebuilds['last-day']; return { n: a.n + r.nonZeroPairs, m: a.m + Math.round(r.withinNonZero * r.nonZeroPairs) } }, { n: 0, m: 0 })
    const note = await page.evaluate(() => document.getElementById('auditnote').textContent)
    if (!note.includes(`${fresh.m.toLocaleString('en-US')} of ${fresh.n.toLocaleString('en-US')} windows`)) failures.push(`[study ${theme}] the fresh-wallets line does not read ${fresh.m} of ${fresh.n}`)

    // URL state round trip, and the negative control's own words
    await page.goto(url + '?cost=40&cohort=Exchange&h=168')
    await page.waitForSelector('.cell[data-v]')
    const restored = await page.evaluate(() => ({ cost: Number(document.getElementById('cost').value), pressed: document.querySelector('.cell[aria-pressed="true"]')?.dataset, limit: document.getElementById('detail-limit').textContent }))
    if (restored.cost !== 40) failures.push(`[study ${theme}] url cost=40 restored as ${restored.cost}`)
    if (restored.pressed?.c !== 'Exchange' || Number(restored.pressed?.h) !== 168) failures.push(`[study ${theme}] url cohort/horizon did not restore: ${JSON.stringify(restored.pressed)}`)
    if (!/negative control/.test(restored.limit)) failures.push(`[study ${theme}] the Exchange pair does not say it is the negative control`)

    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(250)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    if (overflow > 1) failures.push(`[study ${theme}] page scrolls horizontally at 390px by ${overflow}px`)
    await page.screenshot({ path: join(HERE, `../.verify-study-${theme}-phone.png`), fullPage: true })
    await ctx.close()
  }
  process.stderr.write(`study: ${CHECK_COSTS.length} costs x ${pairs.length} pairs x 2 themes against verdicts.json\n`)
}

if (STUDY_ONLY) {
  await browser.close()
  for (const e of consoleErrors) failures.push(e)
  if (failures.length) {
    console.error(`\n${failures.length} MISMATCH${failures.length === 1 ? '' : 'ES'}:\n`)
    for (const f of failures.slice(0, 40)) console.error('  ' + f)
    process.exit(1)
  }
  console.log(`STUDY PAGE MATCHES THE SCORER: ${CHECK_COSTS.length} costs x 18 pairs x 2 themes, verdicts, net bps, the money panel and the audit table.`)
  console.log('No console errors. No horizontal scroll at 390px.')
  process.exit(0)
}

// ════════════════════════════════════════════════════════════════════════════
// THE CHECK: check.html against the engine re-run from the fixtures
// ════════════════════════════════════════════════════════════════════════════
process.stderr.write('re-deriving from fixtures, independently of the page... ')
const observations = readFileSync(join(ROOT, 'fixtures/observations.jsonl'), 'utf8')
  .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => r.kind === 'observation' && r.state === 'ok' && Array.isArray(r.data))
const prices = JSON.parse(readFileSync(join(ROOT, 'fixtures/prices.json'), 'utf8'))
const priceAt = (symbol, atIso) => {
  const s = prices[symbol]
  if (!Array.isArray(s) || !s.length) return null
  const t = Date.parse(atIso)
  let best = null
  for (const p of s) if (p.tsMs <= t && (best === null || p.tsMs > best.tsMs)) best = p
  return best && t - best.tsMs <= 2 * 3_600_000 ? best.priceUsd : null
}
const allForecasts = []
for (const obs of observations) {
  const { forecasts } = forecastsFromNetflow({
    cohort: obs.cohort, rows: obs.data, atIso: obs.atIso, priceAt: (s) => priceAt(s, obs.atIso),
  })
  allForecasts.push(...forecasts)
}
const outcomes = allForecasts.map((f) => matureForecast({ forecast: f, series: prices[f.subject] ?? [] }))
const byPair = new Map()
for (const f of allForecasts) {
  const k = `${f.cohort}|${f.horizonHours}`
  if (!byPair.has(k)) byPair.set(k, { forecasts: [], ids: new Set() })
  byPair.get(k).forecasts.push(f); byPair.get(k).ids.add(f.id)
}
const outcomeById = new Map(outcomes.map((o) => [o.forecastId, o]))
const truth = new Map()
for (const costRtBps of CHECK_COSTS) {
  const t = tournament({
    opts: { costRtBps }, cohorts: SMART_MONEY_COHORTS, horizons: SIGNAL_SPEC.horizonsHours,
    forecastsFor: (c, h) => byPair.get(`${c}|${h}`)?.forecasts ?? [],
    outcomesFor: (c, h) => {
      const p = byPair.get(`${c}|${h}`); if (!p) return []
      const out = []; for (const id of p.ids) { const o = outcomeById.get(id); if (o) out.push(o) }
      return out
    },
  })
  truth.set(costRtBps, t)
}
process.stderr.write('done\n\n')

// ── drive the real page ───────────────────────────────────────────────────
for (const theme of ['light', 'dark']) {
  const ctx = await browser.newContext({ colorScheme: theme, viewport: { width: 1280, height: 1000 } })
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[${theme}] ${m.text()}`) })
  page.on('pageerror', (e) => consoleErrors.push(`[${theme}] pageerror: ${e.message}`))
  await page.goto(pathToFileURL(join(HERE, 'check.html')).href)
  await page.waitForSelector('.cell[data-v]')

  for (const cost of CHECK_COSTS) {
    await page.evaluate((c) => {
      const el = document.getElementById('cost')
      el.value = String(c)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, cost)

    const shown = await page.evaluate(() => ({
      agents: [...document.querySelectorAll('.agent .amt')].map((el) => el.textContent.trim()),
      cost: Number(document.getElementById('cost').value),
      econ: Number(document.getElementById('t-econ').textContent),
      costly: Number(document.getElementById('t-costly').textContent),
      dead: Number(document.getElementById('t-dead').textContent),
      cells: [...document.querySelectorAll('.cell')].map((b) => ({
        cohort: b.dataset.c, horizonHours: Number(b.dataset.h),
        verdict: b.dataset.v, net: b.querySelector('.v').textContent.trim(),
      })),
    }))

    const t = truth.get(cost)
    const eq = (what, a, b) => { if (a !== b) failures.push(`[${theme}] cost ${cost}: ${what} — page ${a}, engine ${b}`) }

    // the money panel gets the same treatment as the verdicts: recompute from
    // the engine and demand the DOM agree, so the headline dollar figures
    // cannot drift from the arithmetic that produced them
    const live = agents({
      pairs: t.results.filter((r) => r.prior).map((r) => ({
        cohort: r.provenance.cohort, horizonHours: r.provenance.horizonHours,
        excessMeanBps: r.detail.excessMeanBps, sdBps: r.prior.sdBps,
        standardErrorBps: r.prior.standardErrorBps, pValue: r.prior.pValue,
      })),
      costRtBps: cost, adjustedAlpha: t.results[0].provenance.adjustedAlpha,
    })
    eq('ungated $/yr', shown.agents[0], usd(live.ungated.perYearUsd))
    eq('gated $/yr', shown.agents[1], usd(live.gated.perYearUsd))
    eq('sized $/yr', shown.agents[2], usd(live.sized.perYearUsd))
    eq('economic count', shown.econ, t.summary.economic)
    eq('fail-economic count', shown.costly, t.summary.realButCostly)
    eq('fail-signal count', shown.dead, t.summary.failedSignal)
    for (const c of shown.cells) {
      const r = t.results.find((x) => x.provenance.cohort === c.cohort && x.provenance.horizonHours === c.horizonHours)
      eq(`${c.cohort}@${c.horizonHours}h verdict`, c.verdict, r.verdict)
      const want = r.prior ? (r.prior.netMeanBps > 0 ? '+' : '') + r.prior.netMeanBps.toFixed(1) : '—'
      eq(`${c.cohort}@${c.horizonHours}h net`, c.net, want)
    }
  }

  // the first frame AT REST. Navigate to the BARE url, not reload(): the page
  // writes its frame into the query string, so a reload reproduces the last
  // frame the checks drove it to rather than the default a new reader lands on.
  await page.goto(pathToFileURL(join(HERE, 'check.html')).href)
  await page.waitForSelector('.cell[data-v]')
  const restCost = await page.evaluate(() => Number(document.getElementById('cost').value))
  if (restCost !== 60) failures.push(`[${theme}] at rest the page opens at ${restCost} bps, expected 60 — the frame a new reader lands on must show all three verdict columns populated`)
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(HERE, `../.verify-check-${theme}.png`), fullPage: true })

  // and one frame deep in the priced-out regime, where the middle verdict is
  // doing the work — a colour nobody ever sees is a colour nobody checked
  await page.evaluate(() => {
    const el = document.getElementById('cost'); el.value = '90'
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const pricedOut = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.cell')].find((x) => x.dataset.v === 'fail-economic')
    if (!b) return null
    b.click()
    return document.getElementById('detail-reading').textContent
  })
  if (!pricedOut) failures.push(`[${theme}] no fail-economic cell at 90 bps — the middle verdict never renders`)
  else if (!pricedOut.includes('THE SIGNAL IS REAL AND THE TRADE IS NOT')) {
    failures.push(`[${theme}] the fail-economic reading lost its headline: ${pricedOut.slice(0, 80)}`)
  }
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(HERE, `../.verify-check-${theme}-90bps.png`), fullPage: true })

  // URL state round-trip: a frame must be sendable, which means the query string
  // has to restore the exact frame it recorded
  await page.goto(pathToFileURL(join(HERE, 'check.html')).href + '?cost=90&cohort=Fund&h=168')
  await page.waitForSelector('.cell[data-v]')
  const restored = await page.evaluate(() => ({
    cost: Number(document.getElementById('cost').value),
    pressed: document.querySelector('.cell[aria-pressed="true"]')?.dataset,
  }))
  if (restored.cost !== 90) failures.push(`[${theme}] url cost=90 restored as ${restored.cost}`)
  if (restored.pressed?.c !== 'Fund' || Number(restored.pressed?.h) !== 168) {
    failures.push(`[${theme}] url cohort/horizon did not restore: got ${JSON.stringify(restored.pressed)}`)
  }

  // phone width: the page must not scroll sideways
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(250)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  if (overflow > 1) failures.push(`[${theme}] page scrolls horizontally at 390px by ${overflow}px`)
  await page.screenshot({ path: join(HERE, `../.verify-check-${theme}-phone.png`), fullPage: true })

  await ctx.close()
}
await browser.close()

for (const e of consoleErrors) failures.push(e)

if (failures.length) {
  console.error(`\n${failures.length} MISMATCH${failures.length === 1 ? '' : 'ES'} between the page and the engine:\n`)
  for (const f of failures.slice(0, 40)) console.error('  ' + f)
  if (failures.length > 40) console.error(`  ... and ${failures.length - 40} more`)
  process.exit(1)
}

console.log(`BOTH PAGES MATCH: the study against verdicts.json, the check against the engine re-run from the fixtures; ${CHECK_COSTS.length} costs x 18 pairs x 2 themes each, verdicts, net bps and the money panel.`)
console.log('No console errors. No horizontal scroll at 390px.')
