#!/usr/bin/env node
/**
 * THE LIVE STUDY — PREREGISTRATION.md and its amendment, executed.
 *
 * What it does, in order, and each step is written down before the next runs:
 *
 *   0. account probe            free; proves the key works before anything is spent
 *   1. universe resolution      one call per token on a probe day; the venue's
 *                               token_symbol echo decides inclusion (universe.mjs)
 *   2. convention probe         three calls on one token: is a window's `to`
 *                               day inclusive? Determined, recorded, not assumed
 *   3. OHLCV backfill           1h candles, one call per token, truncation
 *                               refused and the range split until it is not
 *   4. the arms                 naive (1 call/token), monthly, weekly, DAILY —
 *                               the daily arm is the study; the others measure
 *                               what a longer window's label resolution costs
 *
 * THE ONE FACT THIS FILE IS BUILT AROUND (read from the endpoint's own page,
 * 2026-09-19): `historical-token-flow-summary` returns "a single aggregated
 * row per (token_address, date_to)". Not a row per day inside a range — one row
 * per call. So a daily signal is a daily call: 22 tokens × ~540 days ≈ 11,900
 * calls, about 59,000 credits. That is why the prereg's 5,000-credit budget
 * could never have produced the study it described, and why this runner did
 * not exist until the credits did.
 *
 * RESUMABLE, BY KEY. Every call has a key (arm|chain|address|window). Before a
 * call is made the ledger is checked; a call already answered `ok` is never
 * made again. Kill this at call 9,000 and restart it: it spends nothing twice.
 *
 * METERED, TWICE. The client refuses past `--budget` on its own tally, and
 * refuses when the account's own `X-Nansen-Credits-Remaining` would fall below
 * `--reserve`. The study never drains the account.
 *
 * THE KEY. `NANSEN_API_KEY`, from the environment of the host that runs this,
 * and nowhere else. It is not printed, not written, and redacted from every
 * error string. No key: no run, no partial run, no fetch.
 *
 *   node src/study.mjs --dry-run                                  # the plan and the arithmetic, no calls
 *   NANSEN_API_KEY=… node src/study.mjs --ledger ledger/study --budget 80000 --reserve 5000
 *   node src/study.mjs --ledger ledger/study --tokens WETH,SOL --from 2026-06-01 --to 2026-06-30 --arms daily,weekly
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { gzipSync, gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { NansenClient, BudgetExhausted, readFlowRow, HISTORICAL_SEGMENTS, CREDIT_COST } from './nansen.mjs'
import { UNIVERSE, resolveUniverse } from './universe.mjs'
import { SIGNAL_SPEC, specHash } from './forecast.mjs'

// ───────────────────────────────────────────────────────────── arguments

const args = process.argv.slice(2)
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const has = (k) => args.includes(k)

export const STUDY_DEFAULTS = Object.freeze({
  /** PREREGISTRATION.md §3: whale / public_figure / top_pnl / exchange coverage begins 2025-03-11 */
  fromDate: '2025-03-11',
  toDate: '2026-09-01',
  arms: ['naive', 'monthly', 'weekly', 'daily'],
  /** the price tape runs this many days past each end: controls draw ±3 days, the longest horizon is 7 */
  tapePadDays: 12,
  timeframe: '1h',
})

const LEDGER_DIR = process.env.ASSAY_LEDGER_DIR ?? argOf('--ledger', 'ledger/study')
const BUDGET = Number(argOf('--budget', '80000'))
const RESERVE = Number(argOf('--reserve', '5000'))
const FROM = argOf('--from', STUDY_DEFAULTS.fromDate)
const TO = argOf('--to', STUDY_DEFAULTS.toDate)
const ARMS = (argOf('--arms', STUDY_DEFAULTS.arms.join(',')) || '').split(',').map((s) => s.trim()).filter(Boolean)
const TOKENS = argOf('--tokens', null)
/** a study of YOUR tokens: a JSON list of { chain, symbol, address }. It is a different study from the shipped one: its
 *  universe is hashed into the manifest at the first call, so it is declared before any data exists, like the original. */
const UNIVERSE_FILE = argOf('--universe', null)
const BASE_URL = argOf('--base-url', process.env.NANSEN_BASE_URL ?? 'https://api.nansen.ai')
const TIER = argOf('--tier', process.env.NANSEN_TIER ?? 'free')
const DRY = has('--dry-run')
const RETRY_ERRORS = has('--retry-errors')
/** proceed when the budget cannot finish the plan: the run is resumable, so a partial run is a real option — but it has to be asked for */
const ALLOW_PARTIAL = has('--allow-partial')

const DAY = 86_400_000
const iso = (ms) => new Date(ms).toISOString().slice(0, 10)
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`)
const addDays = (d, n) => iso(dayMs(d) + n * DAY)
const say = (s) => console.log(s)

if (!Number.isFinite(dayMs(FROM)) || !Number.isFinite(dayMs(TO)) || dayMs(TO) < dayMs(FROM)) { console.error(`bad range --from ${FROM} --to ${TO}`); process.exit(2) }
for (const a of ARMS) if (!STUDY_DEFAULTS.arms.includes(a)) { console.error(`unknown arm '${a}' — arms are ${STUDY_DEFAULTS.arms.join(', ')}`); process.exit(2) }

// ───────────────────────────────────────────────────────────── the windows

/** every window an arm needs, as {fromDate, toDate} with `toDate` the LAST day inside the window (inclusive) */
export function windowsFor(arm, fromDate, toDate) {
  const a = dayMs(fromDate)
  const b = dayMs(toDate)
  const out = []
  if (arm === 'naive') return [{ fromDate, toDate }]
  if (arm === 'daily') { for (let t = a; t <= b; t += DAY) out.push({ fromDate: iso(t), toDate: iso(t) }); return out }
  if (arm === 'weekly') { for (let t = a; t <= b; t += 7 * DAY) out.push({ fromDate: iso(t), toDate: iso(Math.min(t + 6 * DAY, b)) }); return out }
  if (arm === 'monthly') {
    let t = a
    while (t <= b) {
      const d = new Date(t)
      const monthEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
      const end = Math.min(monthEnd, b)
      out.push({ fromDate: iso(t), toDate: iso(end) })
      t = end + DAY
    }
    return out
  }
  throw new Error(`no windows for arm ${arm}`)
}

/** the arithmetic, before a single call */
export function plan({ universe, arms, fromDate, toDate }) {
  const flowCost = CREDIT_COST['/api/v1beta1/tgm/historical-token-flow-summary']
  const ohlcvCost = CREDIT_COST['/api/v1beta1/tgm/historical-token-ohlcv']
  const n = universe.length
  const lines = []
  let calls = 0, credits = 0
  const add = (what, c, per) => { lines.push({ what, calls: c, credits: c * per }); calls += c; credits += c * per }
  add('universe resolution (one probe day per token)', n, flowCost)
  add('convention probe (one token, three calls)', 3, flowCost)
  add(`OHLCV 1h, one call per token (split only if truncated)`, n, ohlcvCost)
  for (const arm of arms) add(`arm: ${arm}`, n * windowsFor(arm, fromDate, toDate).length, flowCost)
  return { lines, calls, credits }
}

// ───────────────────────────────────────────────────────────── the ledger

function loadCalls(path) {
  const ok = new Map()
  const seen = new Map()
  if (!existsSync(path)) return { ok, seen }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let r
    try { r = JSON.parse(line) } catch { continue }
    if (!r.key) continue
    seen.set(r.key, r)
    if (r.state === 'ok') ok.set(r.key, r)
  }
  return { ok, seen }
}

const keyOf = (arm, t, w) => `${arm}|${t.chain}|${t.address}|${w.fromDate}|${w.toDate}`

/** one ledger row per answered window, whichever step asked for it */
function recordCall({ ledgerDir, arm, token: t, window: w, called, result: r, row }) {
  const raw = r.ok ? r.data.data?.[0] ?? null : null
  const rec = {
    key: keyOf(arm, t, w), arm, chain: t.chain, symbol: t.symbol, address: t.address,
    window: w, called: called ?? w, labelsResolvedAt: (called ?? w).toDate, lookAheadBoundDays: Math.round((dayMs(w.toDate) - dayMs(w.fromDate)) / DAY) + 1,
    atIso: new Date().toISOString(), state: r.ok && !raw ? 'empty' : r.state, requestId: r.headers?.requestId ?? null,
    credits: { cost: r.cost, used: r.headers?.creditsUsed ?? null, remaining: r.headers?.creditsRemaining ?? null },
    rows: r.ok ? (r.data.data?.length ?? 0) : 0,
    echoedSymbol: row?.tokenSymbol ?? null,
    missingFields: row?.missingFields ?? null,
    segments: row?.segments ?? null,
    raw,
    note: r.note ?? null,
  }
  appendFileSync(join(ledgerDir, 'calls.jsonl'), JSON.stringify(rec) + '\n')
  return rec
}

// ───────────────────────────────────────────────────────────── steps

async function conventionProbe({ client, token, ledgerDir, log, onDay = () => {} }) {
  const path = join(ledgerDir, 'convention-probe.json')
  if (existsSync(path)) { const p = JSON.parse(readFileSync(path, 'utf8')); log(`convention already probed: ${p.verdict} (read back)`); return p }
  // two consecutive days well inside coverage, and the two-day window over them
  const d1 = addDays(TO, -8)
  const d2 = addDays(TO, -7)
  const calls = {}
  for (const [name, w] of [['d1', { fromDate: d1, toDate: d1 }], ['d2', { fromDate: d2, toDate: d2 }], ['d1d2', { fromDate: d1, toDate: d2 }]]) {
    const r = await client.flowSummaryWindow({ chain: token.chain, tokenAddress: token.address, ...w })
    calls[name] = { window: w, state: r.state, requestId: r.headers?.requestId ?? null, row: r.ok ? readFlowRow(r.data.data?.[0]) : null, raw: r.ok ? r.data.data?.[0] ?? null : null, note: r.note ?? null }
    if (name !== 'd1d2' && r.ok && calls[name].row) onDay({ token, window: w, result: r, row: calls[name].row })
  }
  /**
   * Additivity on net flow, judged on the segments whose membership is the most
   * stable across two days (exchange, then whale): if the two-day window ≈ d1 +
   * d2 the `to` day is INCLUSIVE; if ≈ d1 alone it is EXCLUSIVE. Labels are
   * resolved at each call's own `to`, so this is approximate by construction —
   * which is why it is scored on stable segments, and why the numbers are
   * written down beside the verdict rather than replaced by it.
   */
  const scores = {}
  const f = (name, s) => calls[name]?.row?.segments?.[s]?.netFlowUsd ?? null
  for (const s of ['exchange', 'whale', 'smart_trader']) {
    const a = f('d1', s), b = f('d2', s), ab = f('d1d2', s)
    if (a === null || b === null || ab === null) { scores[s] = null; continue }
    const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(ab), 1)
    scores[s] = { d1: a, d2: b, d1d2: ab, inclusiveErr: Math.abs(ab - (a + b)) / scale, exclusiveErr: Math.abs(ab - a) / scale }
  }
  const usable = Object.values(scores).filter(Boolean)
  let verdict = 'undetermined'
  if (usable.length) {
    const inc = usable.reduce((s, x) => s + x.inclusiveErr, 0) / usable.length
    const exc = usable.reduce((s, x) => s + x.exclusiveErr, 0) / usable.length
    verdict = inc < exc ? 'inclusive' : exc < inc ? 'exclusive' : 'undetermined'
    scores.meanInclusiveErr = +inc.toFixed(4)
    scores.meanExclusiveErr = +exc.toFixed(4)
  }
  const out = { probedAtIso: new Date().toISOString(), token: { chain: token.chain, symbol: token.symbol, address: token.address }, days: { d1, d2 }, verdict, scores, calls, note: 'inclusive: a window {from,to} covers the `to` day; exclusive: it stops before it. The arms are built with `to` = the last day INSIDE the window and shifted by one day if the verdict is exclusive.' }
  writeFileSync(path, JSON.stringify(out, null, 2))
  log(`convention probe on ${token.symbol}: ${verdict} (inclusive err ${scores.meanInclusiveErr ?? '—'}, exclusive err ${scores.meanExclusiveErr ?? '—'})`)
  return out
}

async function backfillOhlcv({ client, token, ledgerDir, fromDate, toDate, log }) {
  const dir = join(ledgerDir, 'ohlcv')
  mkdirSync(dir, { recursive: true })
  // gzipped: 22 hourly tapes are ~35 MB raw and ~8 MB compressed, and the ledger ships with the repo
  const path = join(dir, `${token.chain}-${token.symbol}.json.gz`)
  if (existsSync(path)) { log(`  ${token.symbol.padEnd(6)} tape on disk (read back, nothing spent)`); return JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) }
  const candles = []
  const requestIds = []
  const refusals = []
  // split on truncation: halve the range until the venue returns the whole of it
  const fetchRange = async (a, b, depth) => {
    const r = await client.historicalOhlcv({ chain: token.chain, tokenAddress: token.address, fromIso: a, asOfIso: b, timeframe: STUDY_DEFAULTS.timeframe })
    if (r.ok) {
      requestIds.push(r.headers?.requestId ?? null)
      for (const c of r.data.data ?? []) candles.push({ t: c.interval_start, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume_usd ?? null })
      return
    }
    if (r.state === 'truncation-refused' && depth < 4) {
      const mid = iso((dayMs(a) + dayMs(b)) / 2)
      log(`  ${token.symbol.padEnd(6)} tape ${a}→${b} truncated; splitting at ${mid}`)
      await fetchRange(a, mid, depth + 1)
      await fetchRange(addDays(mid, 1), b, depth + 1)
      return
    }
    refusals.push({ from: a, to: b, state: r.state, note: r.note ?? null })
  }
  await fetchRange(fromDate, toDate, 0)
  // one tape, sorted, de-duplicated on the candle's own timestamp
  const byT = new Map()
  for (const c of candles) if (!byT.has(c.t)) byT.set(c.t, c)
  const tape = [...byT.values()].sort((x, y) => Date.parse(x.t) - Date.parse(y.t))
  const out = { chain: token.chain, symbol: token.symbol, address: token.address, timeframe: STUDY_DEFAULTS.timeframe, fromDate, toDate, fetchedAtIso: new Date().toISOString(), requestIds, refusals, candles: tape }
  writeFileSync(path, gzipSync(Buffer.from(JSON.stringify(out))))
  log(`  ${token.symbol.padEnd(6)} ${tape.length} candles ${tape[0]?.t ?? '—'} → ${tape[tape.length - 1]?.t ?? '—'}${refusals.length ? `  (${refusals.length} range(s) refused)` : ''}`)
  return out
}

async function runArm({ arm, client, tokens, ledgerDir, fromDate, toDate, convention, log }) {
  const path = join(ledgerDir, 'calls.jsonl')
  const { ok, seen } = loadCalls(path)
  const windows = windowsFor(arm, fromDate, toDate)
  let made = 0, skipped = 0, failed = 0
  const shift = convention === 'exclusive' ? 1 : 0
  for (const t of tokens) {
    for (const w of windows) {
      const key = keyOf(arm, t, w)
      if (ok.has(key)) { skipped++; continue }
      const prior = seen.get(key)
      if (prior && !RETRY_ERRORS && prior.state === 'shape-refused') { skipped++; continue }
      const call = { fromDate: w.fromDate, toDate: addDays(w.toDate, shift) }
      const r = await client.flowSummaryWindow({ chain: t.chain, tokenAddress: t.address, ...call })
      const row = r.ok && r.data.data?.[0] ? readFlowRow(r.data.data[0]) : null
      const rec = recordCall({ ledgerDir, arm, token: t, window: w, called: call, result: r, row })
      if (rec.state === 'ok') { made++; ok.set(key, rec) } else failed++
      if ((made + failed) % 50 === 0) log(`    ${arm}: ${made} ok, ${failed} not ok, ${skipped} skipped — credits ${client.spent} spent, account ${client.accountRemaining ?? '?'} left`)
    }
    log(`  ${arm.padEnd(8)} ${t.symbol.padEnd(6)} ${windows.length} windows — ${made} made, ${skipped} skipped, ${failed} not ok so far`)
  }
  return { arm, windows: windows.length, made, skipped, failed }
}

// ───────────────────────────────────────────────────────────── main

/** a user's universe file: [{ chain, symbol, address }], chains the flow summary covers; anything else refused up front */
export function loadUniverseFile(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const list = (Array.isArray(raw) ? raw : raw.tokens ?? raw.included ?? []).map((t) => ({ chain: t.chain, symbol: t.symbol, address: t.address }))
  const covered = ['ethereum', 'solana', 'base', 'bnb']
  const bad = list.filter((t) => typeof t.symbol !== 'string' || typeof t.address !== 'string' || !covered.includes(t.chain))
  if (list.length === 0 || bad.length) {
    console.error(`--universe ${path}: every entry needs a symbol, an address and a chain the flow summary covers (${covered.join(', ')}); ${bad.length} do not`)
    process.exit(2)
  }
  return list
}

async function main() {
  const base = UNIVERSE_FILE ? loadUniverseFile(UNIVERSE_FILE) : UNIVERSE
  const universe = TOKENS ? base.filter((t) => TOKENS.split(',').map((s) => s.trim().toUpperCase()).includes(t.symbol.toUpperCase())) : base
  if (universe.length === 0) { console.error('no tokens selected'); process.exit(2) }
  const p = plan({ universe, arms: ARMS, fromDate: FROM, toDate: TO })

  say(`\nASSAY STUDY — ${universe.length} tokens, ${FROM} → ${TO}, arms ${ARMS.join(', ')}`)
  say(`  prereg spec ${specHash()}  (minFlow $${SIGNAL_SPEC.minFlowUsd}, topK ${SIGNAL_SPEC.topK}, horizons ${SIGNAL_SPEC.horizonsHours.join('/')}h, seed ${SIGNAL_SPEC.controlSeed})`)
  say(`  ledger ${LEDGER_DIR}`)
  say(`\n  the arithmetic:`)
  for (const l of p.lines) say(`    ${l.what.padEnd(56)} ${String(l.calls).padStart(6)} calls ${String(l.credits).padStart(7)} credits`)
  say(`    ${'TOTAL (before resume skips and truncation splits)'.padEnd(56)} ${String(p.calls).padStart(6)} calls ${String(p.credits).padStart(7)} credits`)
  say(`  budget ${BUDGET} credits, reserve ${RESERVE} on the account\n`)
  if (DRY) { say('  --dry-run: no calls made.\n'); return }

  const key = process.env.NANSEN_API_KEY
  if (!key) {
    console.error('NANSEN_API_KEY is not set in this environment. No call was attempted.')
    console.error('Set it in the environment of the shell that runs the study (never in a file you commit, never in chat) and run again.\n')
    process.exit(2)
  }
  if (p.credits > BUDGET && !ALLOW_PARTIAL) {
    console.error(`the plan needs ${p.credits} credits and the budget is ${BUDGET}. Raise --budget deliberately, narrow --arms / --tokens / the range, or pass --allow-partial to run until the budget stops it (the ledger resumes).`)
    process.exit(2)
  }
  if (p.credits > BUDGET) say(`  --allow-partial: the plan (${p.credits}) exceeds the budget (${BUDGET}); running until the budget stops it. Resume with a higher budget.\n`)
  mkdirSync(LEDGER_DIR, { recursive: true })
  const manifestPath = join(LEDGER_DIR, 'study-manifest.json')
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {
    startedAtIso: new Date().toISOString(), fromDate: FROM, toDate: TO, arms: ARMS, tokens: universe.map((t) => t.symbol),
    specHash: specHash(), spec: SIGNAL_SPEC, segments: HISTORICAL_SEGMENTS, baseUrl: BASE_URL, tier: TIER,
    prereg: hashFile('PREREGISTRATION.md'), amendment: hashFile('PREREGISTRATION-AMENDMENT-1.md'), plan: p,
    universe: UNIVERSE_FILE ? { declaredIn: UNIVERSE_FILE, sha256: hashFile(UNIVERSE_FILE), note: 'a user universe: a different study from the shipped one, declared here before its first call' } : 'the pre-registered universe (PREREGISTRATION.md section 2)',
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const client = new NansenClient({ apiKey: key, creditBudget: BUDGET, baseUrl: BASE_URL, tier: TIER, remainingFloor: RESERVE })
  const log = (s) => say(s)

  try {
    // 0. the key works, and the account's own balance is known before anything is spent
    const acct = await client.account()
    log(`account probe: ${acct.state}${client.accountRemaining !== null ? ` — ${client.accountRemaining} credits on the account` : ''}`)
    if (acct.state === 'http-error' && acct.status === 401) { console.error('the key was refused (401). Nothing spent.'); process.exit(2) }

    // 1. universe
    log(`\nuniverse resolution (probe day ${TO}):`)
    const resolved = await resolveUniverse({ client, ledgerDir: LEDGER_DIR, probeDate: TO, universe, log, onCall: ({ token, window, result, row }) => { if (result.ok && row && window.fromDate >= FROM && window.toDate <= TO) recordCall({ ledgerDir: LEDGER_DIR, arm: 'daily', token, window, result, row }) } })
    const tokens = resolved.included.map((e) => ({ chain: e.chain, symbol: e.symbol, address: e.address }))
    if (tokens.length === 0) { console.error('no token resolved — stopping before any arm'); process.exit(2) }

    // 2. convention
    log('')
    const conv = await conventionProbe({ client, token: tokens[0], ledgerDir: LEDGER_DIR, log, onDay: ({ token, window, result, row }) => { if (window.fromDate >= FROM && window.toDate <= TO) recordCall({ ledgerDir: LEDGER_DIR, arm: 'daily', token, window, result, row }) } })

    // 3. the tape
    log(`\nOHLCV ${STUDY_DEFAULTS.timeframe}, ${addDays(FROM, -STUDY_DEFAULTS.tapePadDays)} → ${addDays(TO, STUDY_DEFAULTS.tapePadDays)}:`)
    for (const t of tokens) await backfillOhlcv({ client, token: t, ledgerDir: LEDGER_DIR, fromDate: addDays(FROM, -STUDY_DEFAULTS.tapePadDays), toDate: addDays(TO, STUDY_DEFAULTS.tapePadDays), log })

    // 4. the arms — cheapest first, so a budget stop leaves the comparison arms whole and the daily arm resumable
    const armReport = []
    for (const arm of ['naive', 'monthly', 'weekly', 'daily'].filter((a) => ARMS.includes(a))) {
      log(`\narm ${arm}:`)
      armReport.push(await runArm({ arm, client, tokens, ledgerDir: LEDGER_DIR, fromDate: FROM, toDate: TO, convention: conv.verdict, log }))
    }
    finish(client, armReport, 'complete')
  } catch (e) {
    if (e instanceof BudgetExhausted) {
      log(`\nSTOPPED ON BUDGET: ${e.message}`)
      log('Everything answered so far is on the ledger. Re-run with a higher --budget (or a lower --reserve) and it resumes where it stopped, spending nothing twice.')
      finish(client, [], 'stopped-on-budget')
      process.exit(3)
    }
    throw e
  }
}

function hashFile(p) {
  try { return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16) } catch { return null }
}

function finish(client, armReport, status) {
  const spend = client.spendReport()
  const rep = { atIso: new Date().toISOString(), status, arms: armReport, ...spend, accountRemaining: client.accountRemaining, log: client.log }
  writeFileSync(join(LEDGER_DIR, 'spend-report.json'), JSON.stringify(rep, null, 2))
  say(`\n  ${status}: ${spend.calls} calls, ${spend.creditsSpent} credits spent, account reports ${client.accountRemaining ?? '?'} remaining`)
  say(`  ${spend.contestProgress}`)
  say(`  ledger: ${LEDGER_DIR}\n  score it:  node src/score-study.mjs --ledger ${LEDGER_DIR}\n`)
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
if (isMain) await main()
