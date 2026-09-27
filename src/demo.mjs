/**
 * ASSAY DEMO — one command, one take.
 *
 * Runs the two live commands, `now` and `positioning`, with the framing a viewer
 * needs to follow them and pauses long enough to read, so a screen recording of
 * this one command shows the tool doing its job against Nansen's API. Nothing
 * between the headings is staged: every line is the child command's own output,
 * streamed as it happens, and the callouts are read back from the files those
 * commands just wrote.
 *
 *   NANSEN_API_KEY=… node src/cli.mjs demo            about 45 seconds, about 165 credits
 *   node src/cli.mjs demo --fast                      no pauses (tests)
 *
 * The key is read by the child commands from the environment, never printed.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FAST = process.argv.includes('--fast')
const pause = (ms) => (FAST ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)))
const say = (s = '') => console.log(s)
const f1 = (x) => (Number.isFinite(x) ? `${x > 0 ? '+' : ''}${x.toFixed(1)}` : '?')
const usd = (x) => {
  const a = Math.abs(x)
  const n = a >= 1e9 ? `${(a / 1e9).toFixed(2)}b` : a >= 1e6 ? `${(a / 1e6).toFixed(2)}m` : `${Math.round(a / 1e3)}k`
  return `${x < 0 ? '-' : '+'}$${n}`
}

/** run a sibling script, streaming its output as it happens; resolves with the exit code and the captured text */
function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, 'src', script), ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    child.stdout.on('data', (d) => { const s = d.toString(); text += s; process.stdout.write(s) })
    child.stderr.on('data', (d) => { const s = d.toString(); text += s; process.stderr.write(s) })
    child.on('close', (code) => resolve({ code: code ?? 1, text }))
    child.on('error', (e) => { process.stderr.write(`  ${e.message}\n`); resolve({ code: 1, text }) })
  })
}

const heading = (s) => { say(); say(`  ${'─'.repeat(100)}`); say(`  ${s}`); say(`  ${'─'.repeat(100)}`) }

async function main() {
  if (!FAST) console.clear()
  say()
  say('  ASSAY')
  say('  What a Nansen signal is worth, before your agent trades it.')
  say()
  say('  Your agent reads Nansen: whales bought this, fresh wallets piled into that.')
  say('  Before it acts, Assay attaches what that kind of signal has been worth, measured on')
  say('  12,781 calls of the same endpoint with a method sealed before the first one, and a decision.')
  say('  Then it reads where the Hyperliquid book actually sits. Everything below is live.')
  await pause(6000)

  heading("1 · TODAY'S SIGNALS  ·  one live call per token, then each signal with its measured prior")
  await pause(1500)
  const now = await run('now.mjs', ['--limit', '10'])
  if (now.code !== 0) { say(`  (the pull stopped with exit ${now.code})`) }
  await pause(3500)

  const liveDir = process.env.ASSAY_LIVE_DIR ?? join(ROOT, 'ledger', 'live')
  const liveFile = join(liveDir, 'live-signals.json')
  if (now.code === 0 && existsSync(liveFile)) {
    try {
      const L = JSON.parse(readFileSync(liveFile, 'utf8'))
      const top = [...(L.signals ?? [])].sort((a, b) => Math.abs(b.flowUsd) - Math.abs(a.flowUsd))[0]
      const h = top?.horizons?.find((x) => x.horizonHours === 24)
      if (top && h?.prior) {
        say(`  → The largest flow: ${top.cohort} ${top.direction === 'long' ? 'into' : 'out of'} ${top.subject}, ${usd(top.flowUsd)}.`)
        say(`    What that kind of signal has been worth over 18 months: ${f1(h.prior.netMeanBps)} ± ${f1(h.prior.standardErrorBps).replace('+', '')} bps net at 24h (n ${Number(h.prior.n).toLocaleString('en-US')}).`)
        say(`    Verdict ${h.verdict}. The agent's decision: ${h.action}.`)
      }
      if (L.summary?.headline) say(`  → ${L.summary.headline}`)
    } catch { /* the file is the child's; if it is unreadable, the table above already said what it said */ }
  }
  await pause(6000)

  heading('2 · THE HYPERLIQUID BOOK  ·  the venue-wide screener, then the largest positions on the top 3 markets')
  await pause(1500)
  // a fresh ledger folder per take, so the read is live even inside the same sample hour as an earlier run
  const takeLedger = join(ROOT, 'ledger', 'hl-demo', new Date().toISOString().slice(0, 16).replace(/[:.]/g, '-'))
  const pos = await run('positioning.mjs', ['--markets', '3', '--ledger', takeLedger])
  if (pos.code !== 0) say(`  (the read stopped with exit ${pos.code})`)
  await pause(2500)
  say('  → Smart money against the crowd, funding, and where the longs and shorts liquidate: measurements with an age,')
  say('    served as such until their pre-registered tests score, thirty days after the first scheduled sample.')
  await pause(5000)

  const credits = (t) => { const m = /(\d[\d,]*) credits spent/.exec(t); return m ? Number(m[1].replace(/,/g, '')) : null }
  const spent = [credits(now.text), credits(pos.text)].filter((x) => x !== null).reduce((a, b) => a + b, 0)
  heading('3 · WHAT YOU JUST SAW')
  say(`  Every number above came from Nansen's API during this recording${spent ? ` (${spent} credits)` : ''}.`)
  say('  The priors behind the decisions: 12,781 calls, 18 pre-registered tests, a drift-matched control for each,')
  say('  a request-id receipt for every call, and the same instrument shown finding a planted edge on a seeded world.')
  say('  A CLI, an MCP server with twelve tools for any agent, and a Claude plugin. Zero dependencies.')
  say()
  say('  github.com/gryps-finance/assay  ·  gryps-finance.github.io/assay  ·  Powered by Nansen API')
  say()
  await pause(6000)
  process.exit(now.code === 0 && pos.code === 0 ? 0 : 1)
}

main()
