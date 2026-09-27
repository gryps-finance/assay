/**
 * audit-convention.test.mjs — the audit must recover a planted convention.
 *
 * A synthetic ledger where the truth is known: weekly one-call rows are the
 * inclusive 7-day sum with 2% noise; monthly rows are the sum of the last
 * three days only (a silently capped range); the naive row is the mean of the
 * dailies. The audit has to name each of those
 * as the best rebuild, reproduce the pair counts, and read a near-zero lag-1
 * autocorrelation on an iid daily series.
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLedger, audit } from '../src/audit-convention.mjs'
import { HISTORICAL_SEGMENTS } from '../src/nansen.mjs'

let seed = 7
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const normal = () => { const u = Math.max(rnd(), 1e-12), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) }

const DAY = 86_400_000
const iso = (ms) => new Date(ms).toISOString().slice(0, 10)
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`)
const FROM = '2025-03-11', TO = '2025-05-19' // 70 days → 10 weekly windows, 3 monthly windows
const tokens = [
  { chain: 'ethereum', symbol: 'AAA', address: '0xaaa' },
  { chain: 'solana', symbol: 'BBB', address: 'bbb' },
  { chain: 'base', symbol: 'CCC', address: '0xccc' },
]
const scale = { whale: 2e6, public_figure: 4e5, top_pnl: 3e6, smart_trader: 6e5, exchange: 8e5, fresh_wallets: 5e6 }

const rows = []
const push = (arm, t, w, segments) => rows.push({ key: `${arm}|${t.chain}|${t.address}|${w.fromDate}|${w.toDate}`, arm, chain: t.chain, symbol: t.symbol, address: t.address, window: w, state: 'ok', segments })
const dailyOf = new Map()
for (const t of tokens) {
  const series = new Map()
  for (let ms = dayMs(FROM); ms <= dayMs(TO); ms += DAY) {
    const segments = {}
    for (const s of HISTORICAL_SEGMENTS) segments[s] = { netFlowUsd: normal() * scale[s] + (s === 'fresh_wallets' ? 4e6 : 0), avgFlowUsd: null, walletCount: null }
    series.set(iso(ms), segments)
    push('daily', t, { fromDate: iso(ms), toDate: iso(ms) }, segments)
  }
  dailyOf.set(t, series)
}
const sumOver = (series, from, to, s) => { let x = 0; for (let ms = dayMs(from); ms <= dayMs(to); ms += DAY) x += series.get(iso(ms))[s].netFlowUsd; return x }
const daysIn = (from, to) => Math.round((dayMs(to) - dayMs(from)) / DAY) + 1
let weeklyWindows = 0
for (const t of tokens) {
  const series = dailyOf.get(t)
  // weekly: inclusive sum with 2% noise
  for (let ms = dayMs(FROM); ms <= dayMs(TO); ms += 7 * DAY) {
    const w = { fromDate: iso(ms), toDate: iso(Math.min(ms + 6 * DAY, dayMs(TO))) }
    const segments = {}
    for (const s of HISTORICAL_SEGMENTS) segments[s] = { netFlowUsd: sumOver(series, w.fromDate, w.toDate, s) * (1 + 0.02 * normal()) }
    push('weekly', t, w, segments)
    if (t === tokens[0]) weeklyWindows++
  }
  // monthly: the range silently capped to the last THREE days
  let ms = dayMs(FROM)
  while (ms <= dayMs(TO)) {
    const d = new Date(ms)
    const end = Math.min(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0), dayMs(TO))
    const w = { fromDate: iso(ms), toDate: iso(end) }
    const segments = {}
    for (const s of HISTORICAL_SEGMENTS) segments[s] = { netFlowUsd: sumOver(series, iso(end - 2 * DAY), w.toDate, s) }
    push('monthly', t, w, segments)
    ms = end + DAY
  }
  // naive: the mean of the dailies
  const segments = {}
  for (const s of HISTORICAL_SEGMENTS) segments[s] = { netFlowUsd: sumOver(series, FROM, TO, s) / daysIn(FROM, TO) }
  push('naive', t, { fromDate: FROM, toDate: TO }, segments)
}

const dir = mkdtempSync(join(tmpdir(), 'audit-'))
mkdirSync(join(dir, 'study'))
writeFileSync(join(dir, 'study', 'calls.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')

let checks = 0, failed = 0
const check = (name, ok, detail = '') => { checks++; if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`) }

const result = audit(loadLedger(join(dir, 'study')))
for (const s of HISTORICAL_SEGMENTS) {
  const w = result.arms.weekly.segments[s]
  check(`weekly ${s}: best rebuild is inclusive, MATCH`, w.best?.rebuild === 'inclusive' && w.best.verdict === 'MATCH', `got ${w.best?.rebuild} ${w.best?.verdict} within ${(w.best?.within * 100).toFixed(1)}%`)
  check(`weekly ${s}: median relW under 5%`, w.best?.medianRelW < 0.05)
  check(`weekly ${s}: trail-6 does NOT match`, w.rebuilds['trail-6'].within < 0.5, `within ${(w.rebuilds['trail-6'].within * 100).toFixed(1)}%`)
  check(`weekly ${s}: pairs = ${weeklyWindows * tokens.length}`, w.reportStyle.pairs === weeklyWindows * tokens.length, `got ${w.reportStyle.pairs}`)
  check(`weekly ${s}: inclusive sign-agreement above 95%`, w.rebuilds.inclusive.signAgree.rate > 0.95, `${(w.rebuilds.inclusive.signAgree.rate * 100).toFixed(1)}% of ${w.rebuilds.inclusive.signAgree.n}`)
  check(`weekly ${s}: inclusive spearman above 0.95`, w.rebuilds.inclusive.spearman > 0.95, w.rebuilds.inclusive.spearman?.toFixed(3))
  check(`weekly ${s}: to-exclusive is clearly worse`, w.rebuilds['to-exclusive'].relW.median > 0.05)
  const m = result.arms.monthly.segments[s]
  check(`monthly ${s}: best rebuild is trail-3, exact MATCH`, m.best?.rebuild === 'trail-3' && m.best.verdict === 'MATCH' && m.best.medianRelW < 1e-9, `got ${m.best?.rebuild} ${m.best?.verdict} @ ${m.best?.medianRelW}`)
  check(`monthly ${s}: inclusive is NO MATCH`, m.rebuilds.inclusive.within < 0.5)
  const n = result.arms.naive.segments[s]
  check(`naive ${s}: best rebuild is mean-daily, MATCH`, n.best?.rebuild === 'mean-daily' && n.best.verdict === 'MATCH' && n.best.medianRelW < 1e-9, `got ${n.best?.rebuild} ${n.best?.verdict} @ ${n.best?.medianRelW}`)
  check(`lag-1 ${s}: iid dailies read near zero`, Math.abs(result.lag1[s].medianAcrossTokens) < 0.3, result.lag1[s].medianAcrossTokens?.toFixed(3))
}
check('report-style ratio on weekly inclusive is the planted 2% noise, roughly', HISTORICAL_SEGMENTS.every((s) => { const r = result.arms.weekly.segments[s].reportStyle.relativeMove; return r > 0.005 && r < 0.05 }))

console.log(`\n  ${checks} checks, ${failed} failed`)
process.exit(failed ? 1 : 0)
