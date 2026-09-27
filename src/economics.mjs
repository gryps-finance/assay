/**
 * ECONOMICS — the step the demo was missing.
 *
 * Everything else in this repo produces a PRIOR. A prior is an input to a
 * decision, not a decision, and a tool that stops there has asked the reader to
 * take the last step on faith. This file takes it: given a set of measured
 * priors and a cost, what does an agent actually make?
 *
 * ── THE THREE AGENTS ─────────────────────────────────────────────────────────
 *
 *   ungated   Takes every signal the feed emits, at a fixed size. This is not a
 *             straw man. It is what an agent does today, because "smart money
 *             is accumulating SOL" carries no number to gate on — so the agent
 *             trades its confidence, and its confidence is the same for a
 *             cohort with an 80 bps edge and one with 4.
 *
 *   gated     Same signals, same fixed size, but only where the pair cleared a
 *             multiplicity-adjusted bar AND clears cost. The only difference
 *             from `ungated` is that someone measured. No better data, no
 *             cleverer model — a filter.
 *
 *   sized     Gated, and then sized by fractional Kelly on the measured prior
 *             rather than by a fixed fraction. This is what a prior is FOR: a
 *             number with an error bar can set a position, and a badge cannot.
 *
 * ── WHY THE DENOMINATOR HAS TWO TERMS ────────────────────────────────────────
 *
 * Kelly is edge over variance, and the variance an agent faces is not just the
 * dispersion of outcomes — it also includes how wrong the estimate of the mean
 * could be. So the denominator is sd² + se², the posterior predictive variance.
 * Using sd alone overbets by ignoring estimation error; using the mean alone
 * overbets catastrophically. And because `se` here is the BLOCK-bootstrap error,
 * which knows the observations overlap, this is the one place in the pipeline
 * where the correction in assay.mjs turns into fewer dollars at risk.
 *
 * Quarter-Kelly, not full. Full Kelly is the growth-optimal bet for someone who
 * knows the true distribution, and nobody here knows the true distribution —
 * they know a sample of it.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
 *
 * This is a closed-form expectation, not a backtest. It does not model slippage
 * beyond the flat cost, capacity, borrow, funding, or the correlation between
 * simultaneous positions — every one of which makes the real number worse. Read
 * it as the arithmetic of the decision, not as a P&L anyone earned.
 */

export const BOOK = Object.freeze({
  /** the notional an agent is working with, stated so every figure is checkable */
  equityUsd: 100_000,
  /** what a flat-sizing agent puts on per signal, as a fraction of equity */
  flatFraction: 0.10,
  /** Kelly is for someone who knows the distribution; we have a sample of it */
  kellyFraction: 0.25,
  /** no single position may exceed this share of the book, whatever Kelly says */
  maxFraction: 0.25,
})

/**
 * Fractional-Kelly position size from a measured prior.
 *
 * All three inputs are in bps and converted once, here, because mixing bps and
 * return fractions in a Kelly expression is the unit error that produces a
 * confident answer three orders of magnitude wrong.
 */
export function kellySize({ netMeanBps, sdBps, standardErrorBps }, cfg = BOOK) {
  const mu = netMeanBps / 1e4
  const varOutcome = (sdBps / 1e4) ** 2
  const varEstimate = (standardErrorBps / 1e4) ** 2
  const predVar = varOutcome + varEstimate
  if (!(predVar > 0)) return { fraction: 0, note: 'no dispersion estimate — refusing to size' }
  const full = mu / predVar
  const fraction = Math.max(0, Math.min(cfg.maxFraction, full * cfg.kellyFraction))
  return {
    fraction: +fraction.toFixed(5),
    fullKellyFraction: +full.toFixed(5),
    cappedByMax: full * cfg.kellyFraction > cfg.maxFraction,
    note: 'quarter-Kelly on the posterior predictive variance (outcome dispersion + estimation error), capped',
  }
}

/** Non-overlapping trades per year at a given holding period. */
export const tradesPerYear = (horizonHours) => 8760 / horizonHours

/**
 * Score the three agents over one set of measured pairs at one cost.
 *
 * `pairs` carry the COST-INVARIANT measurement — excess, sd, se, p — and the
 * cost is applied here, so this function is the only place the two meet. That
 * separation is the same one the verdicts rest on: the signal is measured once,
 * the economics are evaluated per cost.
 */
export function agents({ pairs, costRtBps, adjustedAlpha, cfg = BOOK }) {
  const withNet = pairs.map((p) => ({
    ...p,
    netBps: p.excessMeanBps - costRtBps,
    isReal: p.pValue !== null && p.pValue <= adjustedAlpha && p.excessMeanBps > 0,
  }))

  /** expected dollars per trade and per year for one pair at one size fraction */
  const leg = (p, fraction) => {
    const perTradeUsd = fraction * cfg.equityUsd * (p.netBps / 1e4)
    return {
      ...p,
      fraction,
      perTradeUsd,
      perYearUsd: perTradeUsd * tradesPerYear(p.horizonHours),
      notionalUsd: fraction * cfg.equityUsd,
    }
  }

  const build = (selected, sizer, name, rationale) => {
    const legs = selected.map((p) => leg(p, sizer(p)))
    const perYearUsd = legs.reduce((s, l) => s + l.perYearUsd, 0)
    const traded = legs.filter((l) => l.fraction > 0)
    return {
      name,
      rationale,
      pairsTraded: traded.length,
      /** the average is over TRADED pairs; averaging in pairs it declined would
       *  flatter a selective agent for the trades it did not make */
      avgNetBps: traded.length ? +(traded.reduce((s, l) => s + l.netBps, 0) / traded.length).toFixed(1) : 0,
      avgNotionalUsd: traded.length ? Math.round(traded.reduce((s, l) => s + l.notionalUsd, 0) / traded.length) : 0,
      perYearUsd: Math.round(perYearUsd),
      perYearPct: +((perYearUsd / cfg.equityUsd) * 100).toFixed(1),
      legs: legs.map((l) => ({
        cohort: l.cohort, horizonHours: l.horizonHours,
        netBps: +l.netBps.toFixed(1), fraction: +l.fraction.toFixed(4),
        perYearUsd: Math.round(l.perYearUsd),
      })),
    }
  }

  const ungated = build(
    withNet, () => cfg.flatFraction, 'ungated',
    'Takes every signal at a flat 10% of the book. No measurement, so no way to tell an 80 bps cohort from a 4 bps one.',
  )
  const gatedSet = withNet.filter((p) => p.isReal && p.netBps > 0)
  const gated = build(
    gatedSet, () => cfg.flatFraction, 'gated',
    'Same signals, same flat 10%, but only where the pair cleared the adjusted bar and clears cost. The only added ingredient is a measurement.',
  )
  const sized = build(
    gatedSet,
    (p) => kellySize({ netMeanBps: p.netBps, sdBps: p.sdBps, standardErrorBps: p.standardErrorBps }, cfg).fraction,
    'sized',
    'Gated, then sized by quarter-Kelly on the measured prior — edge over (outcome variance + estimation error), capped at 25% of the book.',
  )

  return {
    costRtBps,
    equityUsd: cfg.equityUsd,
    ungated,
    gated,
    sized,
    /** the number the whole tool is arguing for */
    gatingWorthUsdPerYear: gated.perYearUsd - ungated.perYearUsd,
    caveat:
      'Closed-form expectation over measured priors, not a backtest. Ignores slippage beyond the flat cost, capacity, funding, and correlation between simultaneous positions — each of which makes the real figure worse.',
  }
}
