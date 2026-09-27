#!/usr/bin/env node
/**
 * Build the site from two sources.
 *
 *   docs/index.html      THE TOOL: what `assay now` and `assay positioning` served on
 *                        real runs (docs/live/*.json, the runs' own output), the study's
 *                        priors from ledger/study/sweep.json, and how to run it.
 *                        Source: docs/front.src.html, wearing page.src.html's head.
 *   docs/study.html      THE STUDY: the engine's output over the real Nansen run
 *                        (ledger/study/sweep.json) and the window audit
 *                        (ledger/study/convention-audit.json)
 *   docs/check.html      THE INSTRUMENT CHECK: the same page over the seeded
 *                        synthetic world with a planted answer (docs/sweep.json),
 *                        which is what makes the study's null worth reading
 *   docs/artifact.html   the study page with no skeleton, for a host that supplies one
 *   docs/page.body.html  page.src.html with the fonts inlined (the one editable
 *                        source is page.src.html; this file is its build output)
 *
 * One source, because two hand-kept pages drift, and a demo that drifts from the
 * data it claims to render is worse than no demo. The page decides its mode from
 * the data alone: a sweep with a planted ground truth is the check.
 *
 * The data is INLINED rather than fetched. A fetch fails from a file:// URL and
 * is blocked on a sandboxed host, and a demo that only works behind a web server
 * is a demo a judge does not see.
 *
 *   node docs/build.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const src = readFileSync(join(HERE, 'page.src.html'), 'utf8')
const fonts = readFileSync(join(HERE, 'fonts.switzer.css'), 'utf8')
if (!src.includes('/*__SWITZER__*/')) throw new Error('page.src.html has lost its font placeholder')
const body = src.replace('/*__SWITZER__*/', () => fonts.trim())
writeFileSync(join(HERE, 'page.body.html'), body)

/**
 * The payload sits in a <script type="application/json"> block, so the ONE
 * sequence that can break out of it is a literal `</script`. JSON.stringify
 * cannot produce it inside a string, but a cohort name could, so it is escaped
 * rather than assumed away. `/` parses back to `/`, so the data survives.
 */
const inert = (json) => {
  const out = json.replace(/<\/script/gi, '<\\u002fscript')
  if (/__(SWEEP|AUDIT|LIVE|POS|STUDY)_JSON__/.test(out)) throw new Error('the data contains a placeholder token; refusing to build')
  return out
}

/** the window audit, trimmed to what the page shows: the weekly arm per segment, and fresh_wallets' last-day match across every arm */
function auditSummary() {
  const a = JSON.parse(readFileSync(join(ROOT, 'ledger', 'study', 'convention-audit.json'), 'utf8'))
  const weekly = a.arms.weekly
  const segments = {}
  for (const [k, s] of Object.entries(weekly.segments)) {
    const inc = s.rebuilds.inclusive
    segments[k] = {
      windows: inc.pairs, inclusiveWithin: inc.withinNonZero, inclusiveSpearman: inc.spearman,
      best: s.best.rebuild, bestWithin: s.best.withinNonZero, bestVerdict: s.best.verdict,
    }
  }
  let windows = 0, matched = 0
  for (const arm of Object.values(a.arms)) {
    const r = arm.segments.fresh_wallets.rebuilds['last-day']
    windows += r.nonZeroPairs
    matched += Math.round(r.withinNonZero * r.nonZeroPairs)
  }
  return { source: 'ledger/study/convention-audit.json', weeklyWindows: weekly.windows, segments, freshLastDay: { windows, matched } }
}

function page(sweepPath, audit) {
  const sweep = inert(readFileSync(sweepPath, 'utf8'))
  const out = body.replace('__SWEEP_JSON__', () => sweep).replace('__AUDIT_JSON__', () => inert(JSON.stringify(audit)))
  if (out.includes('__SWEEP_JSON__') || out.includes('__AUDIT_JSON__')) throw new Error('a placeholder survived substitution')
  return out
}

/** the study, reduced to what the front page quotes: the tally, the sample, and every pair's measured prior with its verdict at the priors' own cost */
function studySummary() {
  const s = JSON.parse(readFileSync(join(ROOT, 'ledger', 'study', 'sweep.json'), 'utf8'))
  const spend = JSON.parse(readFileSync(join(ROOT, 'ledger', 'study', 'spend-report.json'), 'utf8'))
  const cost = 12
  const frame = s.frames.find((f) => f.costRtBps === cost)
  if (!frame) throw new Error(`sweep.json has no frame at ${cost} bps`)
  const measured = s.measured.map((m) => {
    const cell = frame.cells.find((c) => c.cohort === m.cohort && c.horizonHours === m.horizonHours)
    return { cohort: m.cohort, horizonHours: m.horizonHours, excessMeanBps: m.excessMeanBps, standardErrorBps: m.standardErrorBps, n: m.n, effectiveN: m.effectiveN, pValue: m.pValue, verdict: cell?.verdict ?? null }
  })
  return {
    source: 'ledger/study/sweep.json at 12 bps round trip; ledger/study/spend-report.json',
    tested: frame.summary.tested, failedSignal: frame.summary.failedSignal, economic: frame.summary.economic, realButCostly: frame.summary.realButCostly,
    calls: spend.calls, creditsSpent: spend.creditsSpent,
    observationsUsed: s.observationsUsed, forecastsFormed: s.forecastsFormed, searchCount: s.searchCount, adjustedAlpha: s.adjustedAlpha,
    generatedAtIso: s.generatedAtIso, signalFingerprint: s.signalFingerprint, measured,
  }
}

/**
 * The front page: page.src.html's head (title, fonts, the whole style system) over
 * front.src.html's own styles, markup and script, with the two live snapshots
 * (the tool's own output from real runs) and the study summary inlined.
 */
function front() {
  const cut = body.indexOf('<div class="wrap">')
  if (cut < 0) throw new Error('cannot find the body boundary in page.src.html')
  const head = body.slice(0, cut)
  const src = readFileSync(join(HERE, 'front.src.html'), 'utf8')
  const live = inert(readFileSync(join(HERE, 'live', 'live-signals.json'), 'utf8'))
  const pos = inert(readFileSync(join(HERE, 'live', 'positioning.json'), 'utf8'))
  const study = inert(JSON.stringify(studySummary()))
  const out = (head + src).replace('__LIVE_JSON__', () => live).replace('__POS_JSON__', () => pos).replace('__STUDY_JSON__', () => study)
  if (/__(LIVE|POS|STUDY)_JSON__/.test(out)) throw new Error('a placeholder survived substitution on the front page')
  return out
}

/**
 * Split the single source at the first element that belongs in <body>. Above it
 * is title, fonts and style; below it is markup and script.
 */
function fullDocument(p, { title, description }) {
  const cut = p.indexOf('<div class="wrap">')
  if (cut < 0) throw new Error('cannot find the body boundary in page.src.html')
  const head = p.slice(0, cut).trimEnd().replace('<title>Assay</title>', `<title>${title}</title>`)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="${description}">
<style>
  :root { color-scheme: light dark; padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
  html, body { margin: 0; }
  img { max-width: 100%; }
  [hidden] { display: none !important; }
</style>
${head}
</head>
<body>
${p.slice(cut)}
</body>
</html>
`
}

const study = page(join(ROOT, 'ledger', 'study', 'sweep.json'), auditSummary())
const check = page(join(HERE, 'sweep.json'), null)

writeFileSync(join(HERE, 'artifact.html'), study)
writeFileSync(join(HERE, 'index.html'), fullDocument(front(), {
  title: 'Assay',
  description: "What a Nansen signal is worth before your agent trades it: today's flows with their measured priors and a decision, live Hyperliquid positioning, and the 18-hypothesis study behind the priors. Powered by Nansen API.",
}))
writeFileSync(join(HERE, 'study.html'), fullDocument(study, {
  title: 'Assay · the study',
  description: "What Nansen's smart-money flows were worth: 12,781 API calls, 18 pre-registered hypotheses, each against a drift-matched control. Powered by Nansen API.",
}))
writeFileSync(join(HERE, 'check.html'), fullDocument(check, {
  title: 'Assay instrument check',
  description: 'The same engine over a seeded world with a planted answer: proof the instrument finds an edge when there is one.',
}))

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(0) + 'KB'
console.log(`docs/index.html     ${kb(readFileSync(join(HERE, 'index.html'), 'utf8'))}   the tool (real runs, the study's priors)`)
console.log(`docs/study.html     ${kb(readFileSync(join(HERE, 'study.html'), 'utf8'))}   the study (real Nansen data)`)
console.log(`docs/check.html     ${kb(readFileSync(join(HERE, 'check.html'), 'utf8'))}   the instrument check (planted edge)`)
console.log(`docs/artifact.html  ${kb(study)}   the study, no skeleton`)
