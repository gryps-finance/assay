#!/usr/bin/env node
/**
 * Build the two demo pages from one source.
 *
 *   docs/index.html      THE STUDY: the engine's output over the real Nansen run
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
  if (out.includes('__SWEEP_JSON__') || out.includes('__AUDIT_JSON__')) throw new Error('the data contains a placeholder token; refusing to build')
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
writeFileSync(join(HERE, 'index.html'), fullDocument(study, {
  title: 'Assay',
  description: "What Nansen's smart-money flows were worth: 12,781 API calls, 18 pre-registered hypotheses, each against a drift-matched control. Powered by Nansen API.",
}))
writeFileSync(join(HERE, 'check.html'), fullDocument(check, {
  title: 'Assay instrument check',
  description: 'The same engine over a seeded world with a planted answer: proof the instrument finds an edge when there is one.',
}))

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(0) + 'KB'
console.log(`docs/index.html     ${kb(readFileSync(join(HERE, 'index.html'), 'utf8'))}   the study (real Nansen data)`)
console.log(`docs/check.html     ${kb(readFileSync(join(HERE, 'check.html'), 'utf8'))}   the instrument check (planted edge)`)
console.log(`docs/artifact.html  ${kb(study)}   the study, no skeleton`)
