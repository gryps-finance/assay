#!/usr/bin/env node
/**
 * assay positioning — a live read of labelled positioning on Hyperliquid perps, in one command.
 *
 * The venue-wide screener (every market's funding, open interest and smart-money book, four calls), then the full
 * positions book for the top N markets by open interest (everyone's largest positions plus every smart-money,
 * whale and public-figure position), then the derived read: where each market's positions liquidate and who holds
 * them, and whether smart money sits on the other side of a crowd that is paying funding.
 *
 * It writes into the same ledger the scheduled sampler keeps (`ledger/hl` by default), so a one-off read and the
 * hourly clock build one history. Markets are chosen venue-wide by open interest: nothing in the pull reveals which
 * market you care about.
 *
 *   NANSEN_API_KEY=… node src/positioning.mjs [--markets 3] [--top-positions 1000] [--budget 120] [--reserve 5000]
 *                                             [--ledger ledger/hl] [--tier free|pro] [--json]
 *
 * These are measurements with an age and a provenance, not a validated signal. PREREGISTRATION-HL.md fixes the
 * tests that will score them once thirty days of samples exist.
 */
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NansenClient, BudgetExhausted } from './nansen.mjs'
import { Sampler, sampleIdFor } from './hl-sample.mjs'
import { derive } from './hl-derive.mjs'
import { callHlTool } from './hl-tools.mjs'

const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d }
const has = (k) => process.argv.includes(k)
const pct = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`)
const sk = (x) => (x === null || x === undefined || !Number.isFinite(x) ? '  —  ' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}`)
const usd = (x) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x >= 1e9 ? `$${(x / 1e9).toFixed(2)}b` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}m` : `$${Math.round(x / 1e3)}k`)

export function renderPositioning({ status, crowding, maps }) {
  const L = ['', `  ASSAY POSITIONING  Hyperliquid, sample ${status.asOf?.positions ?? '—'} (screener ${status.asOf?.screener ?? '—'})`, '']
  const pulled = crowding.markets.filter((m) => m.kind === 'positions')
  L.push(`  ${'MARKET'.padEnd(8)}${'FUNDING/yr'.padStart(11)}${'OI'.padStart(10)}  ${'SMART'.padStart(6)}  ${'CROWD'.padStart(6)}  ${'DIVERGE'.padStart(7)}  ${'LONGS LIQ <5%'.padStart(13)}  ${'SHORTS LIQ <5%'.padStart(14)}`)
  for (const m of pulled) {
    const mp = maps[m.market]
    L.push(`  ${m.market.padEnd(8)}${pct(m.fundingAnnualised).padStart(11)}${usd(m.openInterest).padStart(10)}  ${sk(m.smSkew).padStart(6)}  ${sk(m.crowdSkew).padStart(6)}  ${sk(m.divergence).padStart(7)}  ${pct(mp?.long?.within?.w5?.share).padStart(13)}  ${pct(mp?.short?.within?.w5?.share).padStart(14)}`)
  }
  L.push('')
  for (const m of pulled) {
    const mp = maps[m.market]
    if (mp?.read) for (const r of mp.read.slice(0, 2)) L.push(`  ${m.market}: ${r}`)
    if (m.carrySetup) L.push(`  ${m.market}: ${m.carrySetup}.`)
  }
  const setups = crowding.carrySetups.filter((r) => r.kind !== 'positions').slice(0, 5)
  if (setups.length) {
    L.push('')
    L.push('  Carry setups on screener-only markets (smart money against the crowd, funding elevated):')
    for (const s of setups) L.push(`    ${s.market}: ${s.carrySetup}`)
  }
  L.push('')
  L.push('  Skew is by notional: +1 all long, -1 all short. Smart money\'s is the venue\'s full smart-money book; the crowd\'s is')
  L.push('  the largest positions pulled, excluding smart money. Measurements with an age, not a validated signal.')
  L.push('  Powered by Nansen API: perp-screener, tgm/perp-positions.')
  L.push('')
  return L.join('\n')
}

export async function main() {
  const LEDGER = argOf('--ledger', process.env.HL_LEDGER_DIR ?? 'ledger/hl')
  const MARKETS = Math.max(1, Math.min(Number(argOf('--markets', '3')) || 3, 10))
  const TOP = Number(argOf('--top-positions', '1000'))
  const BUDGET = Number(argOf('--budget', '120'))
  const RESERVE = Number(argOf('--reserve', '5000'))
  const TIER = argOf('--tier', process.env.NANSEN_TIER ?? 'free')
  const BASE_URL = argOf('--base-url', process.env.NANSEN_BASE_URL ?? 'https://api.nansen.ai')
  const JSON_OUT = has('--json')
  const say = JSON_OUT ? () => {} : (s) => console.log(s)

  const apiKey = process.env.NANSEN_API_KEY
  if (!apiKey) { console.error('NANSEN_API_KEY is not set in this environment. No call was attempted. Get a key at app.nansen.ai/api and set it in your shell.'); process.exit(2) }
  const client = new NansenClient({ apiKey, creditBudget: BUDGET, tier: TIER, baseUrl: BASE_URL, remainingFloor: RESERVE })
  mkdirSync(LEDGER, { recursive: true })
  const s = new Sampler({ client, ledgerDir: LEDGER, sampleId: sampleIdFor(Date.now()), intervalHours: 1, say })
  say(`\n  assay positioning: screener for every market, then positions for the top ${MARKETS} by open interest (budget ${BUDGET} credits)`)
  let exit = 0
  try {
    await s.screener()
    const top = (await s.rankMarkets({ n: MARKETS })).map((r) => r.market)
    say(`  markets: ${top.join(', ')}`)
    await s.positions({ markets: top, topPositions: TOP })
  } catch (e) {
    if (e instanceof BudgetExhausted) { say(`  STOPPED on budget: ${e.message}`); exit = 3 } else throw e
  }
  derive({ ledgerDir: LEDGER })
  const status = callHlTool('hl_status', {}, LEDGER)
  const crowding = callHlTool('hl_crowding', {}, LEDGER)
  if (status.refused || crowding.refused) { console.error(status.reason ?? crowding.reason); process.exit(1) }
  const maps = Object.fromEntries(crowding.markets.filter((m) => m.kind === 'positions').map((m) => [m.market, callHlTool('hl_liquidation_map', { market: m.market }, LEDGER)]))
  const rep = s.report()
  if (JSON_OUT) process.stdout.write(JSON.stringify({ status, crowding, maps, spend: rep }, null, 2) + '\n')
  else {
    console.log(renderPositioning({ status, crowding, maps }))
    console.log(`  ${rep.callsMade} calls, ${rep.creditsSpent} credits spent, ${rep.accountRemaining ?? '?'} left on the account. Ledger: ${LEDGER}\n`)
  }
  process.exit(exit)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(`assay positioning failed: ${e instanceof Error ? e.message : e}`); process.exit(1) })
}
