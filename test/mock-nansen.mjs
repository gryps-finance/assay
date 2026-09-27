/**
 * A MOCK NANSEN — the documented contract, served locally, over a synthetic
 * world with a planted answer.
 *
 * It exists so the whole live path — client, resolution, convention probe,
 * tape backfill, four arms, resume, budget stop, scoring, leak measurement —
 * runs end to end WITHOUT a key, and so the instrument is shown to recover an
 * answer that was planted before it looked. That is how a measuring instrument
 * is tested; it is not a finding about any real segment.
 *
 * What it reproduces from docs.nansen.ai (read 2026-09-19):
 *   · POST /api/v1/account                                       cost 0
 *   · POST /api/v1beta1/tgm/historical-token-flow-summary        cost 5
 *       body { chain, token_address, date_range:{from,to}, apply_blacklist_filter }
 *       ONE row per call: { token_symbol, <segment>_net_flow_usd, _avg_flow_usd, _wallet_count } × 6
 *       segment columns NULL before that segment's coverage start
 *       labels resolved at `to` — modelled as a LEAK term that grows with the window
 *   · POST /api/v1beta1/tgm/historical-token-ohlcv               cost 5
 *       body { chain, token_address, date_from, as_of_date, timeframe }
 *       { chain, token_address, timeframe, data:[{interval_start, open, high, low, close, volume, volume_usd, market_cap}], truncated, truncation_note }
 *       a candle cap that drops the MOST RECENT candles and sets truncated
 *   · headers X-Nansen-Credits-Cost / -Used / -Remaining, X-Request-Id
 *   · 429 with Retry-After when asked to inject them
 *   · the ErrorEnvelope with code `insufficient_credits` when the balance is gone
 *
 * The world: hourly prices per token (geometric random walk), daily flows per
 * segment. `smart_trader` flow sign is correlated with the NEXT 24h return
 * (the planted edge); `top_pnl` faintly; every other segment is noise —
 * `exchange` above all, because it is the negative control. Windowed calls
 * (from ≠ to) add a leak term proportional to the window length that knows
 * the return AFTER the window ends; a single-day call carries none.
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { UNIVERSE } from '../src/universe.mjs'

const DAY = 86_400_000
const HOUR = 3_600_000
const COVERAGE_START = { whale: '2025-03-11', public_figure: '2025-03-11', top_pnl: '2025-03-11', exchange: '2025-03-11', smart_trader: '2020-01-01', fresh_wallets: '2020-01-01' }
const SEGMENTS = Object.keys(COVERAGE_START)

function mulberry32(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const gauss = (rnd) => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) }
const seedOf = (s) => createHash('sha256').update(s).digest().readUInt32BE(0)
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`)
const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10)

export function makeWorld({ seed = 7, tapeFrom = '2025-01-01', tapeTo = '2026-10-15', hourlyVol = 0.006, edgeBps24h = 80, faintEdgeBps24h = 20, leakBpsPerDay = 25, wrongSymbolFor = [] } = {}) {
  const byAddress = new Map()
  const start = dayMs(tapeFrom)
  const end = dayMs(tapeTo)
  for (const t of UNIVERSE) {
    const rnd = mulberry32(seedOf(`${seed}|${t.chain}|${t.address}`))
    // hourly log-price path
    const candles = []
    let logp = Math.log(10 + rnd() * 3000)
    for (let ms = start; ms <= end; ms += HOUR) {
      const o = Math.exp(logp)
      logp += hourlyVol * gauss(rnd)
      const c = Math.exp(logp)
      candles.push({ interval_start: new Date(ms).toISOString(), open: +o.toFixed(6), high: +(Math.max(o, c) * (1 + rnd() * 0.002)).toFixed(6), low: +(Math.min(o, c) * (1 - rnd() * 0.002)).toFixed(6), close: +c.toFixed(6), volume: +(rnd() * 1e5).toFixed(2), volume_usd: +(rnd() * 1e6).toFixed(2), market_cap: { open: null, high: null, low: null, close: null } })
    }
    const idx = new Map(candles.map((c, i) => [c.interval_start, i]))
    const priceAt = (ms) => { const i = idx.get(new Date(ms).toISOString()); return i === undefined ? null : candles[i].open }
    const fwdRet = (ms, hours) => { const a = priceAt(ms), b = priceAt(ms + hours * HOUR); return a && b ? Math.log(b / a) : 0 }
    // daily flows: known at the END of day D; the "future" is measured from D+1 00:00
    const flows = new Map()
    for (let ms = start; ms <= end; ms += DAY) {
      const d = dayStr(ms)
      const claimMs = ms + DAY
      const r24 = fwdRet(claimMs, 24)
      const row = {}
      for (const s of SEGMENTS) {
        const mag = 250_000 * Math.exp(1.2 * gauss(rnd)) // log-normal around the threshold, so plenty clear it and plenty do not
        const noise = gauss(rnd)
        let signal = 0
        if (s === 'smart_trader') signal = (edgeBps24h / 1e4) / (hourlyVol * Math.sqrt(24)) // in units of 24h sd
        if (s === 'top_pnl') signal = (faintEdgeBps24h / 1e4) / (hourlyVol * Math.sqrt(24))
        const z = signal * (r24 / (hourlyVol * Math.sqrt(24))) + noise
        row[s] = { net: +(Math.sign(z) * mag).toFixed(2), avg: +(mag / 3).toFixed(2), wallets: 5 + Math.floor(rnd() * 40) }
      }
      flows.set(d, row)
    }
    byAddress.set(`${t.chain}|${t.address.toLowerCase()}`, { ...t, candles, flows, priceAt, fwdRet, wrongSymbol: wrongSymbolFor.includes(t.symbol) })
  }
  return { byAddress, hourlyVol, leakBpsPerDay, tapeFrom, tapeTo }
}

/** one flow-summary row for a window, labels "resolved at `to`": a leak term that knows the return after the window */
function flowRow(world, tok, fromDate, toDate) {
  const row = { token_symbol: tok.wrongSymbol ? 'NOTTHIS' : tok.symbol }
  const days = []
  for (let ms = dayMs(fromDate); ms <= dayMs(toDate); ms += DAY) days.push(dayStr(ms))
  const windowDays = days.length
  const afterMs = dayMs(toDate) + DAY
  const r48 = tok.fwdRet(afterMs, 48)
  for (const s of SEGMENTS) {
    if (dayMs(toDate) < dayMs(COVERAGE_START[s])) { row[`${s}_net_flow_usd`] = null; row[`${s}_avg_flow_usd`] = null; row[`${s}_wallet_count`] = null; continue }
    let net = 0, avg = 0, wallets = 0
    for (const d of days) { const f = tok.flows.get(d); if (!f) continue; net += f[s].net; avg += f[s].avg; wallets = Math.max(wallets, f[s].wallets) }
    // the leak: membership resolved at the END of a multi-day window is informed by what happened inside it and just after —
    // modelled as a push in the direction of the post-window return, growing with the window, absent on a single day, absent on exchange
    if (windowDays > 1 && s !== 'exchange') {
      const leak = (world.leakBpsPerDay * (windowDays - 1) / 1e4) / (world.hourlyVol * Math.sqrt(48))
      // past one 48h-sd of leak the pull is strong enough to flip the sign toward the post-window return
      net += Math.sign(r48) * Math.min(2, Math.abs(leak) * 3) * Math.abs(net)
    }
    row[`${s}_net_flow_usd`] = +net.toFixed(2)
    row[`${s}_avg_flow_usd`] = +(avg / Math.max(1, days.length)).toFixed(2)
    row[`${s}_wallet_count`] = wallets
  }
  return row
}

export function startMock({ world, port = 0, balance = 100_000, candleCap = 50_000, rateLimitEvery = 0, renameField = null, log = () => {} } = {}) {
  const w = world ?? makeWorld()
  const state = { calls: 0, balance, byPath: {}, keys: new Map() }
  let reqSeq = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      state.calls++
      const requestId = `mock-${++reqSeq}`
      const send = (status, obj, cost, used) => {
        const h = { 'content-type': 'application/json', 'x-request-id': requestId, 'x-nansen-credits-cost': String(cost), 'x-nansen-credits-used': String(used), 'x-nansen-credits-remaining': String(state.balance) }
        res.writeHead(status, h); res.end(JSON.stringify(obj))
      }
      const envelope = (status, code, message) => send(status, { error: code, message, code, status, request_id: requestId, doc_url: 'https://docs.nansen.ai' }, 0, 0)
      if (req.headers['apikey'] !== process.env.MOCK_NANSEN_KEY && req.headers['apikey'] !== 'mock-key-12345678') return envelope(401, 'unauthorized', 'bad key')
      const path = req.url.split('?')[0]
      state.byPath[path] = (state.byPath[path] ?? 0) + 1
      if (rateLimitEvery > 0 && state.calls % rateLimitEvery === 0) { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1', 'x-request-id': requestId, 'x-nansen-ratelimit-scope': 'second', 'x-nansen-credits-used': '0', 'x-nansen-credits-remaining': String(state.balance) }); return res.end(JSON.stringify({ error: 'rate_limit_exceeded', code: 'rate_limit_exceeded', message: 'slow down', status: 429, request_id: requestId })) }
      let b = {}
      try { b = body ? JSON.parse(body) : {} } catch { return envelope(400, 'invalid_request', 'bad json') }
      if (req.method !== 'POST') return envelope(405, 'method_not_allowed', 'POST only')
      if (path === '/api/v1/account') return send(200, { plan: 'mock', credits: state.balance }, 0, 0)
      const cost = 5
      if (path === '/api/v1beta1/tgm/historical-token-flow-summary' || path === '/api/v1beta1/tgm/historical-token-ohlcv') {
        if (state.balance < cost) return envelope(402, 'insufficient_credits', 'Not enough API credits remain to call this endpoint')
        const tok = w.byAddress.get(`${b.chain}|${String(b.token_address ?? '').toLowerCase()}`)
        if (!tok) { state.balance -= cost; return send(200, { data: [], warnings: ['unknown token'] }, cost, cost) }
        if (path === '/api/v1beta1/tgm/historical-token-flow-summary') {
          const from = String(b.date_range?.from ?? '').slice(0, 10), to = String(b.date_range?.to ?? '').slice(0, 10)
          if (!from || !to || dayMs(to) < dayMs(from)) return envelope(400, 'invalid_date_range', 'The requested date range is not allowed')
          state.balance -= cost
          const key = `${b.chain}|${b.token_address}|${from}|${to}`
          state.keys.set(key, (state.keys.get(key) ?? 0) + 1)
          const row = flowRow(w, tok, from, to)
          if (renameField) { row[`${renameField}__renamed`] = row[renameField]; delete row[renameField] }
          log(`flow ${tok.symbol} ${from}→${to}`)
          return send(200, { data: [row], warnings: [] }, cost, cost)
        }
        const from = String(b.date_from ?? '').slice(0, 10), to = String(b.as_of_date ?? '').slice(0, 10)
        if (!from || !to || dayMs(to) < dayMs(from)) return envelope(400, 'invalid_date_range', 'The requested date range is not allowed')
        if (b.timeframe !== '1h') return envelope(400, 'invalid_request', 'mock serves 1h only')
        state.balance -= cost
        const a = dayMs(from), z = dayMs(to) + DAY
        let candles = tok.candles.filter((c) => { const t = Date.parse(c.interval_start); return t >= a && t < z })
        let truncated = false
        if (candles.length > candleCap) { candles = candles.slice(0, candleCap); truncated = true }
        log(`ohlcv ${tok.symbol} ${from}→${to} ${candles.length}${truncated ? ' TRUNCATED' : ''}`)
        return send(200, { chain: b.chain, token_address: b.token_address, timeframe: '1h', data: candles, truncated, ...(truncated ? { truncation_note: `capped at ${candleCap} candles; most recent omitted` } : {}) }, cost, cost)
      }
      return envelope(404, 'not_found', `no route ${path}`)
    })
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}`, state, world: w, close: () => new Promise((r) => server.close(r)) })))
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
if (isMain) {
  const m = await startMock({ port: Number(process.argv[2] ?? 8787), log: (s) => console.log(s) })
  console.log(`mock nansen on ${m.url}  (key: mock-key-12345678)`)
}
