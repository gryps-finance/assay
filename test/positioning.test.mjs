/**
 * `assay positioning`, END TO END, WITHOUT A KEY: the one-command live read against the mock venue, which plants
 * a liquidation wall on ETH and smart money against the crowd on HYPE.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeHlWorld, startHlMock } from './mock-hl.mjs'

let pass = 0, fail = 0
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) } }
const KEY = 'mock-key-12345678'
const run = (args, env = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, ['src/positioning.mjs', ...args], { env: { ...process.env, NANSEN_API_KEY: '', ...env } })
  let out = '', err = ''
  p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { err += d })
  p.on('close', (code) => resolve({ code, out, err }))
})

const mock = await startHlMock({ world: makeHlWorld(), balance: 100_000 })
{
  const ledger = mkdtempSync(join(tmpdir(), 'pos-'))
  const nokey = await run(['--ledger', ledger, '--base-url', mock.url])
  check('no key: refuses before any call', nokey.code === 2 && /NANSEN_API_KEY is not set/.test(nokey.err))

  const r = await run(['--ledger', ledger, '--base-url', mock.url, '--markets', '3', '--budget', '120', '--tier', 'pro'], { NANSEN_API_KEY: KEY })
  check('live read: exit 0 and the table', r.code === 0 && /ASSAY POSITIONING/.test(r.out) && /Powered by Nansen API/.test(r.out), `${r.code} ${r.err.slice(0, 200)}`)
  check('live read: the planted liquidation wall is named on ETH', /ETH: Longs \(liquidate below the mark\)/.test(r.out) || /ETH: Shorts/.test(r.out), r.out.slice(0, 600))
  check('live read: stays inside its budget', /credits spent/.test(r.out) && Number(/(\d+) credits spent/.exec(r.out)?.[1]) <= 120)
  check('live read: the derived ledger is written beside the scheduled sampler\'s', existsSync(join(ledger, 'derived', 'latest.json')) && existsSync(join(ledger, 'derived', 'recent.json')))

  const j = await run(['--ledger', ledger, '--base-url', mock.url, '--markets', '3', '--json', '--tier', 'pro'], { NANSEN_API_KEY: KEY })
  let o = null
  try { o = JSON.parse(j.out) } catch { o = null }
  check('json: machine-readable status, crowding and maps', o && o.status && Array.isArray(o.crowding?.markets) && Object.keys(o.maps ?? {}).length === 3, j.err.slice(0, 200))
  const hype = o?.crowding?.markets?.find((m) => m.market === 'HYPE')
  check('json: the planted divergence on HYPE is recovered (smart money against the crowd)', hype && hype.divergence !== null && Math.sign(hype.smSkew) !== Math.sign(hype.crowdSkew), JSON.stringify(hype)?.slice(0, 200))
  check('json: a re-run inside the same hour asks the venue for nothing it already has', o?.spend?.callsMade === 0 && o?.spend?.callsReused > 0, JSON.stringify(o?.spend))
}
await mock.close()
console.log(`\n  ${pass + fail} checks, ${fail} failed`)
process.exit(fail ? 1 : 0)
