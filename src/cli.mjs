#!/usr/bin/env node
/**
 * assay — one entry point for the whole tool.
 *
 *   assay now                    today's Nansen flow signals, each with its measured prior and a decision (key)
 *   assay positioning            a live read of Hyperliquid positioning: liquidations by holder, smart money vs crowd (key)
 *   assay prior <segment> <h>    the measured prior for one segment at one horizon (no key)
 *   assay leaderboard            all eighteen measured pairs, ranked, with their verdicts (no key)
 *   assay audit                  what a multi-day window of the historical flow summary returns (no key)
 *   assay study [...]            run your own pre-registered study (key); see docs/RUNNING.md
 *   assay score [...]            score a study ledger into verdicts (no key)
 *   assay sample [...]           one pass of the Hyperliquid sampler, for a scheduler (key)
 *   assay derive [...]           derive maps, crowding and the series from the sampler's ledger (no key)
 *   assay mcp                    the MCP server over stdio, for any agent (no key for the readers)
 *
 * The key is NANSEN_API_KEY in the environment and nowhere else.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const [, , cmd, ...rest] = process.argv
const has = (k) => rest.includes(k)

/** defaults point at the repository's own ledgers, from any working directory; an explicit flag always wins */
const env = { ...process.env }
env.ASSAY_LEDGER_DIR ??= join(ROOT, 'ledger', 'study')
env.ASSAY_LIVE_DIR ??= join(ROOT, 'ledger', 'live')
if (!has('--ledger')) env.HL_LEDGER_DIR ??= join(ROOT, 'ledger', 'hl')

const run = (script, args) => {
  const r = spawnSync(process.execPath, [join(ROOT, 'src', script), ...args], { stdio: 'inherit', env })
  process.exit(r.status ?? 1)
}

const verdicts = () => {
  const p = join(env.ASSAY_LEDGER_DIR, 'verdicts.json')
  if (!existsSync(p)) { console.error(`No measured priors at ${p}.`); process.exit(2) }
  return JSON.parse(readFileSync(p, 'utf8'))
}
const f1 = (x) => (Number.isFinite(x) ? `${x > 0 ? '+' : ''}${x.toFixed(1)}` : '—')

function leaderboard() {
  const v = verdicts()
  console.log(`\n  ASSAY LEADERBOARD  ${v.arm} arm, ${v.costRtBps} bps round trip, ${v.searchCount} hypotheses, bar p < ${(0.05 / v.searchCount).toExponential(2)}`)
  console.log(`  ${v.summary?.headline ?? ''}\n`)
  console.log(`  ${'SEGMENT'.padEnd(15)}${'HRZN'.padStart(5)}  ${'VERDICT'.padEnd(14)}${'NET bps'.padStart(8)}${'± SE'.padStart(8)}${'n'.padStart(7)}${'effN'.padStart(7)}${'p'.padStart(9)}`)
  for (const r of v.ranked ?? v.results ?? []) {
    const p = r.prior ?? {}
    console.log(`  ${String(r.provenance.cohort).padEnd(15)}${String(r.provenance.horizonHours + 'h').padStart(5)}  ${String(r.verdict).padEnd(14)}${f1(p.netMeanBps).padStart(8)}${(Number.isFinite(p.standardErrorBps) ? p.standardErrorBps.toFixed(1) : '—').padStart(8)}${String(p.n ?? r.provenance.matured ?? '—').padStart(7)}${String(p.effectiveN ?? '—').padStart(7)}${(Number.isFinite(p.pValue) ? p.pValue.toFixed(4) : '—').padStart(9)}`)
  }
  console.log(`\n  Net is after the round-trip cost; the standard error is a block bootstrap over overlapping holding windows.\n  Exchange is the negative control. Scored ${v.asOf}. Powered by Nansen API.\n`)
}

function prior(seg, h) {
  const v = verdicts()
  const r = (v.results ?? []).find((x) => String(x.provenance.cohort).toLowerCase() === String(seg ?? '').toLowerCase() && Number(x.provenance.horizonHours) === Number(h))
  if (!r) {
    console.error(`No measured prior for '${seg}' at ${h}h. Measured: ${[...new Set((v.results ?? []).map((x) => x.provenance.cohort))].join(', ')} at 24, 48 or 168h.`)
    process.exit(2)
  }
  console.log(JSON.stringify({ segment: r.provenance.cohort, horizonHours: r.provenance.horizonHours, verdict: r.verdict, reading: r.reading ?? null, prior: r.prior, source: `${v.arm} arm, spec ${v.specHash}, scored ${v.asOf}` }, null, 2))
}

function audit() {
  const p = join(env.ASSAY_LEDGER_DIR, 'convention-audit.json')
  if (!existsSync(p)) { console.error(`No window audit at ${p}.`); process.exit(2) }
  const a = JSON.parse(readFileSync(p, 'utf8'))
  console.log('\n  WHAT A MULTI-DAY WINDOW RETURNS  tgm/historical-token-flow-summary, audited on the study ledger\n')
  console.log('  A multi-day window is NOT the sum of daily calls over the same days. Call at the resolution you will act on;')
  console.log('  never sum short windows into long ones, and never read a long window as a sum.\n')
  for (const arm of ['weekly', 'monthly']) {
    const w = a.arms?.[arm]
    if (!w) continue
    console.log(`  ${arm} (${w.windows} one-call windows, each rebuilt from its days nine ways):`)
    for (const [seg, s] of Object.entries(w.segments)) console.log(`    ${seg.padEnd(14)} ${s.best?.verdict ?? '—'}${s.best ? `: best rebuild ${s.best.rebuild}, within 5% on ${(100 * s.best.score).toFixed(1)}% of non-zero pairs` : ''}`)
    console.log('')
  }
  console.log('  Full method and numbers: AUDIT-CONVENTION.md.\n')
}

const HELP = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith(' *   assay') || l.startsWith(' * The key')).map((l) => l.replace(/^ \* ?/, '  ')).join('\n')

switch (cmd) {
  case 'now': run('now.mjs', rest); break
  case 'positioning': case 'hl': run('positioning.mjs', rest); break
  case 'study': run('study.mjs', rest); break
  case 'score': run('score-study.mjs', rest); break
  case 'sample': run('hl-sample.mjs', rest); break
  case 'derive': run('hl-derive.mjs', rest); break
  case 'mcp': run('mcp-server.mjs', rest); break
  case 'leaderboard': leaderboard(); break
  case 'prior': prior(rest[0], rest[1]); break
  case 'audit': audit(); break
  default:
    console.log(`\n  assay: measured priors for Nansen signals, live.\n\n${HELP}\n`)
    process.exit(cmd && cmd !== 'help' && cmd !== '--help' ? 2 : 0)
}
