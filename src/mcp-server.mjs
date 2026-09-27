#!/usr/bin/env node
/**
 * ASSAY MCP SERVER — a calibrated signal source for any agent.
 *
 * ── THE ONE DESIGN RULE ──────────────────────────────────────────────────────
 *
 * This server will not hand an agent a raw signal.
 *
 * `assay_signal_now` returns a signal ONLY with its measured prior attached, and
 * if that cohort-horizon has never been assayed it returns a refusal instead of
 * a number. That is not caution for its own sake. An agent given "smart money is
 * accumulating SOL" has no way to size it, so it does what every agent does with
 * an unquantified signal: it treats confidence as edge. Five sources light up,
 * the agent reads five confirmations, and it takes its largest position on its
 * least independent information.
 *
 * A prior fixes that at the root. `{ netMeanBps: 34, sdBps: 88, n: 412 }` goes
 * straight into a Kelly or a Bayesian sizer and produces a position, and if the
 * standard error is wide the position is small without anyone having to
 * remember to be careful.
 *
 * ── WHAT AN AGENT GETS ───────────────────────────────────────────────────────
 *
 *   assay_prior          the calibrated prior for a cohort at a horizon
 *   assay_leaderboard    every cohort-horizon pair, ranked, with the two-verdict
 *                        split and the Bonferroni bar that produced it
 *   assay_signal_now     today's live signals (from `assay now`) + their priors, or a refusal
 *   assay_now            RUN the live pull: today's flows, each joined to its prior and a decision
 *                        (spends credits; needs NANSEN_API_KEY in the server's environment)
 *   assay_explain        the reading in prose, for an agent that must justify
 *                        itself to a human
 *   assay_lookahead      what a multi-day window of the historical flow summary returns
 *   hl_*                 Hyperliquid positioning; hl_refresh RUNS a light live pass (spends credits)
 *
 * Zero dependencies: JSON-RPC 2.0 over stdio, hand-rolled. A judge can clone and
 * run this in one command with no install step, and an agent stack can adopt it
 * without inheriting a tree.
 *
 * No tool here can place an order or move a balance. Two tools spend Nansen credits
 * (assay_now, hl_refresh); each has a hard per-call credit cap and writes only under
 * its own ledger directory.
 */

import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HL_TOOLS, callHlTool } from './hl-tools.mjs'

/** paths resolve against the repository, so the server works from any working directory */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LEDGER_DIR = process.env.ASSAY_LEDGER_DIR ?? join(ROOT, 'ledger', 'study')
/** where `assay now` writes today's signals (and assay_now, from here) */
const LIVE_DIR = process.env.ASSAY_LIVE_DIR ?? join(LEDGER_DIR, '..', 'live')
/** a hard cap on what one agent call may spend, whatever it asks for */
const MAX_CREDITS_PER_CALL = Number(process.env.ASSAY_MAX_CREDITS_PER_CALL ?? 500)
/** the Hyperliquid positioning ledger the sampler keeps (src/hl-sample.mjs); read-only here */
const HL_LEDGER_DIR = process.env.HL_LEDGER_DIR ?? join(LEDGER_DIR, '..', 'hl')
const VERDICTS = join(LEDGER_DIR, 'verdicts.json')
const STUDY = join(LEDGER_DIR, 'study.json')

function loadStudy() {
  if (!existsSync(STUDY)) return null
  try { return JSON.parse(readFileSync(STUDY, 'utf8')) } catch { return null }
}

const TOOLS = [
  {
    name: 'assay_prior',
    description:
      'Return the measured, cost-adjusted prior for one Nansen Smart Money cohort at one horizon: mean edge in bps, its standard error, sample size, p-value and the multiplicity-adjusted bar it was judged against. This is the number to size on. Returns a refusal, never a guess, if the pair has not been assayed.',
    inputSchema: {
      type: 'object',
      properties: {
        cohort: { type: 'string', description: 'one of the six measured segments: "Whale", "Public Figure", "Top PnL", "Smart Trader", "Exchange", "Fresh Wallets"' },
        horizonHours: { type: 'number', description: 'holding period the prior applies to, e.g. 24, 48, 168' },
      },
      required: ['cohort', 'horizonHours'],
    },
  },
  {
    name: 'assay_leaderboard',
    description:
      'Every cohort-horizon pair that has been assayed, ranked by net edge after costs. Each carries one of four verdicts: economic (real and tradeable), fail-economic (real but costs eat it), fail-signal (no predictive content beyond drift), insufficient (too few matured pairs to say). The count of REAL-BUT-COSTLY signals is usually the most actionable number here.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'assay_signal_now',
    description:
      'Today\'s live Nansen flow signals for one segment (as written by the last `assay now` or assay_now run), each returned ONLY with the prior the study measured for that segment and horizon, and a decision: trade (sized on the standard error), hold (real but priced out), skip (no edge beyond drift) or refuse (never measured). If the segment-horizon has no assay, this returns a refusal rather than an uncalibrated signal, because an unquantified signal inflates an agent\'s confidence without inflating its edge.',
    inputSchema: {
      type: 'object',
      properties: {
        cohort: { type: 'string', description: '"Whale", "Public Figure", "Top PnL", "Smart Trader", "Exchange" or "Fresh Wallets"' },
        horizonHours: { type: 'number', description: '24, 48 or 168' },
        subject: { type: 'string', description: 'optional token symbol filter' },
      },
      required: ['cohort', 'horizonHours'],
    },
  },
  {
    name: 'assay_lookahead',
    description:
      'What a multi-day window of Nansen\'s historical-token-flow-summary actually returns, measured on 12,756 calls: it is NOT the sum of daily calls over the same days (for fresh_wallets it is exactly the last day; for the other five segments no rebuild from daily calls reproduces it). Per segment, with the audit\'s verdicts. Anyone building a backtest on that endpoint with a multi-date range should read this first.',
    inputSchema: { type: 'object', properties: { window: { type: 'string', description: '"weekly" or "monthly" — the one-call window compared against the same window summed from daily calls' } }, required: [] },
  },
  {
    name: 'assay_now',
    description:
      'RUN the live pull now: one Nansen call per token for the last complete UTC day (the historical flow summary, the exact call the study measured), the study\'s rules to turn flows into signals ($250k or more, the ten strongest per segment, direction by sign), and every signal joined to its measured prior and a decision. Spends about 5 credits per token (100 for the default 20 tokens), capped per call. Needs NANSEN_API_KEY in the MCP server\'s environment. Writes live-signals.json, which assay_signal_now then serves.',
    inputSchema: {
      type: 'object',
      properties: {
        tokens: { type: 'string', description: 'optional comma-separated symbols from the universe, e.g. "WETH,PEPE"; default all' },
        date: { type: 'string', description: 'optional YYYY-MM-DD; default the last complete UTC day' },
        maxCredits: { type: 'number', description: 'budget for this call; default 150, never above the server cap' },
      },
      required: [],
    },
  },
  {
    name: 'assay_explain',
    description:
      'The plain-language reading for a cohort-horizon: what was measured, against what control, at what bar, and what the verdict does and does not license. For an agent that has to justify a position to a person.',
    inputSchema: {
      type: 'object',
      properties: { cohort: { type: 'string' }, horizonHours: { type: 'number' } },
      required: ['cohort', 'horizonHours'],
    },
  },
]

function loadVerdicts() {
  if (!existsSync(VERDICTS)) return null
  try { return JSON.parse(readFileSync(VERDICTS, 'utf8')) } catch { return null }
}

/** ABSENT IS NOT EMPTY. A missing ledger is said out loud, never rendered as "no edge". */
const NO_LEDGER = {
  refused: true,
  reason:
    'No assay ledger found. This is ABSENCE, not a negative result: nothing has been measured yet, which is a different fact from "measured and found nothing". The repository ships the measured study at ledger/study; point ASSAY_LEDGER_DIR at it, or run your own study (node src/study.mjs, then node src/score-study.mjs).',
  ledgerPath: VERDICTS,
}

function findVerdict(v, cohort, horizonHours) {
  return v?.results?.find(
    (r) => r.provenance?.cohort === cohort && Number(r.provenance?.horizonHours) === Number(horizonHours),
  ) ?? null
}

async function callTool(name, args) {
  if (name === 'assay_now') return runAssayNow(args ?? {})
  if (name === 'hl_refresh') return runHlRefresh(args ?? {})
  if (name.startsWith('hl_')) return callHlTool(name, args, HL_LEDGER_DIR)
  const v = loadVerdicts()

  if (name === 'assay_lookahead') {
    const st = loadStudy()
    if (!st || !st.leak) return { refused: true, reason: 'No study ledger with a window comparison. Run the live study (src/study.mjs) and score it (src/score-study.mjs) first. Absence, not a negative result.' }
    const w = (args?.window ?? 'weekly').toLowerCase()
    const l = st.leak[w]
    if (!l) return { refused: true, reason: `no ${w} comparison in the study; available: ${Object.keys(st.leak).filter((k) => k !== 'note' && k !== 'naiveFlow').join(', ')}` }
    /**
     * The window audit (src/audit-convention.mjs) rebuilt every one-call window
     * from the daily series and found that the one-call value is NOT the sum of
     * its days for five of six segments, and is exactly the last day for
     * `fresh_wallets`. So the comparison below measures "one call ≠ the sum of
     * its days", not label look-ahead, and is served under that name. The
     * audit's verdicts travel with it when the file is present.
     */
    const AUDIT = join(LEDGER_DIR, 'convention-audit.json')
    let audit = null
    try { if (existsSync(AUDIT)) audit = JSON.parse(readFileSync(AUDIT, 'utf8')) } catch { audit = null }
    const verdicts = audit?.arms?.[w] ? Object.fromEntries(Object.entries(audit.arms[w].segments).map(([seg, v]) => [seg, v.best ? { verdict: v.best.verdict, bestRebuild: v.best.rebuild, withinFivePercentShare: v.best.score, inclusiveSpearman: v.rebuilds?.inclusive?.spearman ?? null } : null])) : null
    return {
      window: w, asOf: st.asOf, universe: st.universe, convention: st.convention?.verdict ?? null,
      headline: 'A multi-day window from historical-token-flow-summary is NOT the sum of daily calls over the same days. Ask at the resolution you will act on; do not sum short windows into long ones or compare one-call windows with summed dailies.',
      whatWasCompared: `each ${w} window's flow as the venue returns it in ONE call against the SAME window built by summing one call per day. The prereg called the difference label look-ahead; the window audit showed the premise (same aggregation, different resolution) does not hold for this endpoint, so the numbers below are "one call vs the sum of its days" and are not to be quoted as leak.`,
      audit: audit ? { verdicts, freshWallets: 'the one-call value for any window is bit-identical to the last day of the window (1,957 of 1,957 pairs)', otherSegments: 'no rebuild — inclusive, end-exclusive, shifted a day, trailing or leading K days, first or last day, the mean — reproduces the one-call value within 5% on more than ~8% of pairs; the one-call value tracks the trailing 2–7 days better than the full range', file: 'AUDIT-CONVENTION.md' } : { note: 'convention-audit.json not found beside the study; run src/audit-convention.mjs' },
      flowLevelDisagreement: l.flow, verdictLevelDifference: { note: 'paired difference in excess between tournaments run on the two quantities; NOT a leak measurement', rows: l.verdict },
      wholeRange: st.leak.naiveFlow ? { note: 'the whole range in one call vs the daily sum, flow level only (one row per token)', flow: st.leak.naiveFlow } : null,
    }
  }

  if (name === 'assay_leaderboard') {
    if (!v) return NO_LEDGER
    return {
      asOf: v.asOf,
      source: v.arm ? `nansen live study, ${v.arm} arm, look-ahead bound ${v.lookAheadBoundDays ?? '?'} day(s)` : 'replay',
      searchCount: v.searchCount,
      bonferroniBar: v.searchCount ? 0.05 / v.searchCount : null,
      summary: v.summary,
      ranked: (v.ranked ?? []).map((r) => ({
        cohort: r.provenance.cohort,
        horizonHours: r.provenance.horizonHours,
        verdict: r.verdict,
        netMeanBps: r.prior?.netMeanBps ?? null,
        standardErrorBps: r.prior?.standardErrorBps ?? null,
        n: r.provenance.matured,
        pValue: r.prior?.pValue ?? null,
      })),
      note: 'Ranked by net edge after costs. A high rank with a wide standard error is not a recommendation; read n and the SE together.',
    }
  }

  const { cohort, horizonHours } = args ?? {}

  if (name === 'assay_prior') {
    if (!v) return NO_LEDGER
    const r = findVerdict(v, cohort, horizonHours)
    if (!r) {
      return {
        refused: true,
        reason: `No assay exists for cohort '${cohort}' at ${horizonHours}h. Not measured is not the same as no edge, and this tool will not supply a number it has not earned.`,
        available: (v.results ?? []).map((x) => `${x.provenance.cohort} @ ${x.provenance.horizonHours}h`),
      }
    }
    if (!r.prior) {
      return { refused: true, reason: r.reason ?? 'assayed but no prior issued', verdict: r.verdict, provenance: r.provenance }
    }
    return {
      ...r.prior,
      verdict: r.verdict,
      asOf: v.asOf,
      source: v.arm ? `nansen live study, ${v.arm} arm, look-ahead bound ${v.lookAheadBoundDays ?? '?'} day(s), spec ${v.specHash}` : `replay, spec ${v.specHash}`,
      usage:
        r.prior.tradeable
          ? 'Size on netMeanBps with sdBps as the dispersion and standardErrorBps as the uncertainty about the mean. Both belong in the denominator of any Kelly fraction; using the mean alone overbets. ' +
            'standardErrorBps is the BLOCK-BOOTSTRAP standard error and is the only one to size on — iidStandardErrorBps is published beside it purely so the gap is visible, and on these overlapping observations it understates uncertainty by varianceInflation. Size on the iid figure and you overbet by that factor. ' +
            'effectiveN, not n, is what this sample is worth in independent observations; use it anywhere a sample size enters a posterior.'
          : 'NOT tradeable at this horizon. The prior is published so it can be combined, tracked, or re-tested at another horizon — not so it can be sized.',
    }
  }

  if (name === 'assay_explain') {
    if (!v) return NO_LEDGER
    const r = findVerdict(v, cohort, horizonHours)
    if (!r) return { refused: true, reason: `no assay for '${cohort}' @ ${horizonHours}h` }
    return {
      cohort, horizonHours,
      verdict: r.verdict,
      reading: r.reading ?? r.reason,
      provenance: r.provenance,
      detail: r.detail,
      whatThisDoesNotLicense:
        r.verdict === 'fail-economic'
          ? 'It does not license abandoning the cohort. The signal is real; the cost structure eats it at THIS horizon. A longer horizon, a cheaper venue, or a passive expression are all untested and all live.'
          : r.verdict === 'economic'
            ? 'It does not license full-Kelly size. The standard error is the honest bound on conviction, and the edge was measured in one regime.'
            : r.verdict === 'fail-signal'
              ? 'It does not license the reverse trade. Failing to predict is not predicting the opposite.'
              : 'It licenses nothing. Too few matured pairs to say anything at all.',
    }
  }

  if (name === 'assay_signal_now') {
    if (!v) return NO_LEDGER
    const r = findVerdict(v, cohort, horizonHours)
    if (!r || !r.prior) {
      return {
        refused: true,
        reason:
          `Refusing to return an uncalibrated signal for '${cohort}' @ ${horizonHours}h. A signal without a measured prior cannot be sized, and an agent handed one will treat confidence as edge. Assay this pair first.`,
      }
    }
    const livePath = join(LIVE_DIR, 'live-signals.json')
    const live = existsSync(livePath) ? JSON.parse(readFileSync(livePath, 'utf8')) : null
    if (!live) {
      return {
        refused: true,
        reason: `No live pull at ${livePath}. Run \`node src/now.mjs\` (or the assay_now tool) with a Nansen key first. The prior below stands either way.`,
        prior: r.prior, verdict: r.verdict,
      }
    }
    const signals = (live.signals ?? []).filter(
      (s) => s.cohort === cohort && (!args.subject || String(s.subject).toUpperCase() === String(args.subject).toUpperCase()),
    )
    return {
      date: live.date ?? null, asOf: live.asOf ?? null,
      signals: signals.map((s) => {
        const h = (s.horizons ?? []).find((x) => Number(x.horizonHours) === Number(horizonHours)) ?? null
        return { subject: s.subject, chain: s.chain, direction: s.direction, flowUsd: s.flowUsd, requestId: s.requestId ?? null, ...(h ? { action: h.action, fraction: h.fraction, why: h.why } : {}), ...(s.note ? { note: s.note } : {}) }
      }),
      count: signals.length,
      note:
        signals.length === 0
          ? 'No live signal for this segment in the latest pull. That is a quiet segment, not a missing feed; the prior below still stands for when one appears.'
          : 'Each signal carries the decision its measured prior licenses at this horizon. Size on the prior, not on the signal.',
      prior: r.prior,
      verdict: r.verdict,
      source: live.source ?? null,
    }
  }

  return { refused: true, reason: `unknown tool '${name}'` }
}

// ───────────────────────────────────────────────── the two tools that spend credits

const keyOrRefusal = () => (process.env.NANSEN_API_KEY
  ? null
  : { refused: true, reason: 'NANSEN_API_KEY is not set in this MCP server\'s environment, so nothing live can be pulled. The measured priors (assay_prior, assay_leaderboard, assay_explain) need no key. To enable live pulls, add NANSEN_API_KEY to the server\'s env in your MCP client config.' })
const capped = (x, dflt) => Math.max(1, Math.min(Number.isFinite(Number(x)) ? Number(x) : dflt, MAX_CREDITS_PER_CALL))

async function runAssayNow(args) {
  const no = keyOrRefusal(); if (no) return no
  const { NansenClient } = await import('./nansen.mjs')
  const { runNow, loadUniverse, lastCompleteDay } = await import('./now.mjs')
  const verdicts = loadVerdicts(); if (!verdicts) return NO_LEDGER
  const date = typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : lastCompleteDay(Date.now())
  const universe = loadUniverse({ priorsDir: LEDGER_DIR, tokens: typeof args.tokens === 'string' ? args.tokens : null })
  const client = new NansenClient({ apiKey: process.env.NANSEN_API_KEY, creditBudget: capped(args.maxCredits, 150), tier: process.env.NANSEN_TIER ?? 'free', remainingFloor: Number(process.env.ASSAY_RESERVE ?? 5000) })
  mkdirSync(LIVE_DIR, { recursive: true })
  const out = await runNow({ client, date, universe, verdicts, onCall: (c) => appendFileSync(join(LIVE_DIR, 'calls.jsonl'), JSON.stringify(c) + '\n') })
  const spend = client.spendReport()
  out.spend = { calls: spend.calls, creditsSpent: spend.creditsSpent, accountRemaining: client.accountRemaining ?? null }
  writeFileSync(join(LIVE_DIR, 'live-signals.json'), JSON.stringify(out, null, 2))
  return { date: out.date, summary: out.summary, universe: out.universe, priors: out.priors, spend: out.spend, signals: out.signals.map((s) => ({ segment: s.cohort, subject: s.subject, direction: s.direction, flowUsd: s.flowUsd, horizons: s.horizons.map((h) => ({ horizonHours: h.horizonHours, verdict: h.verdict, netMeanBps: h.prior?.netMeanBps ?? null, standardErrorBps: h.prior?.standardErrorBps ?? null, action: h.action, fraction: h.fraction })) })), source: out.source }
}

async function runHlRefresh(args) {
  const no = keyOrRefusal(); if (no) return no
  const { NansenClient } = await import('./nansen.mjs')
  const { Sampler, sampleIdFor } = await import('./hl-sample.mjs')
  const { derive } = await import('./hl-derive.mjs')
  const markets = Math.max(1, Math.min(Number(args.markets ?? 3) || 3, 5))
  const client = new NansenClient({ apiKey: process.env.NANSEN_API_KEY, creditBudget: capped(args.maxCredits, 120), tier: process.env.NANSEN_TIER ?? 'free', remainingFloor: Number(process.env.ASSAY_RESERVE ?? 5000) })
  mkdirSync(HL_LEDGER_DIR, { recursive: true })
  const s = new Sampler({ client, ledgerDir: HL_LEDGER_DIR, sampleId: sampleIdFor(Date.now()), intervalHours: 1 })
  let stopped = null
  try {
    await s.screener()
    const top = (await s.rankMarkets({ n: markets })).map((r) => r.market)
    await s.positions({ markets: top, topPositions: 1000 })
  } catch (e) { stopped = e instanceof Error ? e.message : String(e) }
  derive({ ledgerDir: HL_LEDGER_DIR })
  const rep = s.report()
  return { spend: { calls: rep.callsMade, reused: rep.callsReused, creditsSpent: rep.creditsSpent, accountRemaining: rep.accountRemaining }, ...(stopped ? { stopped } : {}), status: callHlTool('hl_status', {}, HL_LEDGER_DIR), crowding: callHlTool('hl_crowding', {}, HL_LEDGER_DIR) }
}

// ───────────────────────────────────────────────── JSON-RPC 2.0 over stdio

function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n') }
function respondError(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n') }

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    const { id, method, params } = msg

    if (method === 'initialize') {
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'assay', version: '0.4.0' },
        instructions:
          'Assay returns measured priors for six Nansen flow segments (assay_*: a pre-registered 12,781-call study; no key needed to read them), today\'s live signals each joined to its prior and a decision (assay_now runs the pull; assay_signal_now serves it), and the sampled state of labelled positioning on Hyperliquid perps (hl_*: liquidation maps by holder, smart-money-versus-crowd crowding with funding, the smart-money tape; hl_refresh runs a light live pass). Every number carries its sample, its age and its provenance. It refuses to return a signal it has not calibrated and reports an unsampled market as absence: a refusal means "not measured", which is different from "measured and found empty". Powered by Nansen API.',
      })
    } else if (method === 'tools/list') {
      respond(id, { tools: [...TOOLS, ...HL_TOOLS] })
    } else if (method === 'tools/call') {
      Promise.resolve()
        .then(() => callTool(params?.name, params?.arguments ?? {}))
        .then((out) => respond(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: false }))
        .catch((e) => {
          const msg = String(e instanceof Error ? e.message : e).replaceAll(process.env.NANSEN_API_KEY || '\u0000', '[redacted]')
          respond(id, { content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true })
        })
    } else if (method === 'notifications/initialized' || method?.startsWith('notifications/')) {
      // notifications carry no id and expect no reply
    } else if (id !== undefined) {
      respondError(id, -32601, `method not found: ${method}`)
    }
  }
})
