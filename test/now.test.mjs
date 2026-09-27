/**
 * `assay now`, END TO END, WITHOUT A KEY.
 *
 * The mock serves the documented flow-summary contract. The priors are the REAL ones this repository ships
 * (ledger/study, the 12,781-call study), so the checks below are the ones a user sees on a live run:
 *
 *   · one call per token for one complete UTC day, charged as the venue reports, every request id kept
 *   · the study's own selection rules decide which flows are signals (checked against forecast-flow.mjs)
 *   · every signal carries the prior measured for its segment at each horizon, and a decision from it
 *   · the decision logic: trade (sized, capped), hold, skip, refuse — and the size of the flow never enters
 *   · the MCP server serves the pull through assay_signal_now, and refuses assay_now without a key
 *   · a dry run makes no call; no key, no client
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startMock, makeWorld } from './mock-nansen.mjs'
import { selectSignals, decide, attachPriors, priorFor, lastCompleteDay, loadUniverse } from '../src/now.mjs'
import { forecastsFromFlowSeries } from '../src/forecast-flow.mjs'
import { SEGMENT_LABEL } from '../src/nansen.mjs'

let pass = 0, fail = 0
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) } }
const KEY = 'mock-key-12345678'
const PRIORS = 'ledger/study'
const verdicts = JSON.parse(readFileSync(join(PRIORS, 'verdicts.json'), 'utf8'))

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/now.mjs', ...args], { env: { ...process.env, NANSEN_API_KEY: '', ...env } })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (status) => resolve({ status, out, err }))
  })
}

function mcp(requests, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/mcp-server.mjs'], { env: { ...process.env, NANSEN_API_KEY: '', ...env } })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('close', () => resolve(out.split('\n').filter(Boolean).map((l) => JSON.parse(l))))
    for (const r of requests) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...r }) + '\n')
    setTimeout(() => child.stdin.end(), 1500)
  })
}

// ── pure pieces ───────────────────────────────────────────────────────────────────────────────

check('lastCompleteDay is the UTC day before now', lastCompleteDay(Date.parse('2026-09-24T00:30:00Z')) === '2026-09-23' && lastCompleteDay(Date.parse('2026-09-24T23:59:00Z')) === '2026-09-23')

{
  // twelve tokens with whale flows, some tiny, some null: the study's rules decide
  const rows = Array.from({ length: 12 }, (_, i) => ({ symbol: `T${i}`, chain: 'ethereum', studied: true, segments: { whale: { netFlowUsd: i === 0 ? null : (i % 2 ? 1 : -1) * (100_000 + i * 90_000) } } }))
  const { signals, skipped } = selectSignals(rows)
  const whale = signals.filter((s) => s.segment === 'whale')
  const ff = forecastsFromFlowSeries({ segment: 'whale', rows: rows.map((r) => ({ symbol: r.symbol, chain: r.chain, windowEndDate: '2026-09-01', netFlowUsd: r.segments.whale.netFlowUsd, arm: 'daily', lookAheadBoundDays: 1 })), priceAt: () => 1 })
  const ffSubjects = [...new Set(ff.forecasts.map((f) => `${f.subject}:${f.direction}`))].sort()
  check('selection: the same tokens and directions the study formed claims from', JSON.stringify(whale.map((s) => `${s.subject}:${s.direction}`).sort()) === JSON.stringify(ffSubjects), `${whale.length} vs ${ffSubjects.length}`)
  check('selection: below $250k is housekeeping, null is absence, and at most ten per segment', whale.length === 10 && whale.every((s) => Math.abs(s.flowUsd) >= 250_000) && skipped.nullFlow >= 1 && skipped.belowThreshold >= 1)
}

{
  const econ = { verdict: 'economic', prior: { netMeanBps: 60, sdBps: 400, standardErrorBps: 10, n: 5000 } }
  const d = decide(econ, 12)
  check('decide: economic trades, sized on the standard error, never above the cap', d.action === 'trade' && d.fraction > 0 && d.fraction <= 0.25, JSON.stringify(d))
  check('decide: fail-economic holds (real, priced out) and does not size', decide({ verdict: 'fail-economic', prior: econ.prior }, 12).action === 'hold' && decide({ verdict: 'fail-economic', prior: econ.prior }, 12).fraction === 0)
  check('decide: fail-signal skips, and says it is not the reverse trade', /Not the reverse trade/.test(decide(priorFor(verdicts, 'Whale', 24), 12).why) && decide(priorFor(verdicts, 'Whale', 24), 12).action === 'skip')
  check('decide: an unmeasured pair is refused, never sized', decide(null, 12).action === 'refuse')
  const joined = attachPriors([{ segment: 'whale', cohort: 'Whale', subject: 'WETH', chain: 'ethereum', studied: true, direction: 'long', flowUsd: 9_000_000 }, { segment: 'whale', cohort: 'Whale', subject: 'X', chain: 'ethereum', studied: false, direction: 'long', flowUsd: 300_000 }], verdicts)
  check('priors: every signal carries all three measured horizons, and a bigger flow does not change the decision', joined[0].horizons.length === 3 && JSON.stringify(joined[0].horizons) === JSON.stringify(joined[1].horizons))
  check('priors: a token outside the measured universe is marked as an extrapolation', /extrapolation/.test(joined[1].note ?? '') && !joined[0].note)
}

{
  const dir = mkdtempSync(join(tmpdir(), 'uni-'))
  const f = join(dir, 'u.json')
  writeFileSync(f, JSON.stringify([{ chain: 'ethereum', symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' }, { chain: 'base', symbol: 'NEWT', address: '0x0000000000000000000000000000000000000001' }]))
  const u = loadUniverse({ priorsDir: PRIORS, universeFile: f })
  check('universe: a custom list loads, and each token says whether the study measured it', u.tokens.length === 2 && u.tokens[0].studied === true && u.tokens[1].studied === false)
  let threw = false
  try { writeFileSync(f, JSON.stringify([{ chain: 'sei', symbol: 'SEI', address: 'x' }])); loadUniverse({ priorsDir: PRIORS, universeFile: f }) } catch { threw = true }
  check('universe: a chain the flow summary does not cover is refused up front', threw)
}

// ── the CLI against the mock venue ───────────────────────────────────────────────────────────

const mock = await startMock({ world: makeWorld({ seed: 11 }) })
{
  const out = mkdtempSync(join(tmpdir(), 'now-'))
  const dry = await run(['--dry-run', '--priors', PRIORS, '--out', out, '--date', '2026-06-15'])
  check('dry run: no key needed, no call made', dry.status === 0 && mock.state.calls === 0 && /no call made/.test(dry.out))
  const nokey = await run(['--priors', PRIORS, '--out', out, '--date', '2026-06-15', '--base-url', mock.url])
  check('no key: refuses before any call', nokey.status === 2 && mock.state.calls === 0 && /NANSEN_API_KEY is not set/.test(nokey.err))

  const r = await run(['--priors', PRIORS, '--out', out, '--date', '2026-06-15', '--base-url', mock.url, '--budget', '200'], { NANSEN_API_KEY: KEY })
  const live = existsSync(join(out, 'live-signals.json')) ? JSON.parse(readFileSync(join(out, 'live-signals.json'), 'utf8')) : null
  check('live pull: exit 0, one call per token of the resolved universe (20)', r.status === 0 && mock.state.calls === 20, `${r.status} ${mock.state.calls} ${r.err}`)
  check('live pull: charged as the venue reported (5 credits a call)', live?.spend?.creditsSpent === 100, JSON.stringify(live?.spend))
  check('live pull: every call kept with its request id', readFileSync(join(out, 'calls.jsonl'), 'utf8').trim().split('\n').every((l) => /"requestId":"mock-\d+"/.test(l)))
  check('live pull: signals were formed, each with three horizons and a decision', live && live.signals.length > 0 && live.signals.every((s) => s.horizons.length === 3 && s.horizons.every((h) => ['trade', 'hold', 'skip', 'refuse'].includes(h.action))), `${live?.signals?.length}`)
  check('live pull: on the real priors every signal is skipped (18 of 18 pairs fail their control)', live && live.signals.every((s) => s.horizons.every((h) => h.verdict === 'fail-signal' && h.action === 'skip' && h.fraction === 0)))
  check('live pull: the headline counts what is tradeable and states the measured net', /0 tradeable/.test(live?.summary?.headline ?? '') && /measured net of/.test(live?.summary?.headline ?? ''), live?.summary?.headline)
  check('live pull: the table names each signal with its prior and decision', /ASSAY NOW/.test(r.out) && /fail-signal/.test(r.out) && /skip/.test(r.out) && /Powered by Nansen API/.test(r.out))
  check('live pull: segments are the six measured ones', live.signals.every((s) => Object.values(SEGMENT_LABEL).includes(s.cohort)))

  // the MCP server serves that pull, and will not pull without a key
  const cohort = live.signals[0].cohort
  const res = await mcp([
    { id: 1, method: 'initialize', params: {} },
    { id: 2, method: 'tools/list', params: {} },
    { id: 3, method: 'tools/call', params: { name: 'assay_signal_now', arguments: { cohort, horizonHours: 48 } } },
    { id: 4, method: 'tools/call', params: { name: 'assay_now', arguments: {} } },
    { id: 5, method: 'tools/call', params: { name: 'assay_prior', arguments: { cohort: 'Exchange', horizonHours: 24 } } },
  ], { ASSAY_LEDGER_DIR: PRIORS, ASSAY_LIVE_DIR: out })
  const byId = Object.fromEntries(res.map((m) => [m.id, m]))
  const names = (byId[2]?.result?.tools ?? []).map((t) => t.name)
  check('mcp: the live tools are listed beside the readers', ['assay_prior', 'assay_leaderboard', 'assay_signal_now', 'assay_now', 'assay_explain', 'assay_lookahead', 'hl_refresh', 'hl_crowding'].every((n) => names.includes(n)), names.join(','))
  const sn = byId[3] ? JSON.parse(byId[3].result.content[0].text) : null
  check('mcp: assay_signal_now serves the pull with each signal\'s decision at the asked horizon', sn && sn.count > 0 && sn.signals.every((s) => s.action === 'skip') && sn.verdict === 'fail-signal', JSON.stringify(sn)?.slice(0, 200))
  const an = byId[4] ? JSON.parse(byId[4].result.content[0].text) : null
  check('mcp: assay_now without a key is a refusal that says the priors still work', an?.refused === true && /need no key/.test(an.reason))
  const pr = byId[5] ? JSON.parse(byId[5].result.content[0].text) : null
  check('mcp: the negative control reads fail-signal from the shipped ledger', pr?.verdict === 'fail-signal' && pr?.n > 4000, JSON.stringify(pr)?.slice(0, 160))
}
await mock.close()

console.log(`\n  ${pass + fail} checks, ${fail} failed`)
process.exit(fail ? 1 : 0)
