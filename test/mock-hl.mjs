/**
 * A MOCK HYPERLIQUID-NANSEN — the three positioning endpoints, served locally,
 * over a synthetic book with two planted facts.
 *
 * What it reproduces from docs.nansen.ai (read 2026-09-20):
 *   · POST /api/v1/perp-screener                       cost 1
 *       { date:{from,to}, pagination, filters:{trader_type: all|sm|whale|public_figure, token_symbol?}, order_by? }
 *       all: token_symbol, volume, buy_volume, sell_volume, buy_sell_pressure, trader_count, mark_price, funding, open_interest, previous_price_usd
 *       sm:  + smart_money_volume/_buy_volume/_sell_volume, net_position_change, current_smart_money_position_longs_usd,
 *              current_smart_money_position_shorts_usd (NEGATIVE, as the documented example), smart_money_longs_count/_shorts_count
 *       whale / public_figure: current_position_longs_usd, current_position_shorts_usd (negative), longs_count, shorts_count
 *   · POST /api/v1/tgm/perp-positions                  cost 5 (assumed)
 *       { token_symbol, label_type: all_traders|smart_money|whale|public_figure, pagination (≤1000), order_by }
 *       rows: address, address_label, side, position_value_usd, position_size, leverage (string), leverage_type,
 *             entry_price, mark_price, liquidation_price, funding_usd, upnl_usd
 *   · POST /api/v1/smart-money/perp-trades             cost 5
 *       { filters:{token_symbol?, include_smart_money_labels?}, lookback_hours (1–168), only_new_positions, pagination, order_by }
 *       rows: trader_address_label, trader_address, token_symbol, side, action, token_amount, price_usd, value_usd, type, block_timestamp, transaction_hash
 *   · headers X-Nansen-Credits-Cost / -Used / -Remaining, X-Request-Id; 429 with Retry-After on request; the ErrorEnvelope
 *
 * The world: twenty markets. ETH carries a WALL — a third of its long notional
 * liquidates three and a half percent below the mark, held by unlabelled
 * wallets. HYPE carries DIVERGENCE — smart money is short by notional while the
 * crowd is long, and funding is high. BTC is balanced with low leverage, the
 * control. Three percent of positions carry no liquidation price. A tape of
 * smart-money trades over the trailing week, timestamped against a FIXED now,
 * so a test is the same on any day.
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const HOUR = 3_600_000
function mulberry32(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const gauss = (rnd) => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) }
const seedOf = (s) => createHash('sha256').update(s).digest().readUInt32BE(0)
const hex = (s) => '0x' + createHash('sha256').update(s).digest('hex').slice(0, 40)
const pick = (rnd, xs) => xs[Math.floor(rnd() * xs.length)]

export const MOCK_NOW_ISO = '2026-09-20T04:30:00Z'

export function makeHlWorld({ seed = 11, nowMs = Date.parse(MOCK_NOW_ISO) } = {}) {
  const specs = [
    { symbol: 'BTC', mark: 65000, oiTarget: 1.5e9, n: 3000, longBias: 0.5, funding: 0.00001, levs: [2, 3, 5] },
    { symbol: 'ETH', mark: 2600, oiTarget: 6e8, n: 1200, longBias: 0.55, funding: 0.00002, levs: [2, 3, 5], wall: { share: 0.35, at: -0.035, sd: 0.002 } },
    { symbol: 'HYPE', mark: 28, oiTarget: 3e8, n: 800, longBias: 0.75, funding: 0.0004, levs: [3, 5, 10, 20], smShort: 0.85 },
    { symbol: 'SOL', mark: 150, oiTarget: 2.5e8, n: 500, longBias: 0.5, funding: 0.00001, levs: [2, 3, 5, 10, 20] },
    { symbol: 'DOGE', mark: 0.12, oiTarget: 8e7, n: 300, longBias: 0.6, funding: 0.00003, levs: [3, 5, 10, 20, 40] },
  ]
  const r0 = mulberry32(seedOf(`${seed}|markets`))
  for (let i = 1; i <= 15; i++) specs.push({ symbol: `M${i}`, mark: +(0.5 + r0() * 50).toFixed(3), oiTarget: 1e6 + r0() * 3e7, n: 40 + Math.floor(r0() * 110), longBias: 0.4 + r0() * 0.3, funding: (r0() - 0.5) * 0.0002, levs: [2, 3, 5, 10, 20] })

  const markets = new Map()
  const smAddresses = []
  for (const s of specs) {
    const rnd = mulberry32(seedOf(`${seed}|${s.symbol}`))
    let positions = []
    for (let i = 0; i < s.n; i++) {
      const u = rnd()
      const cohort = u < 0.05 ? 'smart_money' : u < 0.08 ? 'whale' : u < 0.09 ? 'public_figure' : 'other'
      const address = hex(`${seed}|${s.symbol}|${i}`)
      const label = cohort === 'smart_money' ? pick(rnd, ['Smart HL Perps Trader', 'Fund', '90D Smart Trader']) : cohort === 'whale' ? 'Whale' : cohort === 'public_figure' ? `Public Figure ${i}` : null
      const side = cohort === 'smart_money' && s.smShort !== undefined ? (rnd() < s.smShort ? 'Short' : 'Long') : (rnd() < s.longBias ? 'Long' : 'Short')
      const notional = Math.min(5e7, Math.exp(Math.log(20_000) + 1.4 * gauss(rnd)))
      const lev = pick(rnd, s.levs)
      const entry = s.mark * (1 + 0.01 * gauss(rnd))
      let liq = side === 'Long' ? entry * (1 - 0.95 / lev) : entry * (1 + 0.95 / lev)
      let inWall = false
      if (s.wall && side === 'Long' && rnd() < s.wall.share) { liq = s.mark * (1 + s.wall.at + s.wall.sd * gauss(rnd)); inWall = true }
      const noLiq = rnd() < 0.03
      positions.push({ address, address_label: label, cohort, side, position_value_usd: +notional.toFixed(2), position_size: +(notional / s.mark).toFixed(6), leverage: String(lev), leverage_type: rnd() < 0.5 ? 'cross' : 'isolated', entry_price: +entry.toFixed(6), mark_price: s.mark, liquidation_price: noLiq ? null : +liq.toFixed(6), funding_usd: +((rnd() - 0.5) * 200).toFixed(2), upnl_usd: +((rnd() - 0.5) * notional * 0.05).toFixed(2), inWall })
    }
    // scale so both sides together are about twice the target open interest
    const total = positions.reduce((a, p) => a + p.position_value_usd, 0)
    const k = (2 * s.oiTarget) / total
    positions = positions.map((p) => ({ ...p, position_value_usd: +(p.position_value_usd * k).toFixed(2), position_size: +((p.position_value_usd * k) / s.mark).toFixed(6), upnl_usd: +(p.upnl_usd * k).toFixed(2) }))
    positions.sort((a, b) => b.position_value_usd - a.position_value_usd)
    const L = positions.filter((p) => p.side === 'Long').reduce((a, p) => a + p.position_value_usd, 0)
    const S = positions.filter((p) => p.side === 'Short').reduce((a, p) => a + p.position_value_usd, 0)
    const byCohort = (c) => positions.filter((p) => p.cohort === c)
    const sums = (ps) => ({ longsUsd: ps.filter((p) => p.side === 'Long').reduce((a, p) => a + p.position_value_usd, 0), shortsUsd: ps.filter((p) => p.side === 'Short').reduce((a, p) => a + p.position_value_usd, 0), longs: ps.filter((p) => p.side === 'Long').length, shorts: ps.filter((p) => p.side === 'Short').length })
    const wallNotional = positions.filter((p) => p.inWall && p.liquidation_price !== null).reduce((a, p) => a + p.position_value_usd, 0)
    const longMapped = positions.filter((p) => p.side === 'Long' && p.liquidation_price !== null).reduce((a, p) => a + p.position_value_usd, 0)
    const truth = { L, S, openInterest: (L + S) / 2, sm: sums(byCohort('smart_money')), whale: sums(byCohort('whale')), publicFigure: sums(byCohort('public_figure')), wallShareOfMappedLongs: longMapped > 0 ? wallNotional / longMapped : 0, unmappedShare: positions.filter((p) => p.liquidation_price === null).reduce((a, p) => a + p.position_value_usd, 0) / (L + S) }
    const vol = 5e7 + rnd() * 5e8
    const buy = vol * (0.4 + rnd() * 0.2)
    markets.set(s.symbol, { ...s, positions, truth, screener: { volume: +vol.toFixed(2), buy_volume: +buy.toFixed(2), sell_volume: +(vol - buy).toFixed(2), buy_sell_pressure: +(2 * buy - vol).toFixed(2), trader_count: s.n, previous_price_usd: +(s.mark * (1 - 0.01 * gauss(rnd))).toFixed(6) } })
    for (const p of positions) if (p.cohort === 'smart_money') smAddresses.push({ address: p.address, label: p.address_label, market: s.symbol, mark: s.mark })
  }

  // the tape: smart-money perp trades over the trailing week, against a fixed now
  const rt = mulberry32(seedOf(`${seed}|tape`))
  const trades = []
  const actions = ['Open Long', 'Close Long', 'Add Long', 'Reduce Long', 'Open Short', 'Close Short', 'Add Short', 'Reduce Short']
  for (let i = 0; i < 400; i++) {
    const who = pick(rt, smAddresses)
    const action = pick(rt, actions)
    const value = Math.exp(Math.log(50_000) + 1.2 * gauss(rt))
    const at = nowMs - rt() * 168 * HOUR
    trades.push({ trader_address_label: who.label, trader_address: who.address, token_symbol: who.market, side: action.includes('Long') ? 'Long' : 'Short', action, token_amount: +(value / who.mark).toFixed(6), price_usd: +(who.mark * (1 + 0.005 * gauss(rt))).toFixed(6), value_usd: +value.toFixed(2), type: rt() < 0.6 ? 'Market' : 'Limit', block_timestamp: new Date(at).toISOString(), transaction_hash: hex(`${seed}|tx|${i}`) + hex(`${seed}|tx2|${i}`).slice(2, 26) })
  }
  trades.sort((a, b) => Date.parse(b.block_timestamp) - Date.parse(a.block_timestamp))
  return { nowMs, markets, trades, uniqueTradesWithin: (hours) => trades.filter((t) => Date.parse(t.block_timestamp) >= nowMs - hours * HOUR).length }
}

const COST = { '/api/v1/perp-screener': 1, '/api/v1/tgm/perp-positions': 5, '/api/v1/smart-money/perp-trades': 5, '/api/v1/account': 0 }

export function startHlMock({ world, port = 0, balance = 100_000, rateLimitEvery = 0, log = () => {} } = {}) {
  const w = world ?? makeHlWorld()
  const state = { calls: 0, balance, byPath: {}, keys: new Map() }
  let reqSeq = 0
  const paginate = (rows, pg) => {
    const page = Math.max(1, Number(pg?.page ?? 1)), per = Math.min(1000, Math.max(1, Number(pg?.per_page ?? 10)))
    const data = rows.slice((page - 1) * per, page * per)
    return { data, pagination: { page, per_page: per, is_last_page: page * per >= rows.length } }
  }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      state.calls++
      const requestId = `mockhl-${++reqSeq}`
      const send = (status, obj, cost, used) => { res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': requestId, 'x-nansen-credits-cost': String(cost), 'x-nansen-credits-used': String(used), 'x-nansen-credits-remaining': String(state.balance) }); res.end(JSON.stringify(obj)) }
      const envelope = (status, code, message) => send(status, { error: code, message, code, status, request_id: requestId }, 0, 0)
      if (req.headers['apikey'] !== 'mock-key-12345678') return envelope(401, 'unauthorized', 'bad key')
      const path = req.url.split('?')[0]
      state.byPath[path] = (state.byPath[path] ?? 0) + 1
      if (rateLimitEvery > 0 && state.calls % rateLimitEvery === 0) { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1', 'x-request-id': requestId, 'x-nansen-ratelimit-scope': 'second', 'x-nansen-credits-used': '0', 'x-nansen-credits-remaining': String(state.balance) }); return res.end(JSON.stringify({ error: 'rate_limit_exceeded', code: 'rate_limit_exceeded', message: 'slow down', status: 429, request_id: requestId })) }
      if (req.method !== 'POST') return envelope(405, 'method_not_allowed', 'POST only')
      let b = {}
      try { b = body ? JSON.parse(body) : {} } catch { return envelope(400, 'invalid_request', 'bad json') }
      const cost = COST[path]
      if (cost === undefined) return envelope(404, 'not_found', `no route ${path}`)
      if (state.balance < cost) return envelope(402, 'insufficient_credits', 'Not enough API credits remain to call this endpoint')
      if (path === '/api/v1/account') return send(200, { plan: 'mock', credits: state.balance }, 0, 0)
      state.balance -= cost
      state.keys.set(`${path}|${body}`, (state.keys.get(`${path}|${body}`) ?? 0) + 1)

      if (path === '/api/v1/perp-screener') {
        const t = b.filters?.trader_type ?? 'all'
        if (!['all', 'sm', 'whale', 'public_figure'].includes(t)) return envelope(400, 'invalid_request', `bad trader_type ${t}`)
        if (!b.date?.from || !b.date?.to) return envelope(400, 'invalid_request', 'date range required')
        let rows = [...w.markets.values()].filter((m) => !b.filters?.token_symbol || m.symbol === b.filters.token_symbol).map((m) => {
          const base = { token_symbol: m.symbol, ...m.screener, mark_price: m.mark, funding: m.funding, open_interest: +m.truth.openInterest.toFixed(2) }
          if (t === 'all') return base
          if (t === 'sm') return { token_symbol: m.symbol, smart_money_volume: +(m.screener.volume * 0.1).toFixed(2), smart_money_buy_volume: +(m.screener.buy_volume * 0.1).toFixed(2), smart_money_sell_volume: +(m.screener.sell_volume * 0.1).toFixed(2), net_position_change: +((m.screener.buy_volume - m.screener.sell_volume) * 0.1).toFixed(2), trader_count: m.truth.sm.longs + m.truth.sm.shorts, mark_price: m.mark, funding: m.funding, previous_price_usd: m.screener.previous_price_usd, open_interest: +m.truth.openInterest.toFixed(2), current_smart_money_position_longs_usd: +m.truth.sm.longsUsd.toFixed(2), current_smart_money_position_shorts_usd: -+m.truth.sm.shortsUsd.toFixed(2), smart_money_longs_count: m.truth.sm.longs, smart_money_shorts_count: m.truth.sm.shorts }
          const c = t === 'whale' ? m.truth.whale : m.truth.publicFigure
          return { token_symbol: m.symbol, trader_count: c.longs + c.shorts, mark_price: m.mark, funding: m.funding, open_interest: +m.truth.openInterest.toFixed(2), current_position_longs_usd: +c.longsUsd.toFixed(2), current_position_shorts_usd: -+c.shortsUsd.toFixed(2), longs_count: c.longs, shorts_count: c.shorts }
        })
        log(`screener ${t} ${rows.length}`)
        return send(200, paginate(rows, b.pagination), cost, cost)
      }
      if (path === '/api/v1/tgm/perp-positions') {
        const m = w.markets.get(b.token_symbol)
        if (!m) return send(200, { data: [], pagination: { page: 1, per_page: 10, is_last_page: true } }, cost, cost)
        const lt = b.label_type ?? 'all_traders'
        if (!['all_traders', 'smart_money', 'whale', 'public_figure'].includes(lt)) return envelope(400, 'invalid_request', `bad label_type ${lt}`)
        let rows = m.positions.filter((p) => lt === 'all_traders' || p.cohort === lt)
        const ob = b.order_by?.[0]
        if (ob?.field) rows = [...rows].sort((x, y) => (ob.direction === 'ASC' ? 1 : -1) * ((Number(x[ob.field]) || 0) - (Number(y[ob.field]) || 0)))
        rows = rows.map(({ cohort, inWall, ...row }) => row)
        log(`positions ${b.token_symbol} ${lt} page ${b.pagination?.page ?? 1}`)
        return send(200, paginate(rows, b.pagination), cost, cost)
      }
      if (path === '/api/v1/smart-money/perp-trades') {
        const lb = Number(b.lookback_hours ?? 168)
        if (!(lb >= 1 && lb <= 168)) return envelope(400, 'invalid_request', 'lookback_hours 1..168')
        let rows = w.trades.filter((t) => Date.parse(t.block_timestamp) >= w.nowMs - lb * HOUR)
        if (b.only_new_positions) rows = rows.filter((t) => t.action.startsWith('Open'))
        if (b.filters?.token_symbol) rows = rows.filter((t) => t.token_symbol === b.filters.token_symbol)
        if (b.filters?.include_smart_money_labels) rows = rows.filter((t) => b.filters.include_smart_money_labels.includes(t.trader_address_label))
        log(`trades lookback ${lb}h ${rows.length}`)
        return send(200, paginate(rows, b.pagination), cost, cost)
      }
      return envelope(404, 'not_found', `no route ${path}`)
    })
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}`, state, world: w, close: () => new Promise((r) => server.close(r)) })))
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
if (isMain) {
  const m = await startHlMock({ port: Number(process.argv[2] ?? 8788), log: (s) => console.log(s) })
  console.log(`mock hyperliquid-nansen on ${m.url}  (key: mock-key-12345678; now fixed at ${MOCK_NOW_ISO})`)
}
