/**
 * hl.test.mjs — the Hyperliquid sampler, end to end, against the mock venue.
 *
 * The world plants a liquidation wall on ETH and a smart-money-vs-crowd
 * divergence on HYPE; BTC is the balanced control. The instrument has to
 * recover both, spend exactly what the venue charged, ask for nothing twice
 * inside a sample hour, survive injected rate limits, keep a continuous tape
 * across overlapping lookbacks, and answer through the tools.
 */
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { NansenClient } from '../src/nansen.mjs'
import { Sampler, sampleIdFor, loadSamples, plan } from '../src/hl-sample.mjs'
import { derive, loadSeries, loadTape } from '../src/hl-derive.mjs'
import { callHlTool, HL_TOOLS } from '../src/hl-tools.mjs'
import { makeHlWorld, startHlMock, MOCK_NOW_ISO } from './mock-hl.mjs'

let checks = 0, failed = 0
const check = (name, ok, detail = '') => { checks++; if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`) }
const run = (args, env = {}) => new Promise((resolve) => { const p = spawn(process.execPath, args, { env: { ...process.env, ...env } }); let out = ''; p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { out += d }); p.on('close', (code) => resolve({ code, out })) })

const KEY = 'mock-key-12345678'
const NOW = Date.parse(MOCK_NOW_ISO)
const SAMPLE = sampleIdFor(NOW) // 2026-09-20T04

// ── the CLI refuses without a key; a dry run needs none and makes no call
{
  const noKey = await run(['src/hl-sample.mjs', '--pass', 'screener', '--ledger', mkdtempSync(join(tmpdir(), 'hl-'))], { NANSEN_API_KEY: '' })
  check('cli: refuses to construct without NANSEN_API_KEY', noKey.code === 2 && /NANSEN_API_KEY is not set/.test(noKey.out))
  const dry = await run(['src/hl-sample.mjs', '--dry-run', '--pass', 'all', '--markets', '10', '--top-positions', '2000', '--per-day', '6'], { NANSEN_API_KEY: '' })
  check('cli: dry run prints the arithmetic and the assumptions', dry.code === 0 && /per run/.test(dry.out) && /assumed until the probe/.test(dry.out) && /per day at 6 runs\/day/.test(dry.out))
  const p = plan({ pass: 'positions', markets: 10, topPositions: 2000 })
  check('plan: positions pass for 10 markets is 1 screener + 10 × 6 position calls', p.calls === 61, `got ${p.calls}`)
}

// ── the world and the venue
const world = makeHlWorld()
const mock = await startHlMock({ world, balance: 100_000 })
const ledger = mkdtempSync(join(tmpdir(), 'hl-'))
const client = new NansenClient({ apiKey: KEY, creditBudget: 5000, baseUrl: mock.url, tier: 'pro' })
const s = new Sampler({ client, ledgerDir: ledger, sampleId: SAMPLE, intervalHours: 1 })

// ── screener pass
const scr = await s.screener()
check('screener: four trader types, twenty markets each', Object.keys(scr).length === 4 && Object.values(scr).every((rows) => rows.length === 20), JSON.stringify(Object.fromEntries(Object.entries(scr).map(([k, v]) => [k, v.length]))))
check('screener: four calls, four credits', s.calls === 4 && client.spent === 4 && mock.state.balance === 100_000 - 4, `calls ${s.calls} spent ${client.spent} balance ${mock.state.balance}`)

// ── the ranking reuses the kept page
const ranked = await s.rankMarkets({ n: 3 })
check('rank: top three by open interest are BTC, ETH, HYPE', ranked.map((r) => r.market).join(',') === 'BTC,ETH,HYPE', ranked.map((r) => r.market).join(','))
check('rank: the all-traders page was reused, not re-bought', s.calls === 4 && s.reused === 1)

// ── positions pass
const before = mock.state.balance
const pos = await s.positions({ markets: ['BTC', 'ETH', 'HYPE'], topPositions: 2000 })
const expectedCalls = 5 + 5 + 4 // BTC: 2 capped all-traders pages + sm + whale + pf; ETH: 2 pages (1200) + 3; HYPE: 1 page (800) + 3
check('positions: the expected fourteen calls', s.calls === 4 + expectedCalls, `calls ${s.calls}`)
check('positions: BTC all-traders capped at two pages and marked truncated', pos.BTC.all_traders.pages === 2 && pos.BTC.all_traders.positions === 2000 && pos.BTC.all_traders.truncated === true, JSON.stringify(pos.BTC.all_traders))
check('positions: ETH all-traders complete in two pages', pos.ETH.all_traders.pages === 2 && pos.ETH.all_traders.positions === 1200 && pos.ETH.all_traders.truncated === false)
check('positions: spent what the venue charged', client.spent === 4 + expectedCalls * 5 && before - mock.state.balance === expectedCalls * 5, `spent ${client.spent}`)
const raw = readdirSync(join(ledger, 'raw', SAMPLE))
check('ledger: one gzipped raw page per call', raw.length === 4 + expectedCalls, `${raw.length} files`)
const rows1 = loadSamples(ledger).all
check('ledger: one row per call with request ids and credits', rows1.length === 4 + expectedCalls && rows1.every((r) => r.requestId && r.credits.used !== null))

// ── resume: the same sample hour asks for nothing twice
const s2 = new Sampler({ client, ledgerDir: ledger, sampleId: SAMPLE, intervalHours: 1 })
const spentBefore = client.spent
await s2.screener(); await s2.positions({ markets: ['BTC', 'ETH', 'HYPE'], topPositions: 2000 })
check('resume: re-running the sample hour makes zero calls and spends nothing', s2.calls === 0 && s2.reused === 4 + expectedCalls && client.spent === spentBefore, `calls ${s2.calls} reused ${s2.reused}`)

// ── the tape, twice with overlap
await s.tape({ lookbackHours: 2 })
const s3 = new Sampler({ client, ledgerDir: ledger, sampleId: sampleIdFor(NOW + 3_600_000), intervalHours: 1 })
await s3.tape({ lookbackHours: 2 })
check('tape: two overlapping pulls made', s3.calls >= 1)

// ── derive
const d = derive({ ledgerDir: ledger })
const series = loadSeries(ledger)
check('derive: a positions row for each of the three markets and a screener row for the other seventeen', series.filter((r) => r.kind === 'positions').length === 3 && series.filter((r) => r.kind === 'screener').length === 17, `${series.length} rows`)
const eth = series.find((r) => r.market === 'ETH'), btc = series.find((r) => r.market === 'BTC'), hype = series.find((r) => r.market === 'HYPE')
const ethTruth = world.markets.get('ETH').truth
check('wall: ETH long notional within 5% below the mark equals the planted wall share', Math.abs(eth.liq.below.w5 - ethTruth.wallShareOfMappedLongs) < 0.01, `w5 ${eth.liq.below.w5} (planted ${ethTruth.wallShareOfMappedLongs.toFixed(3)})`)
check('wall: the wall sits between −4% and −3%: within-5% minus within-3% is the whole of it', eth.liq.below.w5 - eth.liq.below.w3 > ethTruth.wallShareOfMappedLongs - 0.02, `w5−w3 ${(eth.liq.below.w5 - eth.liq.below.w3).toFixed(3)}`)
check('wall: ETH heaviest band below is inside −4%..−3% and holds at least a third of the wall', eth.liq.below.largest && eth.liq.below.largest.from >= -0.04 && eth.liq.below.largest.to <= -0.03 && eth.liq.below.largest.share >= ethTruth.wallShareOfMappedLongs / 3, JSON.stringify(eth.liq.below.largest))
check('wall: the wall is held by unlabelled wallets, not smart money', eth.liq.below.largest.byCohort.other > 5 * (eth.liq.below.largest.byCohort.smart_money + 1))
check('control: BTC has no such band — within 5% is under a tenth', btc.liq.below.w5 < 0.1, `w5 ${btc.liq.below.w5}`)
check('crowding: HYPE smart money short, the rest long, divergence strongly negative', hype.smSkew <= -0.6 && hype.crowdSkew >= 0.35 && hype.divergence <= -1.0, `sm ${hype.smSkew} crowd ${hype.crowdSkew} div ${hype.divergence}`)
check('crowding: BTC is balanced', Math.abs(btc.divergence) < 0.3, `div ${btc.divergence}`)
check('crowding: HYPE funding is the elevated one', hype.funding > btc.funding * 10 && hype.fundingAnnualised > 3)
check('crowding: the smart-money skew comes from the venue\'s full book, matching the world', Math.abs(hype.smSkew - ((ethTruth.sm.longsUsd * 0 + world.markets.get('HYPE').truth.sm.longsUsd - world.markets.get('HYPE').truth.sm.shortsUsd) / (world.markets.get('HYPE').truth.sm.longsUsd + world.markets.get('HYPE').truth.sm.shortsUsd))) < 1e-3)
// coverage: BTC captured = top-2000 by notional ∪ labelled positions, over both sides
{
  const ps = world.markets.get('BTC').positions
  const top = new Set(ps.slice(0, 2000).map((p) => `${p.address}|${p.side}`))
  for (const p of ps) if (p.cohort !== 'other') top.add(`${p.address}|${p.side}`)
  const captured = ps.filter((p) => top.has(`${p.address}|${p.side}`)).reduce((a, p) => a + p.position_value_usd, 0)
  const truthCov = captured / (world.markets.get('BTC').truth.L + world.markets.get('BTC').truth.S)
  check('coverage: BTC map coverage equals the captured share of the world\'s two-sided book', Math.abs(btc.coverage - truthCov) < 2e-3, `derived ${btc.coverage} truth ${truthCov.toFixed(4)}`)
  check('coverage: the capped pull still carries most of the notional', btc.coverage > 0.85)
}
check('unmapped: positions without a liquidation price are counted as unmapped, near the planted 3%', eth.liq.below.unmappedShare > 0.005 && eth.liq.below.unmappedShare < 0.08, `${eth.liq.below.unmappedShare}`)
// the tape
const tape = loadTape(ledger)
check('tape: de-duplicated across the overlapping pulls to the world\'s unique trades in the window', tape.length === world.uniqueTradesWithin(2), `${tape.length} vs ${world.uniqueTradesWithin(2)}`)
// idempotence
const d2 = derive({ ledgerDir: ledger })
check('derive: a second run adds nothing', d2.newRows === 0 && d2.newTrades === 0 && loadSeries(ledger).length === series.length)
check('latest: three markets with maps, twenty with rows', Object.values(d.latest.markets).filter((m) => m.kind === 'positions').length === 3 && Object.keys(d.latest.markets).length === 20)

// ── the tools
{
  const st = callHlTool('hl_status', { nowIso: MOCK_NOW_ISO }, ledger)
  check('hl_status: names the sample hours and their ages', st.asOf.positions === SAMPLE && st.ageHours.positions === 0.5 && st.withPositions.length === 3, JSON.stringify(st.ageHours))
  const map = callHlTool('hl_liquidation_map', { market: 'ETH', nowIso: MOCK_NOW_ISO }, ledger)
  check('hl_liquidation_map: the ETH wall is the heaviest band below', map.long.largest.from >= -0.04 && map.long.largest.to <= -0.03 && map.long.heaviestBins.length > 0 && /heaviest half-percent band sits at -[34]\.\d% to -3\.\d%/.test(map.read[0]), map.read[0])
  const cr = callHlTool('hl_crowding', { market: 'HYPE', nowIso: MOCK_NOW_ISO }, ledger)
  check('hl_crowding: HYPE reads as the short-side carry setup', cr.divergence <= -1.0 && typeof cr.carrySetup === 'string' && /short side/.test(cr.carrySetup), cr.carrySetup)
  const all = callHlTool('hl_crowding', { nowIso: MOCK_NOW_ISO }, ledger)
  check('hl_crowding (all): HYPE ranks first by divergence; one carry setup', all.markets[0].market === 'HYPE' && all.carrySetups.length === 1)
  const refuse = callHlTool('hl_liquidation_map', { market: 'M3', nowIso: MOCK_NOW_ISO }, ledger)
  check('hl_liquidation_map: a screener-only market is refused as absence, not an empty map', refuse.refused === true && /outside the top-N/.test(refuse.reason))
  const tp = callHlTool('hl_smart_money_tape', { hours: 2, nowIso: MOCK_NOW_ISO }, ledger)
  check('hl_smart_money_tape: aggregates the window\'s trades', tp.tradesInWindow === world.uniqueTradesWithin(2) && tp.markets.length > 0 && tp.latest.length <= 20, `${tp.tradesInWindow}`)
  const se = callHlTool('hl_series', { market: 'HYPE', metric: 'divergence', hours: 24, nowIso: MOCK_NOW_ISO }, ledger)
  check('hl_series: one point for HYPE divergence', se.count === 1 && se.points[0].value === hype.divergence)
  const none = callHlTool('hl_status', {}, mkdtempSync(join(tmpdir(), 'hl-empty-')))
  check('tools: an absent ledger is refused as absence', none.refused === true && /ABSENCE/.test(none.reason))
  check('tools: six tools declared with schemas (five readers and hl_refresh)', HL_TOOLS.length === 6 && HL_TOOLS.every((t) => t.inputSchema?.type === 'object') && HL_TOOLS.some((t) => t.name === 'hl_refresh'))
  // derive now also reports the account and a compact recent history
  const lt = JSON.parse(readFileSync(join(ledger, 'derived', 'latest.json'), 'utf8'))
  check('derive: latest.json reports the credits the venue last reported', lt.credits && Number.isFinite(lt.credits.remaining) && Number.isFinite(lt.credits.spentLast24h), JSON.stringify(lt.credits))
  const rc = JSON.parse(readFileSync(join(ledger, 'derived', 'recent.json'), 'utf8'))
  check('derive: recent.json holds a point per positions sample for each pulled market', rc.kind === 'assay-hl-recent' && Object.keys(rc.markets).length > 0 && Object.values(rc.markets).every((pts) => pts.every((p) => 'divergence' in p && 'liqBelow5' in p)), Object.keys(rc.markets ?? {}).join(','))
}
await mock.close()

// ── rate limits: the pass completes, the log shows the waits, the spend still matches the venue
{
  const m2 = await startHlMock({ world, balance: 10_000, rateLimitEvery: 5 })
  const led2 = mkdtempSync(join(tmpdir(), 'hl-'))
  const c2 = new NansenClient({ apiKey: KEY, creditBudget: 5000, baseUrl: m2.url, tier: 'pro', sleep: () => Promise.resolve() })
  const s4 = new Sampler({ client: c2, ledgerDir: led2, sampleId: SAMPLE, intervalHours: 1 })
  await s4.screener()
  await s4.positions({ markets: ['HYPE'], topPositions: 1000 })
  const limited = c2.log.filter((r) => r.state === 'rate-limited').length
  check('rate limits: injected 429s were waited out and every page still arrived', limited >= 1 && s4.calls === 4 + 4 && c2.spent === 10_000 - m2.state.balance, `limited ${limited} calls ${s4.calls} spent ${c2.spent} venue ${10_000 - m2.state.balance}`)
  await m2.close()
}

// ── budget: a small budget stops the pass with the ledger intact
{
  const m3 = await startHlMock({ world, balance: 10_000 })
  const led3 = mkdtempSync(join(tmpdir(), 'hl-'))
  const c3 = new NansenClient({ apiKey: KEY, creditBudget: 12, baseUrl: m3.url, tier: 'pro' })
  const s5 = new Sampler({ client: c3, ledgerDir: led3, sampleId: SAMPLE, intervalHours: 1 })
  let stopped = null
  try { await s5.screener(); await s5.positions({ markets: ['BTC'], topPositions: 1000 }) } catch (e) { stopped = e }
  check('budget: the client refuses past the budget and the rows already answered are on the ledger', stopped?.constructor?.name === 'BudgetExhausted' && loadSamples(led3).all.length === 5 && c3.spent === 9, `spent ${c3.spent} rows ${loadSamples(led3).all.length}`)
  await m3.close()
}

console.log(`\n  ${checks} checks, ${failed} failed`)
process.exit(failed ? 1 : 0)
