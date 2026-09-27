/**
 * ASSAY — the scoring core.
 *
 * Pure. No network, no clock, no files. Give it forecasts and outcomes, get back
 * a calibrated prior an agent can size on. Everything else in this repo exists
 * to feed this file or to serve what it returns.
 *
 * ── THE PROBLEM ──────────────────────────────────────────────────────────────
 *
 * On-chain analytics tells you what happened: smart money accumulated SOL, a
 * fund opened a perp, a cohort rotated. Every one of those is a fact, and none
 * of them is a number you can size a position on.
 *
 * The missing step is the one every other field does automatically. A weather
 * service does not say "the pressure is falling"; it says "70% chance of rain",
 * and you can check whether it rains 70% of the time when it says so. A signal
 * without a track record is a story. A signal with one is an instrument.
 *
 * ── THE DISTINCTION THAT MATTERS MOST ────────────────────────────────────────
 *
 * Assay always returns TWO verdicts, never one, because the industry's habit of
 * collapsing them destroys information:
 *
 *   fail-signal     the cohort's moves do not predict returns. The claim is
 *                   not real. Stop.
 *
 *   fail-economic   the cohort's moves DO predict returns, significantly, and
 *                   the edge does not survive trading costs at this horizon.
 *                   The signal is real. The trade is not — yet. Try a longer
 *                   horizon, a cheaper venue, or a passive expression.
 *
 * Those are opposite instructions and they are routinely reported with the same
 * word. The distinction is not a nicety: a real signal killed as "no edge" is a
 * discovery thrown away, and a costed-out signal reported as "works" is a slow
 * bleed with a chart attached.
 *
 * ── PAIRED EXCESS, AND WHY THE CONTROL IS THE WHOLE TEST ─────────────────────
 *
 * Crypto tokens drift together. A cohort that bought anything in a week the
 * market rose looks prescient, and a measurement that does not subtract the
 * drift is measuring the market. So every forecast is paired with a DRIFT-
 * MATCHED CONTROL: the same token, the same direction, the same holding period,
 * entered at a randomly chosen time nearby. The excess
 *
 *     E = mean(signal return) − mean(control return)
 *
 * is what survives that subtraction. E is the signal's claim on reality. The
 * raw return is not.
 *
 * The control seed is fixed and recorded. Re-rolling a control after seeing the
 * result is the oldest way to manufacture an edge, so the seed travels with the
 * verdict and a changed seed makes it a different study.
 *
 * ── WHAT THIS FILE REFUSES TO DO ─────────────────────────────────────────────
 *
 *  · It never fills a missing outcome. An unmatured forecast is pending, not
 *    zero, and pending rows are excluded and COUNTED, never silently dropped.
 *  · It never reports a point estimate without its uncertainty. The standard
 *    error travels with every mean, and `sizeableAs()` returns a distribution,
 *    not a number.
 *  · It never claims significance it has not adjusted for. If you assayed
 *    twelve cohort-horizon pairs, the bar is Bonferroni-adjusted for twelve and
 *    the adjustment is printed next to the verdict.
 *  · It never hides a small n behind a big number. n travels with everything.
 */

/**
 * @typedef {object} Forecast
 * @property {string} id
 * @property {string} cohort            which label cohort emitted this (e.g. 'Smart Trader')
 * @property {string} subject           the token/symbol the claim is about
 * @property {'long'|'short'} direction what the cohort's flow implies
 * @property {string} atIso             when the signal was observed — BEFORE the outcome exists
 * @property {number} horizonHours
 * @property {number} strength          the cohort's conviction, in whatever the source's units
 * @property {number} entryPriceUsd
 */

/**
 * @typedef {object} Outcome
 * @property {string} forecastId
 * @property {number|null} exitPriceUsd     null = did not mature or price unavailable
 * @property {number|null} controlReturnBps null = the drift-matched control could not be formed
 * @property {string} maturedAtIso
 * @property {string} [note]
 */

export const DEFAULTS = Object.freeze({
  /** measured round-trip cost in bps. Default is a liquid perp taker round trip. */
  costRtBps: 12,
  /** below this many matured pairs, no verdict is issued at all */
  minMatured: 30,
  /** family-wise alpha before multiplicity adjustment */
  alpha: 0.05,
  /** a cohort must clear cost by this margin to be called economic, not just positive */
  economicMarginBps: 0,
})

// ───────────────────────────────────────────────────────────── statistics

const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length
const sd = (x) => {
  if (x.length < 2) return NaN
  const m = mean(x)
  return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1))
}

/** Abramowitz-Stegun normal CDF, plenty for a t of this size at these n */
export function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989423 * Math.exp((-z * z) / 2)
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return z > 0 ? 1 - p : p
}

/**
 * Memo for the block bootstrap.
 *
 * `blockBootstrap` is pure and seeded, so the same series at the same seed
 * returns the same answer however many times it is asked. A caller sweeping a
 * COST — which the bootstrap does not depend on at all — would otherwise pay for
 * two thousand resamples per step, which is how a demonstrable claim becomes an
 * unrunnable one. The key is a cheap fingerprint of the series rather than the
 * series itself, and the map is bounded, because an unbounded cache in a library
 * is a memory leak with a performance story attached.
 */
const bootstrapMemo = new Map()
const BOOTSTRAP_MEMO_MAX = 256
function seriesFingerprint(series, K, seed) {
  // n, the exact sum, and a position-weighted sum: two different orderings of
  // the same multiset give different keys, which matters for a BLOCK bootstrap
  let sum = 0, weighted = 0
  for (let i = 0; i < series.length; i++) { sum += series[i]; weighted += series[i] * (i + 1) }
  return `${series.length}|${sum}|${weighted}|${K}|${seed}`
}

/**
 * CIRCULAR BLOCK BOOTSTRAP — one pass, two answers.
 *
 * Returns both the H0 p-value and the standard error of the mean, because they
 * come from the same resampling and separating them is how the second one ends
 * up wrong.
 *
 * ── WHY BLOCKS, AND WHY IT IS NOT OPTIONAL HERE ──────────────────────────────
 *
 * These observations are nowhere near independent. Passes are hourly, horizons
 * are 24 to 168 hours, and the same handful of tokens recur — so consecutive
 * rows share almost their entire holding period and much of their price path. An
 * iid standard error, sd/sqrt(n), silently assumes each of those rows is a fresh
 * draw on reality. It is not. It is the same week, counted again.
 *
 * The consequence is not academic. sd/sqrt(n) on overlapping rows can understate
 * the true uncertainty several-fold, and an agent that puts an understated
 * uncertainty in the denominator of a Kelly fraction does not make a small
 * mistake — it overbets by that same factor, in the exact place this project
 * exists to prevent. So the standard error that ships in a prior is this one,
 * and the iid figure travels beside it only so the deflation is visible.
 *
 * ── WHY ONE PASS GIVES BOTH ──────────────────────────────────────────────────
 *
 * Centring the series under H0 shifts every resampled mean by the same constant,
 * which moves the location of the bootstrap distribution and leaves its spread
 * untouched. So the spread of the centred draws is the standard error of the
 * uncentred mean, exactly, and the tail count of the same draws is the p-value.
 * Drawing twice would cost twice as much and answer no better.
 *
 * @returns {{p:number, seBps:number, iidSeBps:number, effectiveN:number,
 *            varianceInflation:number, block:number, K:number}|null}
 */
export function blockBootstrap(series, { K = 2000, seed = 20260916 } = {}) {
  const n = series.length
  if (n < 2) return null
  const memoKey = seriesFingerprint(series, K, seed)
  if (bootstrapMemo.has(memoKey)) return bootstrapMemo.get(memoKey)

  const m = mean(series)
  const block = Math.max(2, Math.round(Math.sqrt(n)))
  const centred = series.map((v) => v - m)
  let s = seed >>> 0
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296)

  let atLeastAsExtreme = 0
  const drawMeans = new Array(K)
  for (let b = 0; b < K; b++) {
    const draw = []
    while (draw.length < n) {
      const start = Math.floor(rand() * n)
      for (let j = 0; j < block && draw.length < n; j++) draw.push(centred[(start + j) % n])
    }
    const dm = mean(draw)
    drawMeans[b] = dm
    if (Math.abs(dm) >= Math.abs(m)) atLeastAsExtreme++
  }

  const p = (atLeastAsExtreme + 1) / (K + 1)
  const seBps = sd(drawMeans)
  const iidSeBps = sd(series) / Math.sqrt(n)
  /**
   * How many INDEPENDENT observations this dependent sample is worth. Reported
   * because "n = 28,686" next to a standard error built from overlapping rows is
   * a true number doing a misleading job, and the honest reply to "how big is
   * your sample" is this one.
   */
  const effectiveN = seBps > 0 ? Math.max(1, Math.round(((sd(series) / seBps) ** 2))) : n
  const out = {
    p,
    seBps: +seBps.toFixed(4),
    iidSeBps: +iidSeBps.toFixed(4),
    effectiveN,
    varianceInflation: +(seBps / iidSeBps).toFixed(2),
    block,
    K,
  }
  if (bootstrapMemo.size >= BOOTSTRAP_MEMO_MAX) bootstrapMemo.delete(bootstrapMemo.keys().next().value)
  bootstrapMemo.set(memoKey, out)
  return out
}

/** The p-value alone, for callers that want nothing else. */
export function bootstrapP(series, opts = {}) {
  const b = blockBootstrap(series, opts)
  return b === null ? null : b.p
}

/**
 * Brier score and a reliability curve.
 *
 * Brier alone hides the thing you most want to know — whether a stated 70% is
 * actually 70%. The curve bins predictions and reports observed frequency per
 * bin, which is what makes a prior trustworthy rather than merely accurate.
 */
export function calibration(pairs, { bins = 5 } = {}) {
  const usable = pairs.filter((p) => Number.isFinite(p.predicted) && (p.actual === 0 || p.actual === 1))
  if (usable.length === 0) return { brier: null, curve: [], n: 0, skipped: pairs.length }
  const brier = mean(usable.map((p) => (p.predicted - p.actual) ** 2))
  const curve = []
  for (let i = 0; i < bins; i++) {
    const lo = i / bins
    const hi = (i + 1) / bins
    const inBin = usable.filter((p) => p.predicted >= lo && (i === bins - 1 ? p.predicted <= hi : p.predicted < hi))
    curve.push({
      binLo: lo,
      binHi: hi,
      n: inBin.length,
      meanPredicted: inBin.length ? +mean(inBin.map((p) => p.predicted)).toFixed(4) : null,
      observedFrequency: inBin.length ? +mean(inBin.map((p) => p.actual)).toFixed(4) : null,
    })
  }
  return { brier: +brier.toFixed(5), curve, n: usable.length, skipped: pairs.length - usable.length }
}

// ─────────────────────────────────────────────────────────────── the assay

/**
 * Score one cohort at one horizon.
 *
 * `searchCount` is the number of cohort-horizon pairs tested in the same study.
 * It is REQUIRED and has no default, because a bar that silently assumes one
 * hypothesis is the single most common way a measured edge turns out to be
 * nothing. Pass the real number even when it is embarrassing.
 */
export function assayCohort({ cohort, horizonHours, forecasts, outcomes, searchCount, opts = {} }) {
  const cfg = { ...DEFAULTS, ...opts }
  if (!Number.isFinite(searchCount) || searchCount < 1) {
    throw new Error('searchCount is required — the multiplicity of the search that produced this verdict is part of the verdict')
  }

  const byId = new Map(outcomes.map((o) => [o.forecastId, o]))
  const pending = []
  const noControl = []
  const rows = []

  for (const f of forecasts) {
    const o = byId.get(f.id)
    if (!o || o.exitPriceUsd === null || o.exitPriceUsd === undefined) { pending.push(f.id); continue }
    if (o.controlReturnBps === null || o.controlReturnBps === undefined) { noControl.push(f.id); continue }
    const sign = f.direction === 'long' ? 1 : -1
    const signalBps = sign * Math.log(o.exitPriceUsd / f.entryPriceUsd) * 1e4
    rows.push({
      id: f.id,
      subject: f.subject,
      signalBps,
      controlBps: o.controlReturnBps,
      excessBps: signalBps - o.controlReturnBps,
      strength: f.strength,
      win: signalBps > 0 ? 1 : 0,
    })
  }

  const n = rows.length
  const provenance = {
    cohort,
    horizonHours,
    forecastsSeen: forecasts.length,
    matured: n,
    pendingCount: pending.length,
    noControlCount: noControl.length,
    searchCount,
    adjustedAlpha: cfg.alpha / searchCount,
    costRtBps: cfg.costRtBps,
    note: 'pending and control-less rows are EXCLUDED and COUNTED — never filled, never silently dropped',
  }

  if (n < cfg.minMatured) {
    return {
      verdict: 'insufficient',
      reason: `${n} matured pairs, below the ${cfg.minMatured} floor. Not a negative result — an absent one.`,
      provenance,
      prior: null,
    }
  }

  const excess = rows.map((r) => r.excessBps)
  const signal = rows.map((r) => r.signalBps)
  const control = rows.map((r) => r.controlBps)

  const eMean = mean(excess)
  const eSd = sd(excess)
  /**
   * One bootstrap, both answers. `boot.seBps` is the standard error that ships,
   * because it is the one that knows these rows overlap; `eIidSe` travels beside
   * it only so the deflation between them is visible rather than assumed away.
   */
  const boot = blockBootstrap(excess, { seed: 20260916 })
  const eIidSe = eSd / Math.sqrt(n)
  const eSe = boot ? boot.seBps : eIidSe
  const eP = boot ? boot.p : null

  const netBps = eMean - cfg.costRtBps
  const signalIsReal = eP !== null && eP <= provenance.adjustedAlpha && eMean > 0
  const clearsCost = netBps > cfg.economicMarginBps

  /**
   * THE TWO-VERDICT RULE. These never collapse into one word.
   */
  let verdict
  let reading
  if (!signalIsReal) {
    verdict = 'fail-signal'
    reading =
      `The cohort's flows do not predict returns beyond drift. Paired excess ${eMean.toFixed(1)} bps, ` +
      `p ${eP === null ? 'n/a' : eP.toFixed(4)} against a bar of ${provenance.adjustedAlpha.toExponential(2)} ` +
      `(Bonferroni over ${searchCount}). This is a claim that did not survive its control.`
  } else if (!clearsCost) {
    verdict = 'fail-economic'
    reading =
      `THE SIGNAL IS REAL AND THE TRADE IS NOT. Paired excess ${eMean.toFixed(1)} bps (p ${eP.toFixed(4)}) ` +
      `does not clear ${cfg.costRtBps} bps of round-trip cost at a ${horizonHours}h horizon; net ${netBps.toFixed(1)} bps. ` +
      `Do not read this as "no edge" — read it as an edge the cost structure eats. A longer horizon, a cheaper ` +
      `venue, or a passive expression are all live options; abandoning the cohort is not indicated.`
  } else {
    verdict = 'economic'
    reading =
      `Paired excess ${eMean.toFixed(1)} bps (p ${eP.toFixed(4)}, bar ${provenance.adjustedAlpha.toExponential(2)}) ` +
      `clears ${cfg.costRtBps} bps of cost with ${netBps.toFixed(1)} bps net at ${horizonHours}h. Tradeable, at a size ` +
      `the standard error justifies and not more.`
  }

  const cal = calibration(rows.map((r) => ({ predicted: 0.5 + Math.tanh(r.strength ?? 0) / 2, actual: r.win })))

  return {
    verdict,
    reading,
    provenance,
    /**
     * THE PRIOR — the deliverable. An agent consumes this, not the prose.
     * Mean and sd are in bps per holding period, net of cost, so it drops
     * straight into a Kelly or a Bayesian sizer with no unit surgery.
     */
    prior: {
      cohort,
      horizonHours,
      netMeanBps: +netBps.toFixed(2),
      sdBps: +eSd.toFixed(2),
      /** block-bootstrap, serial-correlation aware. THIS is the one to size on. */
      standardErrorBps: +eSe.toFixed(2),
      /** sd/sqrt(n). Published only so the gap between it and the real one is visible. */
      iidStandardErrorBps: +eIidSe.toFixed(2),
      /**
       * What this dependent sample is worth in independent observations. A
       * sample of 28,686 overlapping weekly bets is not 28,686 bets, and a
       * report that prints only the first number is technically true and
       * practically a lie.
       */
      effectiveN: boot ? boot.effectiveN : n,
      varianceInflation: boot ? boot.varianceInflation : 1,
      n,
      pValue: eP === null ? null : +eP.toFixed(5),
      adjustedAlpha: provenance.adjustedAlpha,
      tradeable: verdict === 'economic',
      costRtBps: cfg.costRtBps,
    },
    detail: {
      rawSignalMeanBps: +mean(signal).toFixed(2),
      controlMeanBps: +mean(control).toFixed(2),
      excessMeanBps: +eMean.toFixed(2),
      hitRate: +mean(rows.map((r) => r.win)).toFixed(4),
      calibration: cal,
    },
  }
}

/**
 * The tournament: every cohort at every horizon, scored against ONE shared
 * multiplicity count.
 *
 * This is the part most comparisons get wrong. Running six cohorts at three
 * horizons is eighteen hypotheses, and reporting the best of them at an
 * unadjusted 0.05 is how a leaderboard becomes a lottery. `searchCount` is
 * computed here from the grid itself, so it cannot be understated by
 * forgetting.
 */
export function tournament({ cohorts, horizons, forecastsFor, outcomesFor, opts = {} }) {
  const searchCount = cohorts.length * horizons.length
  const results = []
  for (const cohort of cohorts) {
    for (const horizonHours of horizons) {
      results.push(
        assayCohort({
          cohort,
          horizonHours,
          forecasts: forecastsFor(cohort, horizonHours),
          outcomes: outcomesFor(cohort, horizonHours),
          searchCount,
          opts,
        }),
      )
    }
  }

  const ranked = [...results].sort((a, b) => (b.prior?.netMeanBps ?? -Infinity) - (a.prior?.netMeanBps ?? -Infinity))
  const economic = results.filter((r) => r.verdict === 'economic')
  const realButCostly = results.filter((r) => r.verdict === 'fail-economic')

  return {
    searchCount,
    results,
    ranked,
    summary: {
      tested: results.length,
      economic: economic.length,
      realButCostly: realButCostly.length,
      failedSignal: results.filter((r) => r.verdict === 'fail-signal').length,
      insufficient: results.filter((r) => r.verdict === 'insufficient').length,
      /**
       * The headline most reports would never print, and the most useful one
       * here: how many signals are REAL but priced out. That number is the
       * product-development finding, because it is the set a cheaper execution
       * path would convert.
       */
      headline:
        economic.length > 0
          ? `${economic.length} of ${results.length} cohort-horizon pairs are tradeable after costs at a Bonferroni-adjusted bar.`
          : realButCostly.length > 0
            ? `No pair clears costs, but ${realButCostly.length} of ${results.length} carry REAL predictive signal that costs eat. That is a cost problem, not a signal problem.`
            : `No pair carries predictive signal beyond drift at this bar.`,
    },
  }
}
