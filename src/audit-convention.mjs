#!/usr/bin/env node
/**
 * audit-convention.mjs — what does a multi-day window actually return?
 *
 * The score report's leak tables say a week asked for in ONE call differs from
 * the same week built from SEVEN daily calls by several times the flow's own
 * size, for every segment — `exchange` included, whose membership should barely
 * move inside a week. The prereg attributes that difference to label
 * look-ahead. Before the number is published under that name, this audit asks
 * the ledger what the one-call value actually IS, by rebuilding it from the
 * daily series in every plausible way and reporting which rebuild it matches:
 *
 *   inclusive     sum d[from..to]        the convention the run assumed
 *   to-exclusive  sum d[from..to-1]      `to` outside the window
 *   shift+1       sum d[from+1..to+1]    a daily call really answers for the day after
 *   shift-1       sum d[from-1..to-1]    … or the day before
 *   last-day      d[to]                  the range is ignored; only date_to's day
 *   first-day     d[from]
 *   mean-daily    mean d[from..to]       it is an average, not a sum
 *   trail-K       sum d[to-K+1..to]      the range is silently capped to K days at the end
 *   lead-K        sum d[from..from+K-1]  … or at the start
 *
 * A rebuild MATCHES when the one-call value lands within 5% of it on nearly
 * every pair; nothing weaker counts, because a rebuild that is merely smaller
 * than the one-call value scores a flattering |W−R|/|W| near 100% without
 * matching anything. So the ranking is by the share of pairs within 5% — read
 * on the NON-ZERO pairs when there are ten or more, because a sparse segment is
 * mostly both-zero and those match trivially — and a segment whose best rebuild
 * is under half is reported as NO MATCH.
 *
 * Two scales for the disagreement, because one of them collapses. |W−R|/|W|
 * is the report's own ratio; for exchange flow a week's NET is a small residual
 * of large two-way GROSS flow, so a small membership drift is a large fraction
 * of it. |W−R|/Σ|d| divides by the daily gross instead. Medians are shown
 * beside means because flows are heavy-tailed.
 *
 * Also: the sign-agreement rate where both sides clear the study's threshold,
 * the rank correlation of W and R, the disagreement by token and by period,
 * and the lag-1 autocorrelation of the daily series (a trailing 7-day window
 * would show ~0.85; a true daily series, near 0).
 *
 * Reads calls.jsonl only. No key. Writes convention-audit.json beside it.
 *
 *   node src/audit-convention.mjs --ledger ledger/study
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HISTORICAL_SEGMENTS, SEGMENT_LABEL } from './nansen.mjs'
import { SIGNAL_SPEC } from './forecast.mjs'

const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d }
const LEDGER_DIR = argOf('--ledger', 'ledger/study')
const OUT = argOf('--out', join(LEDGER_DIR, 'convention-audit.json'))
/** pairs whose one-call value is smaller than this (USD) are left out of the /|W| ratio only */
const MIN_ABS = Number(argOf('--min-abs', '1000'))
const MIN_FLOW = SIGNAL_SPEC.minFlowUsd
const MATCH_TOL = 0.05

const DAY = 86_400_000
const iso = (ms) => new Date(ms).toISOString().slice(0, 10)
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`)
const addDays = (d, n) => iso(dayMs(d) + n * DAY)
const daysOf = (from, to) => { const out = []; for (let t = dayMs(from); t <= dayMs(to); t += DAY) out.push(iso(t)); return out }
const spanOf = (w) => Math.round((dayMs(w.toDate) - dayMs(w.fromDate)) / DAY) + 1

// ───────────────────────────────────────────────────────────── statistics

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
function ranks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0])
  const r = new Array(xs.length)
  for (let i = 0; i < idx.length;) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++
    const avg = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg
    i = j + 1
  }
  return r
}
function pearson(xs, ys) {
  const n = xs.length
  if (n < 3) return null
  const mx = mean(xs), my = mean(ys)
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null
}
const spearman = (xs, ys) => pearson(ranks(xs), ranks(ys))
const lag1 = (xs) => (xs.length < 10 ? null : pearson(xs.slice(0, -1), xs.slice(1)))

// ───────────────────────────────────────────────────────────── the ledger

export function loadLedger(ledgerDir) {
  const path = join(ledgerDir, 'calls.jsonl')
  if (!existsSync(path)) throw new Error(`no calls.jsonl under ${ledgerDir}`)
  const byKey = new Map()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let r
    try { r = JSON.parse(line) } catch { continue }
    if (r.state === 'ok' && r.segments) byKey.set(r.key, r) // the newest ok row per key wins, as the scorer reads it
  }
  const rows = [...byKey.values()]
  const daily = new Map() // token → Map(date → segments)
  for (const r of rows) {
    if (r.arm !== 'daily') continue
    const k = `${r.chain}|${r.address}`
    if (!daily.has(k)) daily.set(k, new Map())
    daily.get(k).set(r.window.toDate, r.segments)
  }
  return { rows, daily }
}

/** the value of one segment on one day, or null when the day is absent or the venue returned null */
const dayValue = (series, date, seg) => {
  const s = series.get(date)
  if (!s) return null
  const v = s[seg]?.netFlowUsd
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
const sumDays = (series, days, seg) => { let t = 0; for (const d of days) { const v = dayValue(series, d, seg); if (v === null) return null; t += v } return t }
const grossDays = (series, days, seg) => { let t = 0; for (const d of days) { const v = dayValue(series, d, seg); if (v === null) return null; t += Math.abs(v) } return t }

/** the rebuilds tried for an arm; trail/lead lengths run up to the arm's window length */
export function rebuildsFor(arm) {
  const fixed = {
    'inclusive': (s, w, seg) => sumDays(s, daysOf(w.fromDate, w.toDate), seg),
    'to-exclusive': (s, w, seg) => (w.fromDate === w.toDate ? null : sumDays(s, daysOf(w.fromDate, addDays(w.toDate, -1)), seg)),
    'shift+1': (s, w, seg) => sumDays(s, daysOf(addDays(w.fromDate, 1), addDays(w.toDate, 1)), seg),
    'shift-1': (s, w, seg) => sumDays(s, daysOf(addDays(w.fromDate, -1), addDays(w.toDate, -1)), seg),
    'last-day': (s, w, seg) => dayValue(s, w.toDate, seg),
    'first-day': (s, w, seg) => dayValue(s, w.fromDate, seg),
    'mean-daily': (s, w, seg) => { const days = daysOf(w.fromDate, w.toDate); const t = sumDays(s, days, seg); return t === null ? null : t / days.length },
  }
  const Ks = arm === 'weekly' ? [2, 3, 4, 5, 6] : arm === 'monthly' ? [2, 3, 4, 5, 6, 7, 10, 14, 21] : [2, 3, 5, 7, 14, 30, 90]
  for (const K of Ks) {
    fixed[`trail-${K}`] = (s, w, seg) => (spanOf(w) <= K ? null : sumDays(s, daysOf(addDays(w.toDate, -(K - 1)), w.toDate), seg))
    fixed[`lead-${K}`] = (s, w, seg) => (spanOf(w) <= K ? null : sumDays(s, daysOf(w.fromDate, addDays(w.fromDate, K - 1)), seg))
  }
  return fixed
}
export const FIXED_REBUILDS = ['inclusive', 'to-exclusive', 'shift+1', 'shift-1', 'last-day', 'first-day', 'mean-daily']

// ───────────────────────────────────────────────────────────── the audit

function periodOf(date) { return date < '2025-07-01' ? '2025-H1' : date < '2026-01-01' ? '2025-H2' : '2026' }

export function audit({ rows, daily }) {
  const out = {
    arms: {}, lag1: {},
    note: `W = the one-call value; R = the rebuild from daily calls. relW = |W−R|/|W| (pairs with |W| ≥ ${MIN_ABS}); relG = |W−R|/Σ|d| over the inclusive window. signAgree over pairs where both |W| and |R| ≥ ${MIN_FLOW}. within = |W−R| ≤ ${MATCH_TOL * 100}% of max(|W|,|R|), both-zero pairs count as within. best = the rebuild with the highest within share; verdict MATCH ≥ 0.9, PARTIAL ≥ 0.5, else NO MATCH.`,
  }
  for (const arm of ['weekly', 'monthly', 'naive']) {
    const called = rows.filter((r) => r.arm === arm)
    if (!called.length) continue
    const armOut = { windows: called.length, segments: {} }
    const rebuilds = rebuildsFor(arm)
    for (const seg of HISTORICAL_SEGMENTS) {
      const segOut = { rebuilds: {}, reportStyle: null, byToken: {}, byPeriod: {} }
      for (const [name, rebuild] of Object.entries(rebuilds)) {
        const relW = [], relG = [], Ws = [], Rs = []
        let n = 0, bothAbove = 0, agree = 0, within = 0, bothZero = 0
        const perToken = {}, perPeriod = {}
        let sumAbsDiff = 0, sumAbsW = 0
        for (const c of called) {
          const series = daily.get(`${c.chain}|${c.address}`)
          if (!series) continue
          const W = c.segments?.[seg]?.netFlowUsd
          if (typeof W !== 'number' || !Number.isFinite(W)) continue
          const R = rebuild(series, c.window, seg)
          if (R === null) continue
          n++
          const diff = Math.abs(W - R)
          sumAbsDiff += diff; sumAbsW += Math.abs(W)
          Ws.push(W); Rs.push(R)
          if (W === 0 && R === 0) bothZero++
          const scale = Math.max(Math.abs(W), Math.abs(R))
          if (scale > 0 && diff <= MATCH_TOL * scale) within++
          if (Math.abs(W) >= MIN_ABS) {
            const v = diff / Math.abs(W)
            relW.push(v)
            ;(perToken[c.symbol] ??= []).push(v)
            ;(perPeriod[periodOf(c.window.toDate)] ??= []).push(v)
          }
          const g = grossDays(series, daysOf(c.window.fromDate, c.window.toDate), seg)
          if (g !== null && g > 0) relG.push(diff / g)
          if (Math.abs(W) >= MIN_FLOW && Math.abs(R) >= MIN_FLOW) { bothAbove++; if (Math.sign(W) === Math.sign(R)) agree++ }
        }
        segOut.rebuilds[name] = {
          pairs: n,
          relW: { n: relW.length, median: median(relW), mean: mean(relW) },
          relG: { n: relG.length, median: median(relG), mean: mean(relG) },
          spearman: spearman(Ws, Rs),
          signAgree: { n: bothAbove, rate: bothAbove ? agree / bothAbove : null },
          within: n ? (within + bothZero) / n : null,
          nonZeroPairs: n - bothZero,
          withinNonZero: n - bothZero ? within / (n - bothZero) : null,
        }
        if (name === 'inclusive') {
          // the report's own ratio, recomputed on the same pairs: mean|Δ| / mean|W|
          segOut.reportStyle = { pairs: n, relativeMove: n && sumAbsW > 0 ? (sumAbsDiff / n) / (sumAbsW / n) : null }
          for (const [t, v] of Object.entries(perToken)) segOut.byToken[t] = { n: v.length, medianRelW: median(v) }
          for (const [p, v] of Object.entries(perPeriod)) segOut.byPeriod[p] = { n: v.length, medianRelW: median(v) }
        }
      }
      // both-zero pairs match trivially and a sparse segment is mostly both-zero, so the verdict is read on the
      // non-zero pairs whenever there are ten or more of them; `within` (all pairs) is kept beside it
      const score = (s) => (s.nonZeroPairs >= 10 ? s.withinNonZero : s.within)
      const ranked = Object.entries(segOut.rebuilds).filter(([, s]) => s.pairs >= 3 && score(s) !== null).sort((a, b) => score(b[1]) - score(a[1]))
      if (ranked.length) {
        const [name, s] = ranked[0]
        const sc = score(s)
        segOut.best = { rebuild: name, within: s.within, withinNonZero: s.withinNonZero, scoredOn: s.nonZeroPairs >= 10 ? 'non-zero pairs' : 'all pairs', score: sc, medianRelW: s.relW.median, verdict: sc >= 0.9 ? 'MATCH' : sc >= 0.5 ? 'PARTIAL' : 'NO MATCH' }
      } else segOut.best = null
      armOut.segments[seg] = segOut
    }
    out.arms[arm] = armOut
  }
  // lag-1 autocorrelation of the daily series, per segment: median across tokens
  const symbolOf = new Map(rows.map((r) => [`${r.chain}|${r.address}`, `${r.chain}:${r.symbol}`]))
  for (const seg of HISTORICAL_SEGMENTS) {
    const per = {}
    for (const [tok, series] of daily) {
      const xs = []
      for (const d of [...series.keys()].sort()) { const v = dayValue(series, d, seg); if (v !== null) xs.push(v) }
      const r = lag1(xs)
      if (r !== null) per[symbolOf.get(tok) ?? tok] = +r.toFixed(3)
    }
    out.lag1[seg] = { medianAcrossTokens: median(Object.values(per)), tokens: per }
  }
  return out
}

// ───────────────────────────────────────────────────────────── the print

const pct = (v, d = 1) => (v === null || v === undefined ? '—' : (v * 100).toFixed(d) + '%')
const num = (v, d = 2) => (v === null || v === undefined ? '—' : v.toFixed(d))

export function print(result) {
  for (const [arm, a] of Object.entries(result.arms)) {
    console.log(`\n  ${arm.toUpperCase()} — ${a.windows} one-call windows, rebuilt from the daily series`)
    for (const seg of HISTORICAL_SEGMENTS) {
      const s = a.segments[seg]
      if (!s) continue
      const rs = s.reportStyle
      console.log(`\n  ${SEGMENT_LABEL[seg] ?? seg} — ${s.best ? `${s.best.verdict}: best rebuild ${s.best.rebuild}, within ${pct(MATCH_TOL, 0)} on ${pct(s.best.score)} of ${s.best.scoredOn}` : 'no rebuild computable'}   (report-style |Δ|/|flow|, inclusive: ${pct(rs?.relativeMove)} over ${rs?.pairs ?? 0} pairs)`)
      console.log(`  ${'rebuild'.padEnd(13)} ${'pairs'.padStart(6)} ${'within5%'.padStart(9)} ${'≠0 pairs'.padStart(8)} ${'within≠0'.padStart(9)} ${'med relW'.padStart(9)} ${'med relG'.padStart(9)} ${'spearman'.padStart(9)} ${'sign-agree'.padStart(11)} ${'(n)'.padStart(6)}`)
      const names = [...FIXED_REBUILDS]
      // the best trail-K and lead-K only, so the table stays readable; every K is in the JSON
      for (const fam of ['trail', 'lead']) {
        const best = Object.entries(s.rebuilds).filter(([k, v]) => k.startsWith(fam + '-') && v.pairs >= 3).sort((x, y) => y[1].within - x[1].within)[0]
        if (best) names.push(best[0])
      }
      for (const name of names) {
        const st = s.rebuilds[name]
        if (!st || !st.pairs) continue
        const mark = s.best?.rebuild === name ? ' ◀' : ''
        console.log(`  ${name.padEnd(13)} ${String(st.pairs).padStart(6)} ${pct(st.within).padStart(9)} ${String(st.nonZeroPairs).padStart(8)} ${pct(st.withinNonZero).padStart(9)} ${pct(st.relW.median).padStart(9)} ${pct(st.relG.median).padStart(9)} ${num(st.spearman).padStart(9)} ${pct(st.signAgree.rate).padStart(11)} ${String(st.signAgree.n).padStart(6)}${mark}`)
      }
      if (arm !== 'naive') {
        const bt = Object.entries(s.byToken).sort((x, y) => x[1].medianRelW - y[1].medianRelW)
        if (bt.length) console.log(`  by token (inclusive, median relW): ${bt.map(([t, v]) => `${t} ${pct(v.medianRelW, 0)}`).join('  ')}`)
        const bp = Object.entries(s.byPeriod).sort()
        if (bp.length) console.log(`  by period (inclusive, median relW): ${bp.map(([p, v]) => `${p} ${pct(v.medianRelW, 0)} (n=${v.n})`).join('  ')}`)
      }
    }
  }
  console.log(`\n  LAG-1 AUTOCORRELATION of the daily series (median across tokens; a trailing 7-day window would read ≈0.85)`)
  for (const seg of HISTORICAL_SEGMENTS) console.log(`  ${(SEGMENT_LABEL[seg] ?? seg).padEnd(14)} ${num(result.lag1[seg]?.medianAcrossTokens, 3)}`)
  console.log(`\n  VERDICTS`)
  for (const [arm, a] of Object.entries(result.arms)) console.log(`  ${arm.padEnd(8)} ${HISTORICAL_SEGMENTS.map((seg) => `${seg}: ${a.segments[seg]?.best ? `${a.segments[seg].best.verdict} (${a.segments[seg].best.rebuild} ${pct(a.segments[seg].best.score, 0)})` : '—'}`).join('  ')}`)
}

if (process.argv[1]?.endsWith('audit-convention.mjs')) {
  const ledger = loadLedger(LEDGER_DIR)
  console.log(`\n  CONVENTION AUDIT — ${ledger.rows.length} ok rows, ${ledger.daily.size} tokens with a daily series, from ${LEDGER_DIR}`)
  const result = audit(ledger)
  print(result)
  writeFileSync(OUT, JSON.stringify(result, null, 2))
  console.log(`\n  written: ${OUT}\n`)
}
