/**
 * hl-tools.mjs — the Hyperliquid positioning tools an agent calls.
 *
 * Read-only over `ledger/hl/derived/`. No key, no network. Every answer names
 * the sample hour it comes from and how old that is, and says plainly when
 * nothing has been sampled: absence is reported as absence, never as a calm
 * market.
 *
 *   hl_status             what has been sampled, how recently, at what coverage
 *   hl_liquidation_map    where a market's open positions liquidate, above and
 *                         below the mark, by who holds them
 *   hl_crowding           smart money's skew against the crowd's, with funding
 *   hl_smart_money_tape   what smart-money wallets did on Hyperliquid perps
 *   hl_series             one metric's history for one market
 *
 * Nothing here is a validated signal yet. The pre-registered tests
 * (PREREGISTRATION-HL.md) score the panel as it accumulates; until they do,
 * these are measurements with provenance, and each answer says so.
 */
import { join } from 'node:path'
import { loadLatest, loadSeries, loadTape, loadMap, aggregateTape, COHORTS } from './hl-derive.mjs'

const HOUR = 3_600_000
const pct = (x, d = 1) => (x === null || x === undefined ? null : `${(x * 100).toFixed(d)}%`)
const usd = (x) => (x === null || x === undefined ? null : x >= 1e9 ? `$${(x / 1e9).toFixed(2)}b` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}m` : x >= 1e3 ? `$${(x / 1e3).toFixed(0)}k` : `$${Math.round(x)}`)

export const HL_TOOLS = [
  { name: 'hl_status', description: 'What the Hyperliquid positioning sampler has: latest sample hours for the screener, the positions books and the smart-money tape, how old they are, how many markets, and the coverage of each market\'s liquidation map. Call first if any other hl_ tool refuses.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'hl_liquidation_map', description: 'Where a Hyperliquid market\'s open positions liquidate, relative to the current mark: notional within 1/2/3/5/10/20% below (longs) and above (shorts), the largest cluster on each side, and who holds it (smart money, public figures, whales, everyone else). Squeeze and cascade risk with the holder\'s label on it. From the latest positions sample; the sample hour and its age are in the answer.', inputSchema: { type: 'object', properties: { market: { type: 'string', description: 'perp symbol as Hyperliquid names it, e.g. "BTC", "ETH", "HYPE"' }, bins: { type: 'number', description: 'how many of the heaviest half-percent bins to return per side (default 8)' } }, required: ['market'] } },
  { name: 'hl_crowding', description: 'Smart money\'s long/short skew against the crowd\'s on a Hyperliquid market, with funding and open interest beside them. Divergence = smart-money skew minus crowd skew; a carry setup is flagged when funding is elevated and the informed cohort sits on the other side of the crowd. Without a market, every sampled market ranked by divergence.', inputSchema: { type: 'object', properties: { market: { type: 'string', description: 'perp symbol; omit for all markets' } }, required: [] } },
  { name: 'hl_smart_money_tape', description: 'What smart-money wallets did on Hyperliquid perps over the last N hours: opens, closes, adds and reduces by side, net direction, notional, and the largest traders — per market, or for one market.', inputSchema: { type: 'object', properties: { market: { type: 'string' }, hours: { type: 'number', description: 'lookback in hours (default 24)' } }, required: [] } },
  { name: 'hl_refresh', description: 'RUN a light live positioning pass now: the venue-wide screener (funding, open interest and the smart-money book for every Hyperliquid market) and the full positions books for the top N markets by open interest, then derive the liquidation maps and the crowding index. Spends roughly 25 to 80 credits (capped per call) and needs NANSEN_API_KEY in the MCP server\'s environment. The markets are chosen venue-wide by open interest, so the pull never reveals which markets you care about. Returns hl_status and the crowding table.', inputSchema: { type: 'object', properties: { markets: { type: 'number', description: 'how many top markets to pull positions for (1 to 5, default 3)' }, maxCredits: { type: 'number', description: 'budget for this call; default 120, never above the server cap' } }, required: [] } },
  { name: 'hl_series', description: 'The history of one metric for one market from the sampler\'s panel: divergence, smSkew, crowdSkew, funding, fundingAnnualised, oi, mark, pressureRatio, coverage, liq.below.w5, liq.above.w5 and any other scalar on a series row.', inputSchema: { type: 'object', properties: { market: { type: 'string' }, metric: { type: 'string', description: 'default "divergence"' }, hours: { type: 'number', description: 'default 168' } }, required: ['market'] } },
]

const NO_LEDGER = (ledgerDir) => ({ refused: true, reason: `No Hyperliquid ledger under ${ledgerDir}. This is ABSENCE — nothing has been sampled — not a quiet market. Run src/hl-sample.mjs on a schedule and src/hl-derive.mjs after it.`, ledgerDir })
const PROVENANCE = 'Measurements from a scheduled sampler of Nansen\'s point-in-time Hyperliquid endpoints (labels resolved by Nansen at sample time). Not a validated signal: the pre-registered tests in PREREGISTRATION-HL.md score this panel as it accumulates. Size on a verdict, not on a level.'
const age = (sampleId, nowMs) => (sampleId ? +((nowMs - Date.parse(`${sampleId}:00:00Z`)) / HOUR).toFixed(1) : null)
const get = (o, path) => path.split('.').reduce((a, k) => (a === null || a === undefined ? undefined : a[k]), o)

export function callHlTool(name, args = {}, ledgerDir = process.env.HL_LEDGER_DIR ?? 'ledger/hl') {
  const nowMs = args?.nowIso ? Date.parse(args.nowIso) : Date.now()
  const latest = loadLatest(ledgerDir)
  if (!latest) return NO_LEDGER(ledgerDir)

  if (name === 'hl_status') {
    const markets = Object.values(latest.markets ?? {})
    return {
      asOf: latest.asOf, ageHours: { screener: age(latest.asOf.screener, nowMs), positions: age(latest.asOf.positions, nowMs), tape: age(latest.asOf.tape, nowMs) },
      samples: latest.samples, seriesRows: latest.seriesRows, tapeTrades: latest.tapeTrades, generatedAtIso: latest.generatedAtIso,
      markets: markets.length, withPositions: markets.filter((m) => m.kind === 'positions').map((m) => ({ market: m.market, sampleId: m.sampleId, coverage: m.coverage, positions: m.positions })),
      stale: age(latest.asOf.positions, nowMs) !== null && age(latest.asOf.positions, nowMs) > 8 ? 'the latest positions sample is more than eight hours old — the sampler may have stopped' : null,
      provenance: PROVENANCE,
    }
  }

  if (name === 'hl_liquidation_map') {
    const m = args.market
    const row = latest.markets?.[m]
    if (!row) return { refused: true, reason: `no sample for market '${m}'. Sampled markets: ${Object.keys(latest.markets ?? {}).join(', ') || '(none)'}` }
    if (row.kind !== 'positions') return { refused: true, reason: `'${m}' has only screener rows (funding, open interest, the smart-money book); its positions have not been pulled — it is outside the top-N by open interest the sampler pulls positions for. Absence, not an empty map.` }
    const map = loadMap(ledgerDir, row.sampleId, m)
    if (!map) return { refused: true, reason: `the map file for ${m} @ ${row.sampleId} is missing; re-run src/hl-derive.mjs --all` }
    const nb = Number(args.bins ?? 8)
    const top = (side) => map.bins.map((b) => ({ from: b.from, to: b.to, notional: COHORTS.reduce((a, c) => a + b[side][c], 0), byCohort: b[side] })).filter((b) => b.notional > 0).sort((a, b) => b.notional - a.notional).slice(0, nb).sort((a, b) => a.from - b.from)
    const L = map.long, S = map.short
    const read = [
      `Longs (liquidate below the mark): ${pct(L.within.w3.share)} of mapped long notional within 3%, ${pct(L.within.w5.share)} within 5%, ${pct(L.within.w10.share)} within 10%${L.largest ? `; the heaviest half-percent band sits at ${pct(L.largest.from)} to ${pct(L.largest.to)} holding ${pct(L.largest.share)} (${usd(L.largest.notional)}; smart money ${usd(L.largest.byCohort.smart_money)}, whales ${usd(L.largest.byCohort.whale)})` : ''}.`,
      `Shorts (liquidate above the mark): ${pct(S.within.w3.share)} within 3%, ${pct(S.within.w5.share)} within 5%, ${pct(S.within.w10.share)} within 10%${S.largest ? `; heaviest band ${pct(S.largest.from)} to ${pct(S.largest.to)} holding ${pct(S.largest.share)} (${usd(S.largest.notional)})` : ''}.`,
      `Unmapped (no liquidation price on the position): longs ${usd(L.unmapped)}, shorts ${usd(S.unmapped)}. Coverage of the book: ${pct(row.coverage)} of two-sided open interest.`,
    ]
    return {
      market: m, sampleId: row.sampleId, ageHours: age(row.sampleId, nowMs), markPrice: map.markPrice, openInterest: row.oi, coverage: row.coverage, positions: map.positions, labelledAddresses: map.labelled,
      long: { count: L.count, mapped: L.mapped, unmapped: L.unmapped, anomalies: L.anomalies, beyondRange: L.beyondRange, within: L.within, byCohort: L.byCohort, mappedByCohort: L.mappedByCohort, largest: L.largest, heaviestBins: top('long') },
      short: { count: S.count, mapped: S.mapped, unmapped: S.unmapped, anomalies: S.anomalies, beyondRange: S.beyondRange, within: S.within, byCohort: S.byCohort, mappedByCohort: S.mappedByCohort, largest: S.largest, heaviestBins: top('short') },
      read, howToRead: 'Shares are of MAPPED notional on that side. A large share within a few percent is a cascade waiting on a small move; whose notional it is tells you whether the informed cohort is exposed or the crowd is.', provenance: PROVENANCE,
    }
  }

  if (name === 'hl_crowding') {
    const one = (row) => {
      const carry = row.funding !== null && row.smSkew !== null && row.crowdSkew !== null
        ? (row.funding > 0.00005 && row.smSkew < -0.2 && row.crowdSkew > 0.2) ? 'longs pay elevated funding, the crowd is long, smart money is short: the carry setup on the short side'
          : (row.funding < -0.00005 && row.smSkew > 0.2 && row.crowdSkew < -0.2) ? 'shorts pay, the crowd is short, smart money is long: the carry setup on the long side' : null
        : null
      return { market: row.market, kind: row.kind, sampleId: row.sampleId, ageHours: age(row.sampleId, nowMs), mark: row.mark, funding: row.funding, fundingAnnualised: row.fundingAnnualised, openInterest: row.oi, smSkew: row.smSkew, crowdSkew: row.crowdSkew ?? null, divergence: row.divergence ?? null, pressureRatio: row.pressureRatio, sm: row.sm, whale: row.whale ?? null, publicFigure: row.publicFigure ?? null, crowd: row.crowd ?? null, coverage: row.coverage ?? null, carrySetup: carry }
    }
    if (args.market) {
      const row = latest.markets?.[args.market]
      if (!row) return { refused: true, reason: `no sample for market '${args.market}'` }
      return { ...one(row), howToRead: 'skew = (longs − shorts) / (longs + shorts) by notional, +1 all long, −1 all short. Smart-money skew is from the venue\'s full smart-money book; crowd skew from the largest positions the sampler pulled, excluding smart money\'s own. Divergence = smart money minus crowd. Funding is the venue\'s current rate per period; annualised for scale.', provenance: PROVENANCE }
    }
    const rows = Object.values(latest.markets ?? {}).map(one).sort((a, b) => Math.abs(b.divergence ?? 0) - Math.abs(a.divergence ?? 0) || Math.abs(b.fundingAnnualised ?? 0) - Math.abs(a.fundingAnnualised ?? 0))
    return { asOf: latest.asOf, markets: rows, carrySetups: rows.filter((r) => r.carrySetup), howToRead: 'Ranked by |divergence| (needs a positions sample), then by |funding|. Screener-only markets carry the smart-money skew and funding but no crowd skew.', provenance: PROVENANCE }
  }

  if (name === 'hl_smart_money_tape') {
    const hours = Number(args.hours ?? 24)
    const tape = loadTape(ledgerDir)
    const since = nowMs - hours * HOUR
    const agg = aggregateTape(tape, { sinceMs: since, market: args.market ?? null })
    const recent = tape.filter((t) => (!args.market || t.market === args.market) && t.atIso && Date.parse(t.atIso) >= since).sort((a, b) => Date.parse(b.atIso) - Date.parse(a.atIso)).slice(0, 20)
    return { hours, asOf: latest.asOf.tape, ageHours: age(latest.asOf.tape, nowMs), tradesInWindow: recent.length ? agg.reduce((a, m) => a + m.trades, 0) : 0, markets: agg, latest: recent, howToRead: 'net = notional opened or added on the long side minus on the short side (closes and reduces count against). The tape is smart-money wallets only, as Nansen labels them; it is what they did, not what they will do.', provenance: PROVENANCE }
  }

  if (name === 'hl_series') {
    const m = args.market, metric = args.metric ?? 'divergence', hours = Number(args.hours ?? 168)
    const since = nowMs - hours * HOUR
    const rows = loadSeries(ledgerDir).filter((r) => r.market === m && Date.parse(r.atIso) >= since).sort((a, b) => a.atIso.localeCompare(b.atIso))
    if (!rows.length) return { refused: true, reason: `no series rows for '${m}' in the last ${hours}h` }
    const points = rows.map((r) => ({ atIso: r.atIso, kind: r.kind, value: get(r, metric) ?? null })).filter((p) => p.value !== undefined)
    return { market: m, metric, hours, points, count: points.length, provenance: PROVENANCE }
  }

  return { refused: true, reason: `unknown tool '${name}'` }
}
