#!/usr/bin/env node
/**
 * hl-derive.mjs — what the snapshots say, computed from the ledger, no key.
 *
 * From each sample hour's raw pages:
 *
 *   the liquidation map   every open position's liquidation price relative to
 *                         the mark, stacked into half-percent bins above and
 *                         below, notional-weighted, split by who holds it
 *                         (smart money / public figure / whale / everyone else)
 *                         and by side. Squeeze and cascade risk, per market,
 *                         with the holder's label on it.
 *   the crowding index    smart money's long/short skew against the crowd's,
 *                         with funding and open interest beside them. High
 *                         funding with the informed cohort on the other side
 *                         of the crowd is the carry setup; the divergence is
 *                         the number.
 *   the tape              smart-money perp trades, de-duplicated across the
 *                         sampler's overlapping lookbacks into one continuous
 *                         record.
 *   the series            one row per market per sample hour with all of the
 *                         above as scalars — the panel the pre-registered
 *                         tests score as it accumulates.
 *
 * Idempotent: a sample already in the series is not re-derived unless --all.
 * Absence is kept as absence: a position without a liquidation price is
 * counted as UNMAPPED notional, never placed at zero; a market the screener
 * did not return has null funding, not zero.
 *
 *   node src/hl-derive.mjs [--ledger ledger/hl] [--all]
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'
import { readPositionRow, readScreenerRow, readPerpTradeRow } from './nansen.mjs'
import { loadSamples, gzRead, sampleHourMs } from './hl-sample.mjs'

export const COHORTS = Object.freeze(['smart_money', 'public_figure', 'whale', 'other'])
export const LIQ_THRESHOLDS = Object.freeze([0.01, 0.02, 0.03, 0.05, 0.10, 0.20])
const BIN = 0.005, RANGE = 0.5

const zeroBy = () => Object.fromEntries(COHORTS.map((c) => [c, 0]))
const skewOf = (l, s) => (l === null || s === null || l + s <= 0 ? null : (l - s) / (l + s))
const r4 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : +x.toFixed(4))
const r0 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x))

// ───────────────────────────────────────────────────────────── positions → union with cohorts

/**
 * The positions the sampler kept for one market in one sample, as one book:
 * the capped all-traders pull plus every labelled pull, keyed by address and
 * side. Cohort priority smart_money > public_figure > whale > other; the
 * overlaps are counted, not hidden.
 */
export function unionPositions(pagesByLabel) {
  const cohortOf = new Map()
  const rank = { smart_money: 3, public_figure: 2, whale: 1 }
  for (const label of ['whale', 'public_figure', 'smart_money']) {
    for (const p of pagesByLabel[label] ?? []) for (const row of p.data ?? []) {
      const r = readPositionRow(row)
      if (!r.address) continue
      const cur = cohortOf.get(r.address)
      if (!cur || rank[label] > rank[cur]) cohortOf.set(r.address, label)
    }
  }
  const book = new Map()
  let overlaps = 0
  const put = (r, fromLabel) => {
    if (!r.address || !r.side || r.notionalUsd === null) return
    const k = `${r.address}|${r.side}`
    if (book.has(k)) { overlaps++; if (fromLabel === 'all_traders') return }
    book.set(k, { ...r, cohort: cohortOf.get(r.address) ?? 'other' })
  }
  for (const label of ['all_traders', 'whale', 'public_figure', 'smart_money']) for (const p of pagesByLabel[label] ?? []) for (const row of p.data ?? []) put(readPositionRow(row), label)
  return { positions: [...book.values()], overlaps, labelled: cohortOf.size }
}

// ───────────────────────────────────────────────────────────── the liquidation map

export function liquidationMap(positions, { markPrice, binWidth = BIN, range = RANGE } = {}) {
  const nBins = Math.round((2 * range) / binWidth)
  const bins = Array.from({ length: nBins }, (_, i) => ({ from: -range + i * binWidth, to: -range + (i + 1) * binWidth, long: zeroBy(), short: zeroBy() }))
  const side = { long: { mapped: zeroBy(), unmapped: zeroBy(), anomalies: 0, beyond: 0, count: 0 }, short: { mapped: zeroBy(), unmapped: zeroBy(), anomalies: 0, beyond: 0, count: 0 } }
  const mark = markPrice ?? positions.find((p) => p.markPrice)?.markPrice ?? null
  for (const p of positions) {
    const s = side[p.side]
    if (!s) continue
    s.count++
    if (p.liquidationPrice === null || !mark) { s.unmapped[p.cohort] += p.notionalUsd; continue }
    const d = p.liquidationPrice / mark - 1
    if ((p.side === 'long' && d >= 0) || (p.side === 'short' && d <= 0)) { s.anomalies += p.notionalUsd; continue }
    if (Math.abs(d) >= range) { s.beyond += p.notionalUsd; s.mapped[p.cohort] += p.notionalUsd; continue }
    const i = Math.min(nBins - 1, Math.max(0, Math.floor((d + range) / binWidth)))
    bins[i][p.side][p.cohort] += p.notionalUsd
    s.mapped[p.cohort] += p.notionalUsd
  }
  const total = (o) => COHORTS.reduce((a, c) => a + o[c], 0)
  const summarise = (which) => {
    const sgn = which === 'long' ? -1 : 1 // longs liquidate below the mark, shorts above
    const mapped = total(side[which].mapped), unmapped = total(side[which].unmapped)
    const within = {}, byCohort = Object.fromEntries(COHORTS.map((c) => [c, {}]))
    for (const t of LIQ_THRESHOLDS) {
      let n = 0
      const per = zeroBy()
      for (const b of bins) {
        const inside = which === 'long' ? b.from >= -t && b.to <= 0 : b.from >= 0 && b.to <= t
        if (!inside) continue
        for (const c of COHORTS) { n += b[which][c]; per[c] += b[which][c] }
      }
      within[`w${Math.round(t * 100)}`] = { notional: r0(n), share: mapped > 0 ? r4(n / mapped) : null }
      for (const c of COHORTS) byCohort[c][`w${Math.round(t * 100)}`] = { notional: r0(per[c]), share: side[which].mapped[c] > 0 ? r4(per[c] / side[which].mapped[c]) : null }
    }
    let largest = null
    for (const b of bins) {
      const inside = which === 'long' ? b.from >= -0.10 && b.to <= 0 : b.from >= 0 && b.to <= 0.10
      if (!inside) continue
      const n = total(b[which])
      if (n > 0 && (!largest || n > largest.notional)) largest = { from: r4(b.from), to: r4(b.to), notional: r0(n), share: mapped > 0 ? r4(n / mapped) : null, byCohort: Object.fromEntries(COHORTS.map((c) => [c, r0(b[which][c])])) }
    }
    return { direction: sgn < 0 ? 'below the mark' : 'above the mark', count: side[which].count, mapped: r0(mapped), unmapped: r0(unmapped), anomalies: r0(side[which].anomalies), beyondRange: r0(side[which].beyond), mappedByCohort: Object.fromEntries(COHORTS.map((c) => [c, r0(side[which].mapped[c])])), within, byCohort, largest }
  }
  return {
    markPrice: mark, binWidth, range,
    bins: bins.filter((b) => total(b.long) > 0 || total(b.short) > 0).map((b) => ({ from: r4(b.from), to: r4(b.to), long: Object.fromEntries(COHORTS.map((c) => [c, r0(b.long[c])])), short: Object.fromEntries(COHORTS.map((c) => [c, r0(b.short[c])])) })),
    long: summarise('long'), short: summarise('short'),
  }
}

// ───────────────────────────────────────────────────────────── the crowding index

export function crowding({ positions, screener }) {
  const by = {}
  for (const c of [...COHORTS, 'all']) by[c] = { longsUsd: 0, shortsUsd: 0, longs: 0, shorts: 0, levLongW: 0, levShortW: 0 }
  for (const p of positions) {
    for (const c of [p.cohort, 'all']) {
      const o = by[c]
      if (p.side === 'long') { o.longsUsd += p.notionalUsd; o.longs++; if (p.leverage) o.levLongW += p.leverage * p.notionalUsd }
      else { o.shortsUsd += p.notionalUsd; o.shorts++; if (p.leverage) o.levShortW += p.leverage * p.notionalUsd }
    }
  }
  const captured = {}
  for (const c of Object.keys(by)) {
    const o = by[c]
    captured[c] = { longsUsd: r0(o.longsUsd), shortsUsd: r0(o.shortsUsd), longs: o.longs, shorts: o.shorts, skew: r4(skewOf(o.longsUsd, o.shortsUsd)), levLong: o.longsUsd > 0 ? r4(o.levLongW / o.longsUsd) : null, levShort: o.shortsUsd > 0 ? r4(o.levShortW / o.shortsUsd) : null }
  }
  const sm = screener?.sm ? { ...screener.sm, skew: r4(skewOf(screener.sm.longsUsd, screener.sm.shortsUsd)) } : null
  const whale = screener?.whale ? { ...screener.whale, skew: r4(skewOf(screener.whale.longsUsd, screener.whale.shortsUsd)) } : null
  const publicFigure = screener?.publicFigure ? { ...screener.publicFigure, skew: r4(skewOf(screener.publicFigure.longsUsd, screener.publicFigure.shortsUsd)) } : null
  // the crowd is everyone who is not smart money, so the divergence is not damped by smart money's own positions
  const restL = by.all.longsUsd - by.smart_money.longsUsd, restS = by.all.shortsUsd - by.smart_money.shortsUsd
  captured.crowd = { longsUsd: r0(restL), shortsUsd: r0(restS), longs: by.all.longs - by.smart_money.longs, shorts: by.all.shorts - by.smart_money.shorts, skew: r4(skewOf(restL, restS)), levLong: restL > 0 ? r4((by.all.levLongW - by.smart_money.levLongW) / restL) : null, levShort: restS > 0 ? r4((by.all.levShortW - by.smart_money.levShortW) / restS) : null }
  const smSkew = sm?.skew ?? captured.smart_money.skew
  const crowdSkew = captured.crowd.skew
  const capturedNotional = by.all.longsUsd + by.all.shortsUsd
  const oi = screener?.openInterest ?? null
  return {
    sm, whale, publicFigure, captured,
    smSkew, crowdSkew, divergence: smSkew !== null && crowdSkew !== null ? r4(smSkew - crowdSkew) : null,
    pressureRatio: screener?.volume ? r4((screener.pressure ?? 0) / screener.volume) : null,
    funding: screener?.funding ?? null, fundingAnnualised: screener?.funding !== null && screener?.funding !== undefined ? r4(screener.funding * 24 * 365) : null,
    openInterest: oi, markPrice: screener?.markPrice ?? null, volume: screener?.volume ?? null, traderCount: screener?.traderCount ?? null,
    capturedNotional: r0(capturedNotional), coverage: oi ? r4(capturedNotional / (2 * oi)) : null,
    coverageNote: 'captured notional over BOTH sides of the book divided by twice open interest (an exchange counts open interest on one side); labelled pulls are complete, the all-traders pull is capped to the largest positions, so coverage is what the map is weighted on',
  }
}

// ───────────────────────────────────────────────────────────── the tape

const actionDelta = (side, action, v) => {
  const a = String(action ?? '').toLowerCase()
  const s = a.includes('long') ? 'long' : a.includes('short') ? 'short' : side
  const opens = a.includes('open') || a.includes('add'), closes = a.includes('close') || a.includes('reduce')
  const sign = opens ? 1 : closes ? -1 : 0
  return { long: s === 'long' ? sign * v : 0, short: s === 'short' ? sign * v : 0, kind: opens ? 'open/add' : closes ? 'close/reduce' : 'other' }
}
export const tradeKey = (t) => `${t.txHash}|${t.address}|${t.market}|${t.action}|${t.amount}|${t.atIso}`

export function aggregateTape(trades, { sinceMs = 0, market = null } = {}) {
  const per = new Map()
  for (const t of trades) {
    if (market && t.market !== market) continue
    if (t.atIso && Date.parse(t.atIso) < sinceMs) continue
    const o = per.get(t.market) ?? { market: t.market, trades: 0, notional: 0, longDelta: 0, shortDelta: 0, byKind: {}, traders: new Map() }
    const d = actionDelta(t.side, t.action, t.valueUsd ?? 0)
    o.trades++; o.notional += t.valueUsd ?? 0; o.longDelta += d.long; o.shortDelta += d.short
    o.byKind[`${d.kind} ${d.long ? 'long' : d.short ? 'short' : t.side ?? '?'}`] = (o.byKind[`${d.kind} ${d.long ? 'long' : d.short ? 'short' : t.side ?? '?'}`] ?? 0) + (t.valueUsd ?? 0)
    const tr = o.traders.get(t.address) ?? { address: t.address, label: t.addressLabel, notional: 0, trades: 0 }
    tr.notional += t.valueUsd ?? 0; tr.trades++; o.traders.set(t.address, tr)
    per.set(t.market, o)
  }
  return [...per.values()].map((o) => ({ market: o.market, trades: o.trades, notional: r0(o.notional), longDelta: r0(o.longDelta), shortDelta: r0(o.shortDelta), net: r0(o.longDelta - o.shortDelta), byKind: Object.fromEntries(Object.entries(o.byKind).map(([k, v]) => [k, r0(v)])), topTraders: [...o.traders.values()].sort((a, b) => b.notional - a.notional).slice(0, 5).map((t) => ({ ...t, notional: r0(t.notional) })) })).sort((a, b) => b.notional - a.notional)
}

// ───────────────────────────────────────────────────────────── derive

export function loadSeries(ledgerDir) {
  const p = join(ledgerDir, 'derived', 'series.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}
export function loadTape(ledgerDir) {
  const p = join(ledgerDir, 'derived', 'tape.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}
export function loadLatest(ledgerDir) {
  const p = join(ledgerDir, 'derived', 'latest.json')
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}
export function loadMap(ledgerDir, sampleId, market) {
  const p = join(ledgerDir, 'derived', 'maps', sampleId, `${market}.json.gz`)
  return existsSync(p) ? gzRead(p) : null
}

/** the screener rows of one sample, merged across trader types, keyed by market */
function screenerOf(rows, ledgerDir, sampleId) {
  const out = new Map()
  for (const r of rows) {
    if (r.pass !== 'screener' || !r.raw) continue
    const page = gzRead(join(ledgerDir, 'raw', sampleId, `${r.raw}.json.gz`))
    for (const row of page.data ?? []) {
      const s = readScreenerRow(row, r.label)
      if (!s.market) continue
      const cur = out.get(s.market) ?? { market: s.market, markPrice: null, funding: null, openInterest: null, volume: null, pressure: null, traderCount: null, previousPrice: null, sm: null, whale: null, publicFigure: null }
      if (r.label === 'all') Object.assign(cur, { markPrice: s.markPrice, funding: s.funding, openInterest: s.openInterest, volume: s.volume, pressure: s.pressure, traderCount: s.traderCount, previousPrice: s.previousPrice })
      else if (r.label === 'sm') { cur.sm = s.sm; cur.markPrice ??= s.markPrice; cur.funding ??= s.funding; cur.openInterest ??= s.openInterest }
      else if (r.label === 'whale') cur.whale = s.labelled
      else if (r.label === 'public_figure') cur.publicFigure = s.labelled
      out.set(s.market, cur)
    }
  }
  return out
}

/**
 * The account as the sampler last saw it: the balance the venue reported on its newest reply, and what the
 * sampler spent in the 24 hours before that. Read from the replies' own headers; null when none reported it.
 */
export function creditsOf(rows) {
  const withRemaining = rows.filter((r) => r?.credits && Number.isFinite(r.credits.remaining) && typeof r.atIso === 'string')
  if (withRemaining.length === 0) return null
  const last = withRemaining.reduce((a, r) => (r.atIso > a.atIso ? r : a))
  const since = Date.parse(last.atIso) - 24 * HOUR_MS
  const spent24h = rows.filter((r) => typeof r.atIso === 'string' && Date.parse(r.atIso) > since).reduce((a, r) => a + (Number.isFinite(r.credits?.used) ? r.credits.used : Number.isFinite(r.credits?.cost) ? r.credits.cost : 0), 0)
  return { remaining: last.credits.remaining, atIso: last.atIso, spentLast24h: spent24h, calls: rows.length }
}

/**
 * A compact recent history for whoever reads the ledger from outside (a console, a dashboard, a second agent):
 * for every market with a positions row in the last seven days, one point per positions sample with the scalars
 * people look at. Small enough to ship every hour; the full series stays in series.jsonl.
 */
export function recentOf(series, latest, days = 7) {
  const newest = series.reduce((a, r) => (r.atIso > a ? r.atIso : a), '')
  const since = newest ? Date.parse(newest) - days * 24 * HOUR_MS : 0
  const markets = {}
  for (const r of series) {
    if (r.kind !== 'positions' || Date.parse(r.atIso) < since) continue
    ;(markets[r.market] ??= []).push({ sampleId: r.sampleId, mark: r.mark, funding: r.funding, fundingAnnualised: r.fundingAnnualised, oi: r.oi, smSkew: r.smSkew, crowdSkew: r.crowdSkew, divergence: r.divergence, coverage: r.coverage, liqBelow5: r.liq?.below?.w5 ?? null, liqAbove5: r.liq?.above?.w5 ?? null })
  }
  for (const m of Object.keys(markets)) markets[m].sort((a, b) => a.sampleId.localeCompare(b.sampleId))
  return { kind: 'assay-hl-recent', generatedAtIso: new Date().toISOString(), days, asOf: latest.asOf, credits: latest.credits ?? null, markets }
}

const HOUR_MS = 3_600_000

export function derive({ ledgerDir, all = false, say = () => {} }) {
  const derivedDir = join(ledgerDir, 'derived')
  mkdirSync(join(derivedDir, 'maps'), { recursive: true })
  const { ok, all: allRows } = loadSamples(ledgerDir)
  const bySample = new Map()
  for (const r of ok.values()) { if (!bySample.has(r.sampleId)) bySample.set(r.sampleId, []); bySample.get(r.sampleId).push(r) }
  const sampleIds = [...bySample.keys()].sort()
  const series = all ? [] : loadSeries(ledgerDir)
  const have = new Set(series.map((r) => `${r.sampleId}|${r.market}`))
  if (all && existsSync(join(derivedDir, 'series.jsonl'))) writeFileSync(join(derivedDir, 'series.jsonl'), '')
  const tape = all ? [] : loadTape(ledgerDir)
  const tapeKeys = new Set(tape.map(tradeKey))
  if (all && existsSync(join(derivedDir, 'tape.jsonl'))) writeFileSync(join(derivedDir, 'tape.jsonl'), '')
  const latest = loadLatest(ledgerDir) ?? { asOf: { screener: null, positions: null, tape: null }, markets: {} }
  if (all) latest.markets = {}
  let newRows = 0, newTrades = 0

  for (const sampleId of sampleIds) {
    const rows = bySample.get(sampleId)
    const screener = screenerOf(rows, ledgerDir, sampleId)
    const hasScreener = rows.some((r) => r.pass === 'screener')
    const posRows = rows.filter((r) => r.pass === 'positions' && r.raw)
    const markets = [...new Set(posRows.map((r) => r.market))]
    if (hasScreener && (!latest.asOf.screener || sampleId >= latest.asOf.screener)) latest.asOf.screener = sampleId
    // markets with positions this sample → full row; screener-only markets → a lighter row (funding, OI, sm book) so the series is hourly where positions are 4-hourly
    const screenerOnly = hasScreener ? [...screener.keys()].filter((m) => !markets.includes(m)) : []
    for (const m of [...markets, ...screenerOnly]) {
      if (have.has(`${sampleId}|${m}`)) continue
      const sc = screener.get(m) ?? null
      let row
      if (markets.includes(m)) {
        const pagesByLabel = {}
        for (const r of posRows.filter((x) => x.market === m)) (pagesByLabel[r.label] ??= []).push(gzRead(join(ledgerDir, 'raw', sampleId, `${r.raw}.json.gz`)))
        const { positions, overlaps, labelled } = unionPositions(pagesByLabel)
        const map = liquidationMap(positions, { markPrice: sc?.markPrice ?? null })
        const cr = crowding({ positions, screener: sc })
        mkdirSync(join(derivedDir, 'maps', sampleId), { recursive: true })
        writeFileSync(join(derivedDir, 'maps', sampleId, `${m}.json.gz`), gzipSync(Buffer.from(JSON.stringify({ sampleId, market: m, positions: positions.length, overlaps, labelled, ...map }))))
        row = {
          sampleId, atIso: new Date(sampleHourMs(sampleId)).toISOString(), market: m, kind: 'positions',
          mark: cr.markPrice ?? map.markPrice, funding: cr.funding, fundingAnnualised: cr.fundingAnnualised, oi: cr.openInterest, volume: cr.volume, pressureRatio: cr.pressureRatio, traderCount: cr.traderCount,
          sm: cr.sm, whale: cr.whale, publicFigure: cr.publicFigure, crowd: cr.captured.crowd, all: cr.captured.all, capturedByCohort: { smart_money: cr.captured.smart_money, public_figure: cr.captured.public_figure, whale: cr.captured.whale, other: cr.captured.other },
          smSkew: cr.smSkew, crowdSkew: cr.crowdSkew, divergence: cr.divergence, coverage: cr.coverage, capturedNotional: cr.capturedNotional, positions: positions.length,
          liq: {
            below: { ...Object.fromEntries(Object.entries(map.long.within).map(([k, v]) => [k, v.share])), largest: map.long.largest, mapped: map.long.mapped, unmappedShare: map.long.mapped + map.long.unmapped > 0 ? r4(map.long.unmapped / (map.long.mapped + map.long.unmapped)) : null, smartMoney: map.long.byCohort.smart_money },
            above: { ...Object.fromEntries(Object.entries(map.short.within).map(([k, v]) => [k, v.share])), largest: map.short.largest, mapped: map.short.mapped, unmappedShare: map.short.mapped + map.short.unmapped > 0 ? r4(map.short.unmapped / (map.short.mapped + map.short.unmapped)) : null, smartMoney: map.short.byCohort.smart_money },
          },
        }
        if (!latest.asOf.positions || sampleId >= latest.asOf.positions) latest.asOf.positions = sampleId
      } else {
        const cr = crowding({ positions: [], screener: sc })
        row = { sampleId, atIso: new Date(sampleHourMs(sampleId)).toISOString(), market: m, kind: 'screener', mark: cr.markPrice, funding: cr.funding, fundingAnnualised: cr.fundingAnnualised, oi: cr.openInterest, volume: cr.volume, pressureRatio: cr.pressureRatio, traderCount: cr.traderCount, sm: cr.sm, whale: cr.whale, publicFigure: cr.publicFigure, smSkew: cr.sm?.skew ?? null }
      }
      appendFileSync(join(derivedDir, 'series.jsonl'), JSON.stringify(row) + '\n')
      series.push(row); have.add(`${sampleId}|${m}`); newRows++
      const prev = latest.markets[m]
      if (!prev || prev.sampleId <= sampleId) {
        // a screener-only row never overwrites a fuller positions row from the same or an earlier hour's map; it refreshes the shared scalars
        latest.markets[m] = row.kind === 'positions' || !prev || prev.kind !== 'positions' ? row : { ...prev, mark: row.mark, funding: row.funding, fundingAnnualised: row.fundingAnnualised, oi: row.oi, volume: row.volume, pressureRatio: row.pressureRatio, traderCount: row.traderCount, sm: row.sm ?? prev.sm, smSkew: row.smSkew ?? prev.smSkew, screenerSampleId: sampleId }
      }
    }
    // the tape: every trade from every lookback page, de-duplicated
    for (const r of rows.filter((x) => x.pass === 'tape' && x.raw)) {
      const page = gzRead(join(ledgerDir, 'raw', sampleId, `${r.raw}.json.gz`))
      for (const row of page.data ?? []) {
        const t = readPerpTradeRow(row)
        if (!t.txHash || !t.market) continue
        const k = tradeKey(t)
        if (tapeKeys.has(k)) continue
        tapeKeys.add(k); tape.push(t); newTrades++
        appendFileSync(join(derivedDir, 'tape.jsonl'), JSON.stringify(t) + '\n')
      }
      if (!latest.asOf.tape || sampleId >= latest.asOf.tape) latest.asOf.tape = sampleId
    }
  }
  latest.generatedAtIso = new Date().toISOString()
  latest.samples = sampleIds.length
  latest.seriesRows = series.length
  latest.tapeTrades = tape.length
  latest.credits = creditsOf(allRows)
  writeFileSync(join(derivedDir, 'latest.json'), JSON.stringify(latest, null, 2))
  writeFileSync(join(derivedDir, 'recent.json'), JSON.stringify(recentOf(series, latest), null, 2))
  say(`  derived: ${newRows} new series rows (${series.length} total), ${newTrades} new trades (${tape.length} total), ${sampleIds.length} samples; latest positions ${latest.asOf.positions ?? '—'}, screener ${latest.asOf.screener ?? '—'}, tape ${latest.asOf.tape ?? '—'}`)
  return { newRows, newTrades, series, tape, latest }
}

if (process.argv[1]?.endsWith('hl-derive.mjs')) {
  const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d }
  derive({ ledgerDir: process.env.HL_LEDGER_DIR ?? argOf('--ledger', 'ledger/hl'), all: process.argv.includes('--all'), say: (s) => console.log(s) })
}
