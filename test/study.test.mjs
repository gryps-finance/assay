/**
 * THE LIVE PATH, END TO END, WITHOUT A KEY.
 *
 * A mock Nansen serves the documented contract over a world with a planted
 * edge (smart_trader), a planted negative control (exchange), and a planted
 * label-resolution leak on every multi-day window. The study runs against it
 * exactly as it will run against the venue — same client, same runner, same
 * scorer — and the checks are the ones that matter on the real run:
 *
 *   · resolution excludes a wrong address and counts it
 *   · the window convention is DETERMINED (inclusive here) and recorded
 *   · every arm's calls land on the ledger keyed, with request ids and credits
 *   · a budget stop leaves a resumable ledger; the restart spends nothing twice
 *   · the planted edge is recovered as real; the negative control is not
 *   · the leak is measured: the one-call weekly arm manufactures edge that the
 *     summed-daily arm, over the same windows, does not have
 *   · a renamed field upstream is a counted absence, never a quiet zero
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import { startMock, makeWorld } from './mock-nansen.mjs'
import { scoreStudy } from '../src/score-study.mjs'
import { windowsFor, plan } from '../src/study.mjs'
import { UNIVERSE } from '../src/universe.mjs'

let pass = 0, fail = 0
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) } }
const readJsonl = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : [])

const KEY = 'mock-key-12345678'
const TOKENS = 'WETH,LINK,SOL,UNI,JUP,CAKE'
const FROM = '2026-01-01'
const TO = '2026-06-30'

/** async, because the mock lives in THIS process and a synchronous spawn would starve it of its own event loop */
function runStudy({ url, ledger, budget = 20000, extra = [] }) {
  return new Promise((resolve) => {
    // argOf takes the FIRST occurrence of a flag, so `extra` goes first to override the defaults
    const defaults = ['--base-url', url, '--ledger', ledger, '--tokens', TOKENS, '--from', FROM, '--to', TO, '--budget', String(budget), '--reserve', '50']
    const child = spawn(process.execPath, ['src/study.mjs', ...extra, ...defaults], { env: { ...process.env, NANSEN_API_KEY: KEY } })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (status) => resolve({ status, out }))
  })
}

console.log('\nwindows and the plan')
{
  check('daily windows are one per day, inclusive of both ends', windowsFor('daily', '2026-03-01', '2026-03-03').length === 3)
  const wk = windowsFor('weekly', '2026-03-01', '2026-03-20')
  check('weekly windows are 7 days with a short last one', wk.length === 3 && wk[0].toDate === '2026-03-07' && wk[2].fromDate === '2026-03-15' && wk[2].toDate === '2026-03-20')
  const mo = windowsFor('monthly', '2025-03-11', '2025-05-10')
  check('monthly windows are calendar months, partial at both ends', mo.length === 3 && mo[0].toDate === '2025-03-31' && mo[1].fromDate === '2025-04-01' && mo[2].toDate === '2025-05-10')
  const p = plan({ universe: UNIVERSE, arms: ['naive', 'monthly', 'weekly', 'daily'], fromDate: '2025-03-11', toDate: '2026-09-01' })
  check('the full study is ~14,000 calls and ~70,000 credits — not the prereg\'s 5,000', p.calls > 13_000 && p.credits > 65_000 && p.credits < 80_000, `${p.calls} calls, ${p.credits} credits`)
}

console.log('\nthe live path against the mock')
const world = makeWorld({ wrongSymbolFor: ['CAKE'] })
const mock = await startMock({ world, balance: 100_000, rateLimitEvery: 37 })
const ledger = mkdtempSync(join(tmpdir(), 'assay-study-'))
try {
  // 1. a budget too small to finish: the run stops on budget, cleanly, with everything so far on the ledger
  const small = await runStudy({ url: mock.url, ledger, budget: 600, extra: ['--arms', 'naive,monthly,weekly,daily', '--allow-partial'] })
  check('a budget stop exits 3 and says so', small.status === 3 && /STOPPED ON BUDGET/.test(small.out), small.out.slice(-600))
  const callsAfterStop = readJsonl(join(ledger, 'calls.jsonl'))
  const mockCallsAfterStop = mock.state.calls
  check('the stopped run left keyed rows on the ledger', callsAfterStop.length > 0 && callsAfterStop.every((c) => typeof c.key === 'string' && c.requestId))

  // 2. resume with a real budget: completes; nothing answered before is asked again
  const full = await runStudy({ url: mock.url, ledger, budget: 20000, extra: ['--arms', 'naive,monthly,weekly,daily'] })
  check('the resumed run completes', full.status === 0 && /complete:/.test(full.out), full.out.slice(-800))
  const calls = readJsonl(join(ledger, 'calls.jsonl'))
  const okKeys = new Set(calls.filter((c) => c.state === 'ok').map((c) => c.key))
  const dupes = [...mock.state.keys.entries()].filter(([, n]) => n > 1)
  check('no flow window was asked of the venue twice across stop + resume', dupes.length === 0, `${dupes.length} duplicated: ${dupes.slice(0, 3).map(([k]) => k).join(', ')}`)
  const univ = JSON.parse(readFileSync(join(ledger, 'universe-resolved.json'), 'utf8'))
  check('resolution: five included, the wrong address EXCLUDED and counted', univ.included.length === 5 && univ.excluded.length === 1 && univ.excluded[0].symbol === 'CAKE' && /EXCLUDED, not substituted/.test(univ.excluded[0].why))
  const conv = JSON.parse(readFileSync(join(ledger, 'convention-probe.json'), 'utf8'))
  check('the window convention is determined as inclusive, with its numbers beside it', conv.verdict === 'inclusive' && conv.scores.meanInclusiveErr < conv.scores.meanExclusiveErr)
  const tapes = readdirSync(join(ledger, 'ohlcv')).filter((f) => f.endsWith('.json.gz'))
  check('one gzipped tape per included token, hourly, covering the padded range', tapes.length === 5 && tapes.every((f) => { const t = JSON.parse(gunzipSync(readFileSync(join(ledger, 'ohlcv', f))).toString('utf8')); return t.candles.length >= (181 + 24) * 24 - 2 && t.refusals.length === 0 }))
  const expectDaily = 5 * windowsFor('daily', FROM, TO).length
  const expectWeekly = 5 * windowsFor('weekly', FROM, TO).length
  check('every daily and weekly window answered exactly once', [...okKeys].filter((k) => k.startsWith('daily|')).length === expectDaily && [...okKeys].filter((k) => k.startsWith('weekly|')).length === expectWeekly, `${[...okKeys].filter((k) => k.startsWith('daily|')).length}/${expectDaily} daily`)
  check('rate limits were met with waits, not failures', calls.every((c) => c.state !== 'http-error' || c.status !== 429) && mock.state.calls > 0)
  const spend = JSON.parse(readFileSync(join(ledger, 'spend-report.json'), 'utf8'))
  check('the spend report counts calls and carries the account\'s own remaining balance', spend.status === 'complete' && spend.calls > 0 && Number.isFinite(spend.accountRemaining) && spend.accountRemaining === mock.state.balance)
  check('credits: the ledger\'s per-call charge equals what the mock deducted', calls.filter((c) => c.state === 'ok').every((c) => c.credits.used === 5 && Number.isFinite(c.credits.remaining)))

  // 3. a second full run makes no flow or tape call at all
  const before = mock.state.calls
  const again = await runStudy({ url: mock.url, ledger, budget: 20000, extra: ['--arms', 'naive,monthly,weekly,daily'] })
  check('a re-run reads everything back: one free account probe, nothing else', again.status === 0 && mock.state.calls - before === 1, `${mock.state.calls - before} calls`)

  // 4. scoring: the planted answer is recovered, the control is not, the leak is measured
  const study = scoreStudy({ ledgerDir: ledger, costRtBps: 12, withSweep: true })
  const res = (arm, cohort, h) => study.arms[arm]?.results.find((r) => r.cohort === cohort && r.horizonHours === h)
  const st24 = res('daily', 'Smart Trader', 24)
  check('daily arm: the planted smart_trader edge is REAL at 24h', st24 && (st24.verdict === 'economic' || st24.verdict === 'fail-economic') && st24.excessMeanBps > 30, JSON.stringify(st24))
  const ex = ['Exchange'].flatMap((c) => [24, 48, 168].map((h) => res('daily', c, h)))
  check('daily arm: the negative control reads fail-signal at every horizon', ex.every((r) => r && r.verdict === 'fail-signal'), ex.map((r) => r?.verdict).join(','))
  check('daily arm: absent flows are counted, not filled', Object.values(study.arms.daily.nullFlowsBySegment).every((n) => n === 0) && study.arms.daily.rowsUsed === expectDaily)
  const lk = study.leak.weekly
  const lst = lk.verdict.find((v) => v.segment === 'smart_trader' && v.horizonHours === 48)
  check('leak (weekly): the one-call arm manufactures edge the summed-daily arm does not have', lst && lst.leakBps > 40 && lst.leakP !== null && lst.leakP < 0.05, JSON.stringify(lst))
  check('leak (weekly): the flow numbers move on the leaky segments and not on exchange', lk.flow.smart_trader.relativeMove > 0.05 && lk.flow.exchange.relativeMove < 1e-6, JSON.stringify({ st: lk.flow.smart_trader, ex: lk.flow.exchange }))
  check('leak (monthly): the flow numbers move on the leaky segments there too', study.leak.monthly.flow.smart_trader.relativeMove > 0.05 && study.leak.monthly.flow.exchange.relativeMove < 1e-6)
  check('the published verdicts are the daily arm, MCP-ready', existsSync(join(ledger, 'verdicts.json')) && JSON.parse(readFileSync(join(ledger, 'verdicts.json'), 'utf8')).arm === 'daily' && JSON.parse(readFileSync(join(ledger, 'verdicts.json'), 'utf8')).results.length === 18)
  const sweep = JSON.parse(readFileSync(join(ledger, 'sweep.json'), 'utf8'))
  check('the sweep has 101 frames, one fingerprint, and the segment names the page renders', sweep.frames.length === 101 && typeof sweep.signalFingerprint === 'string' && sweep.cohorts.includes('Smart Trader') && sweep.cohorts.length === 6)
} finally {
  await mock.close()
  rmSync(ledger, { recursive: true, force: true })
}

console.log('\nshape drift upstream')
{
  const mock2 = await startMock({ world: makeWorld(), balance: 50_000, renameField: 'smart_trader_net_flow_usd' })
  const led = mkdtempSync(join(tmpdir(), 'assay-drift-'))
  try {
    const r = await runStudy({ url: mock2.url, ledger: led, budget: 20000, extra: ['--arms', 'daily', '--tokens', 'WETH,LINK', '--from', '2026-04-01', '--to', '2026-04-20'] })
    check('a renamed field does not stop the run', r.status === 0, r.out.slice(-400))
    const calls = readJsonl(join(led, 'calls.jsonl')).filter((c) => c.arm === 'daily' && c.state === 'ok')
    check('every row names the field it could not find', calls.length > 0 && calls.every((c) => Array.isArray(c.missingFields) && c.missingFields.includes('smart_trader_net_flow_usd')))
    const study = scoreStudy({ ledgerDir: led, costRtBps: 12, withSweep: false })
    const st = study.arms.daily.results.filter((r) => r.cohort === 'Smart Trader')
    check('the drifted segment issues no verdict (insufficient), never a zero', st.every((r) => r.verdict === 'insufficient') && study.arms.daily.nullFlowsBySegment.smart_trader === calls.length)
    check('the other segments are unaffected', study.arms.daily.nullFlowsBySegment.exchange === 0)
  } finally {
    await mock2.close()
    rmSync(led, { recursive: true, force: true })
  }
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} ok, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
