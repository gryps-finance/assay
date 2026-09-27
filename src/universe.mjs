/**
 * THE UNIVERSE — twenty-two tokens, fixed in PREREGISTRATION.md §2 on
 * 2026-09-16 before any call was made. This file only carries their addresses.
 *
 * The addresses are canonical contract (or mint) addresses as commonly
 * published for each asset. They are NOT trusted on their own: `resolve()`
 * spends one flow-summary call per token on a probe day and records the
 * `token_symbol` the venue echoes back. An echo that does not match the
 * symbol we meant is an EXCLUSION, counted in provenance, never a silent
 * substitution — the prereg says a token is never replaced after the fact,
 * and a wrong address is exactly the case that rule exists for.
 *
 * SEI is not covered by the endpoint and is not in the universe; the prereg
 * says so in words so nobody reads its absence as a result.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFlowRow } from './nansen.mjs'

export const UNIVERSE = Object.freeze([
  // ethereum
  { chain: 'ethereum', symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
  { chain: 'ethereum', symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' },
  { chain: 'ethereum', symbol: 'LINK', address: '0x514910771AF9Ca656af840dff83E8264EcF986CA' },
  { chain: 'ethereum', symbol: 'UNI', address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984' },
  { chain: 'ethereum', symbol: 'AAVE', address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' },
  { chain: 'ethereum', symbol: 'LDO', address: '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32' },
  { chain: 'ethereum', symbol: 'CRV', address: '0xD533a949740bb3306d119CC777fa900bA034cd52' },
  { chain: 'ethereum', symbol: 'ONDO', address: '0xfAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3' },
  { chain: 'ethereum', symbol: 'PEPE', address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933' },
  { chain: 'ethereum', symbol: 'ENA', address: '0x57e114B691Db790C35207b2e685D4A43181e6061' },
  // solana (mint addresses; SOL is the wrapped-SOL mint the venue keys on)
  { chain: 'solana', symbol: 'SOL', address: 'So11111111111111111111111111111111111111112' },
  { chain: 'solana', symbol: 'JUP', address: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
  { chain: 'solana', symbol: 'JTO', address: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL' },
  { chain: 'solana', symbol: 'PYTH', address: 'HZ1JovNiVvGrGNiiYvEozEVjZ58xaU3RKwX8eACQBCt3' },
  { chain: 'solana', symbol: 'WIF', address: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
  { chain: 'solana', symbol: 'BONK', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  // base
  { chain: 'base', symbol: 'AERO', address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631' },
  { chain: 'base', symbol: 'DEGEN', address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed' },
  { chain: 'base', symbol: 'BRETT', address: '0x532f27101965dd16442E59d40670FaF5eBB142E4' },
  // bnb
  { chain: 'bnb', symbol: 'CAKE', address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82' },
  { chain: 'bnb', symbol: 'XVS', address: '0xcF6BB5389c92Bdda8a3747Ddb454cB7a64626C63' },
  { chain: 'bnb', symbol: 'TWT', address: '0x4B0F1812e5Df2A09796481Ff14017e6005508003' },
])

export const ADDRESS_SOURCE = 'canonical contract / mint address as commonly published for the asset; confirmed against the venue\'s own token_symbol echo at resolution, or excluded'

/** the symbol the venue echoes may differ in case or wrapping (e.g. "SOL" vs "Wrapped SOL"); this is the match rule, stated once */
export function symbolMatches(expected, echoed) {
  if (typeof echoed !== 'string') return false
  const norm = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const e = norm(expected)
  const g = norm(echoed)
  return g === e || g === `W${e}` || g === `WRAPPED${e}` || (e === 'WETH' && g === 'ETH') || (e === 'WBTC' && g === 'BTC')
}

/**
 * Resolve the universe: one probe call per token, the echo recorded, the
 * result written to `<ledgerDir>/universe-resolved.json` BEFORE any arm runs.
 * Re-running reads the file back rather than spending again.
 */
export async function resolveUniverse({ client, ledgerDir, probeDate, universe = UNIVERSE, log = () => {}, onCall = () => {} }) {
  mkdirSync(ledgerDir, { recursive: true })
  const path = join(ledgerDir, 'universe-resolved.json')
  if (existsSync(path)) {
    const prior = JSON.parse(readFileSync(path, 'utf8'))
    log(`universe already resolved at ${prior.resolvedAtIso}: ${prior.included.length} included, ${prior.excluded.length} excluded (read back, nothing spent)`)
    return prior
  }
  const included = []
  const excluded = []
  for (const t of universe) {
    const r = await client.flowSummaryWindow({ chain: t.chain, tokenAddress: t.address, fromDate: probeDate, toDate: probeDate })
    const row = r.ok ? readFlowRow(r.data.data?.[0]) : null
    const echo = row?.tokenSymbol ?? null
    const entry = { ...t, source: ADDRESS_SOURCE, probeDate, state: r.state, requestId: r.headers?.requestId ?? null, echoedSymbol: echo, rows: r.ok ? (r.data.data?.length ?? 0) : 0 }
    if (r.ok && symbolMatches(t.symbol, echo)) {
      included.push(entry)
      log(`  ${t.chain.padEnd(9)} ${t.symbol.padEnd(6)} ok — venue echoes "${echo}"`)
      // the probe IS a daily-arm call for that day on an included token; hand it to the ledger so the arm never asks the venue for it again
      onCall({ token: t, window: { fromDate: probeDate, toDate: probeDate }, result: r, row })
    } else {
      const why = !r.ok ? `${r.state}${r.note ? `: ${r.note}` : ''}` : (r.data.data?.length ?? 0) === 0 ? 'no row for the probe day' : `venue echoes "${echo}", not ${t.symbol} — wrong address or wrong chain; EXCLUDED, not substituted`
      excluded.push({ ...entry, why })
      log(`  ${t.chain.padEnd(9)} ${t.symbol.padEnd(6)} EXCLUDED — ${why}`)
    }
  }
  const out = { resolvedAtIso: new Date().toISOString(), probeDate, source: ADDRESS_SOURCE, included, excluded, note: 'the universe is the prereg\'s commitment; this file is its mechanical resolution. An excluded token is counted, never replaced.' }
  writeFileSync(path, JSON.stringify(out, null, 2))
  return out
}
