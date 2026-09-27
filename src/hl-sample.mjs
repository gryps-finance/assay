#!/usr/bin/env node
/**
 * hl-sample.mjs — the clock that turns Nansen's Hyperliquid snapshots into a
 * time series.
 *
 * Nansen's Hyperliquid endpoints answer only for NOW: every open position on a
 * market (with the holder's label, leverage and liquidation price), every
 * market's funding, open interest and smart-money book, and the trailing seven
 * days of smart-money perp trades. None of it can be asked for as of a past
 * date. So the history of labelled positioning on Hyperliquid exists only if
 * someone samples these on a schedule and keeps every reply. This does that.
 *
 * Three passes, each its own cron line, each cheap enough to run often:
 *
 *   screener   every market in four calls (all / smart money / whale / public figure)
 *   positions  the top-N markets by open interest: the largest K positions of
 *              everyone, plus every smart-money, whale and public-figure position
 *   tape       smart-money perp trades over the last interval (+1h of overlap)
 *
 * Every call is one row in `ledger/hl/samples.jsonl`, keyed by sample hour,
 * pass, endpoint, market, label and page; the raw reply is kept gzipped under
 * `ledger/hl/raw/<sample>/`. A pass re-run inside the same hour asks the venue
 * for nothing it already has. The budget is enforced before each call and the
 * account's own remaining balance is never drawn below the reserve.
 *
 *   node src/hl-sample.mjs --pass screener|positions|tape|all [--markets 10] [--top-positions 2000]
 *                          [--interval-hours 1] [--budget 2000] [--reserve 5000] [--tier free|pro]
 *                          [--ledger ledger/hl] [--sample-id 2026-09-20T04] [--dry-run]
 *
 * The key is `NANSEN_API_KEY` in the environment and nowhere else. No key, no
 * client; a dry run needs none.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { gzipSync, gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { NansenClient, BudgetExhausted, CREDIT_COST, PERP_LABEL_TYPES, SCREENER_TRADER_TYPES, readScreenerRow } from './nansen.mjs'

const HOUR = 3_600_000

export const HL_DEFAULTS = Object.freeze({
  markets: 10,
  topPositions: 2000,
  intervalHours: 1,
  budget: 2000,
  reserve: 5000,
  /** page caps per labelled book: a runaway book cannot eat the budget */
  pageCaps: { all_traders: null, smart_money: 10, whale: 10, public_figure: 5 },
  screenerPageCap: 5,
  tapePageCap: 20,
  perPage: 1000,
})

// ───────────────────────────────────────────────────────────── helpers

export const sampleIdFor = (ms) => new Date(Math.floor(ms / HOUR) * HOUR).toISOString().slice(0, 13) // YYYY-MM-DDTHH
export const sampleHourMs = (id) => Date.parse(`${id}:00:00Z`)
const gzWrite = (path, obj) => writeFileSync(path, gzipSync(Buffer.from(JSON.stringify(obj))))
export const gzRead = (path) => JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'))
const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '_')

export function loadSamples(ledgerDir) {
  const path = join(ledgerDir, 'samples.jsonl')
  const ok = new Map(), all = []
  if (!existsSync(path)) return { ok, all }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let r
    try { r = JSON.parse(line) } catch { continue }
    all.push(r)
    if (r.state === 'ok') ok.set(r.key, r)
  }
  return { ok, all }
}

/** the arithmetic before a single call, with the cost table's assumptions stated */
export function plan({ pass, markets, topPositions, perDay = null }) {
  const cS = CREDIT_COST['/api/v1/perp-screener'], cP = CREDIT_COST['/api/v1/tgm/perp-positions'], cT = CREDIT_COST['/api/v1/smart-money/perp-trades']
  const lines = []
  const add = (what, calls, per) => lines.push({ what, calls, credits: calls * per })
  if (pass === 'screener' || pass === 'all') add('screener: four trader types, one page each (more if a type paginates)', 4, cS)
  if (pass === 'positions' || pass === 'all') {
    if (pass === 'positions') add('screener: the all-traders page that ranks markets by open interest', 1, cS)
    const perMarket = Math.ceil(topPositions / HL_DEFAULTS.perPage) + 2 + 1 + 1 // all_traders pages + sm (~2) + whale (~1) + public figure (~1), typical
    add(`positions: ${markets} markets × (${Math.ceil(topPositions / HL_DEFAULTS.perPage)} all-traders pages + ~4 labelled pages)`, markets * perMarket, cP)
  }
  if (pass === 'tape' || pass === 'all') add('tape: smart-money perp trades, typically one to three pages', 2, cT)
  const calls = lines.reduce((a, l) => a + l.calls, 0), credits = lines.reduce((a, l) => a + l.credits, 0)
  return { lines, calls, credits, perDay: perDay ? { runs: perDay, calls: calls * perDay, credits: credits * perDay } : null, assumptions: `perp-screener ${cS}, tgm/perp-positions ${cP} (assumed until the probe), smart-money/perp-trades ${cT} credits per call; the client charges by the venue's X-Nansen-Credits-Used when present` }
}

// ───────────────────────────────────────────────────────────── the sampler

export class Sampler {
  constructor({ client, ledgerDir, sampleId, intervalHours = HL_DEFAULTS.intervalHours, say = () => {} }) {
    this.client = client
    this.ledgerDir = ledgerDir
    this.sampleId = sampleId
    this.intervalHours = intervalHours
    this.say = say
    mkdirSync(join(ledgerDir, 'raw', sampleId), { recursive: true })
    this.samples = loadSamples(ledgerDir)
    this.calls = 0
    this.reused = 0
  }

  #key(parts) { return [this.sampleId, ...parts].join('|') }

  /** one keyed call: answered before → the kept reply; else ask, record, keep */
  async #call({ keyParts, file, path, ask, meta }) {
    const key = this.#key(keyParts)
    const kept = this.samples.ok.get(key)
    const rawPath = join(this.ledgerDir, 'raw', this.sampleId, `${safe(file)}.json.gz`)
    if (kept && existsSync(rawPath)) { this.reused++; return { ok: true, data: gzRead(rawPath), reused: true, row: kept } }
    const r = await ask()
    this.calls++
    const row = {
      key, sampleId: this.sampleId, atIso: new Date().toISOString(), path, ...meta,
      state: r.state, requestId: r.headers?.requestId ?? null,
      credits: { cost: r.cost, used: r.headers?.creditsUsed ?? null, remaining: r.headers?.creditsRemaining ?? null },
      rows: r.ok ? (Array.isArray(r.data?.data) ? r.data.data.length : null) : 0,
      isLastPage: r.ok ? (r.data?.pagination?.is_last_page ?? null) : null,
      raw: r.ok ? file : null,
      note: r.note ?? null,
    }
    appendFileSync(join(this.ledgerDir, 'samples.jsonl'), JSON.stringify(row) + '\n')
    if (r.ok) { gzWrite(rawPath, r.data); this.samples.ok.set(key, row) }
    return { ...r, reused: false, row }
  }

  /** page through one paginated book, stopping on is_last_page or the cap; returns the pages kept */
  async #pages({ keyPrefix, filePrefix, path, cap, ask, meta }) {
    const pages = []
    for (let page = 1; cap === null || page <= cap; page++) {
      const r = await this.#call({ keyParts: [...keyPrefix, `p${page}`], file: `${filePrefix}-p${page}`, path, ask: () => ask(page), meta: { ...meta, page } })
      if (!r.ok) { this.say(`    ${filePrefix} page ${page}: ${r.state}${r.note ? ` — ${r.note}` : ''}`); break }
      pages.push(r.data)
      if (r.data?.pagination?.is_last_page !== false) break
      if ((r.data?.data?.length ?? 0) === 0) break
    }
    return pages
  }

  windowIso() {
    const to = sampleHourMs(this.sampleId)
    return { fromIso: new Date(to - this.intervalHours * HOUR).toISOString(), toIso: new Date(to).toISOString() }
  }

  async screener({ traderTypes = SCREENER_TRADER_TYPES } = {}) {
    const { fromIso, toIso } = this.windowIso()
    const out = {}
    for (const t of traderTypes) {
      const pages = await this.#pages({
        keyPrefix: ['screener', '/api/v1/perp-screener', '*', t], filePrefix: `screener-${t}`, path: '/api/v1/perp-screener', cap: HL_DEFAULTS.screenerPageCap,
        ask: (page) => this.client.perpScreener({ traderType: t, fromIso, toIso, page, perPage: HL_DEFAULTS.perPage }), meta: { pass: 'screener', market: null, label: t, window: { fromIso, toIso } },
      })
      out[t] = pages.flatMap((p) => p.data ?? [])
      this.say(`  screener ${t.padEnd(13)} ${out[t].length} markets in ${pages.length} page(s)`)
    }
    return out
  }

  /** markets ranked by open interest from this sample's all-traders screener page (asked for if absent) */
  async rankMarkets({ n }) {
    const { fromIso, toIso } = this.windowIso()
    const pages = await this.#pages({
      keyPrefix: ['screener', '/api/v1/perp-screener', '*', 'all'], filePrefix: 'screener-all', path: '/api/v1/perp-screener', cap: HL_DEFAULTS.screenerPageCap,
      ask: (page) => this.client.perpScreener({ traderType: 'all', fromIso, toIso, page, perPage: HL_DEFAULTS.perPage }), meta: { pass: 'screener', market: null, label: 'all', window: { fromIso, toIso } },
    })
    const rows = pages.flatMap((p) => p.data ?? []).map((r) => readScreenerRow(r, 'all')).filter((r) => r.market && r.openInterest !== null)
    rows.sort((a, b) => b.openInterest - a.openInterest)
    return rows.slice(0, n)
  }

  async positions({ markets, topPositions = HL_DEFAULTS.topPositions, labelTypes = PERP_LABEL_TYPES }) {
    const out = {}
    for (const m of markets) {
      out[m] = {}
      for (const label of labelTypes) {
        const cap = label === 'all_traders' ? Math.ceil(topPositions / HL_DEFAULTS.perPage) : HL_DEFAULTS.pageCaps[label]
        const pages = await this.#pages({
          keyPrefix: ['positions', '/api/v1/tgm/perp-positions', m, label], filePrefix: `positions-${m}-${label}`, path: '/api/v1/tgm/perp-positions', cap,
          ask: (page) => this.client.perpPositions({ tokenSymbol: m, labelType: label, page, perPage: HL_DEFAULTS.perPage }), meta: { pass: 'positions', market: m, label },
        })
        const n = pages.reduce((a, p) => a + (p.data?.length ?? 0), 0)
        const truncated = pages.length > 0 && pages[pages.length - 1]?.pagination?.is_last_page === false
        out[m][label] = { positions: n, pages: pages.length, truncated }
        this.say(`  ${m.padEnd(8)} ${label.padEnd(14)} ${String(n).padStart(6)} positions, ${pages.length} page(s)${truncated ? ' (capped)' : ''}`)
      }
    }
    return out
  }

  async tape({ lookbackHours = this.intervalHours + 1 } = {}) {
    const lb = Math.min(168, Math.max(1, Math.ceil(lookbackHours)))
    const pages = await this.#pages({
      keyPrefix: ['tape', '/api/v1/smart-money/perp-trades', '*', `lb${lb}`], filePrefix: `tape-lb${lb}`, path: '/api/v1/smart-money/perp-trades', cap: HL_DEFAULTS.tapePageCap,
      ask: (page) => this.client.smartMoneyPerpTrades({ lookbackHours: lb, page, perPage: HL_DEFAULTS.perPage }), meta: { pass: 'tape', market: null, label: `lookback ${lb}h` },
    })
    const n = pages.reduce((a, p) => a + (p.data?.length ?? 0), 0)
    this.say(`  tape lookback ${lb}h: ${n} trades in ${pages.length} page(s)`)
    return { trades: n, pages: pages.length }
  }

  report() {
    const s = this.client.spendReport()
    return { sampleId: this.sampleId, callsMade: this.calls, callsReused: this.reused, creditsSpent: s.creditsSpent, accountRemaining: this.client.accountRemaining, byPath: s.byPath }
  }
}

// ───────────────────────────────────────────────────────────── cli

const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d }
const has = (k) => process.argv.includes(k)

export async function main() {
  const PASS = argOf('--pass', 'all')
  const LEDGER = process.env.HL_LEDGER_DIR ?? argOf('--ledger', 'ledger/hl')
  const MARKETS = Number(argOf('--markets', HL_DEFAULTS.markets))
  const TOP = Number(argOf('--top-positions', HL_DEFAULTS.topPositions))
  const INTERVAL = Number(argOf('--interval-hours', HL_DEFAULTS.intervalHours))
  const BUDGET = Number(argOf('--budget', HL_DEFAULTS.budget))
  const RESERVE = Number(argOf('--reserve', HL_DEFAULTS.reserve))
  const TIER = argOf('--tier', process.env.NANSEN_TIER ?? 'free')
  const BASE_URL = argOf('--base-url', process.env.NANSEN_BASE_URL ?? 'https://api.nansen.ai')
  const SAMPLE_ID = argOf('--sample-id', sampleIdFor(Date.now()))
  const MARKET_LIST = argOf('--market-list', null)
  const say = (s) => console.log(s)
  if (!['screener', 'positions', 'tape', 'all'].includes(PASS)) { console.error(`--pass must be screener, positions, tape or all`); process.exit(2) }

  if (has('--dry-run')) {
    const p = plan({ pass: PASS, markets: MARKETS, topPositions: TOP, perDay: Number(argOf('--per-day', 0)) || null })
    say(`\n  HL SAMPLER — dry run for pass '${PASS}' (sample ${SAMPLE_ID}, interval ${INTERVAL}h)`)
    for (const l of p.lines) say(`  ${String(l.calls).padStart(5)} calls  ${String(l.credits).padStart(6)} credits  ${l.what}`)
    say(`  ${String(p.calls).padStart(5)} calls  ${String(p.credits).padStart(6)} credits  per run`)
    if (p.perDay) say(`  ${String(p.perDay.calls).padStart(5)} calls  ${String(p.perDay.credits).padStart(6)} credits  per day at ${p.perDay.runs} runs/day`)
    say(`  assumptions: ${p.assumptions}\n`)
    return
  }

  const apiKey = process.env.NANSEN_API_KEY
  if (!apiKey) { console.error('NANSEN_API_KEY is not set. The sampler refuses to construct a client without it; it never reads a key from anywhere else.'); process.exit(2) }
  const client = new NansenClient({ apiKey, creditBudget: BUDGET, tier: TIER, baseUrl: BASE_URL, remainingFloor: RESERVE })
  mkdirSync(LEDGER, { recursive: true })
  const s = new Sampler({ client, ledgerDir: LEDGER, sampleId: SAMPLE_ID, intervalHours: INTERVAL, say })
  say(`\n  HL SAMPLER — pass '${PASS}', sample ${SAMPLE_ID}, budget ${BUDGET}, reserve ${RESERVE}, ledger ${LEDGER}`)
  let exit = 0
  try {
    if (PASS === 'screener' || PASS === 'all') await s.screener()
    if (PASS === 'positions' || PASS === 'all') {
      const markets = MARKET_LIST ? MARKET_LIST.split(',').map((x) => x.trim()).filter(Boolean) : (await s.rankMarkets({ n: MARKETS })).map((r) => r.market)
      say(`  markets: ${markets.join(', ')}`)
      await s.positions({ markets, topPositions: TOP })
    }
    if (PASS === 'tape' || PASS === 'all') await s.tape()
  } catch (e) {
    if (e instanceof BudgetExhausted) { say(`  STOPPED on budget: ${e.message}`); exit = 3 } else throw e
  }
  const rep = s.report()
  mkdirSync(join(LEDGER, 'spend'), { recursive: true })
  writeFileSync(join(LEDGER, 'spend', `${SAMPLE_ID}-${PASS}.json`), JSON.stringify(rep, null, 2))
  say(`  done: ${rep.callsMade} calls made, ${rep.callsReused} reused, ${rep.creditsSpent} credits spent, account reports ${rep.accountRemaining ?? '—'} remaining\n`)
  process.exit(exit)
}

if (process.argv[1]?.endsWith('hl-sample.mjs')) main()
