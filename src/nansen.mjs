/**
 * NANSEN CLIENT — typed, credit-metered, drift-refusing.
 *
 * Three things this does that a fetch wrapper does not.
 *
 * 1. IT COUNTS WHAT IT SPENDS. Nansen prices per endpoint (1, 5, 100, 500
 *    credits), and an agent left to poll freely will discover the bill after it
 *    has been paid. Every call is metered against a budget declared up front,
 *    and the budget is enforced before the request goes out, not reported after.
 *
 * 2. IT REFUSES ON SHAPE DRIFT. An analytics API that quietly renames a field
 *    turns every downstream number into a confident zero. So each endpoint
 *    declares the fields it needs; a response missing them produces a recorded
 *    `shape-refused` row naming the fields it DID see, and nothing downstream
 *    reads it. Drift becomes data rather than silence.
 *
 * 3. IT NEVER LOGS THE KEY. Not in an error, not in a retry message, not in a
 *    ledger row. The redaction is applied to every string that leaves this
 *    module, including exception text, because the one place a key reliably
 *    leaks is an error path nobody tested.
 *
 * Rate limits (free tier: 15/s, 300/min) are respected by a token bucket rather
 * than by retrying into a 429, because the polite version costs the same and
 * leaves the shared quota intact for whoever else is on the key.
 */

export const BASE_URL = 'https://api.nansen.ai'

/**
 * Credit cost per endpoint, from the published pricing. Kept as a table rather
 * than inline so the budget arithmetic is auditable at a glance and a pricing
 * change is a one-line diff.
 */
export const CREDIT_COST = Object.freeze({
  '/api/v1/smart-money/netflow': 5,
  '/api/v1/smart-money/holdings': 5,
  '/api/v1/smart-money/dex-trades': 5,
  '/api/v1/smart-money/perp-trades': 5,
  '/api/v1/smart-money/pnl-leaderboard': 5,
  '/api/v1/smart-money/historical-holdings': 5,
  '/api/v1/tgm/token-ohlcv': 1,
  '/api/v1/tgm/flow-intelligence': 1,
  '/api/v1/tgm/who-bought-sold': 1,
  '/api/v1/tgm/flows': 1,
  '/api/v1/tgm/token-information': 1,
  '/api/v1/token-screener': 1,
  '/api/v1/perp-screener': 1,
  /**
   * ASSUMED at 5 until the first live probe reads `X-Nansen-Credits-Cost` off
   * the reply (2026-09-20: the endpoint page names no price). The client
   * charges by the header whenever one is present, so this row only gates the
   * pre-call budget check; a wrong row cannot under-count what was spent.
   */
  '/api/v1/tgm/perp-positions': 5,
  '/api/v1/profiler/address/labels': 100,
  '/api/v1/profiler/address/premium-labels': 500,
  '/api/v1/account': 0,

  /**
   * THE BACKTESTING FAMILY — `/api/v1beta1/`, and 5x the price of its real-time
   * counterpart. Both halves of that sentence were wrong in this table until
   * 2026-09-16: `historical-token-ohlcv` was listed under `/api/v1/` at 1
   * credit. It is `/api/v1beta1/` at 5. A budget built on the old row would
   * have run out five times sooner than it predicted, which is the failure this
   * table exists to prevent.
   */
  '/api/v1beta1/tgm/historical-token-ohlcv': 5,
  '/api/v1beta1/tgm/historical-token-flow-summary': 5,
  '/api/v1beta1/tgm/historical-who-bought-sold': 5,
  '/api/v1beta1/tgm/historical-dex-trades': 5,
  '/api/v1beta1/token-screener/historical': 5,
  '/api/v1beta1/tgm/historical-top-holders': 25,
  '/api/v1beta1/tgm/historical-pnl-leaderboard': 25,
  '/api/v1beta1/tgm/historical-token-quant-scores': 25,
  '/api/v1beta1/smart-money/historical-token-balances': 25,
})

/**
 * The segments `historical-token-flow-summary` reports. NOT the same list as
 * SMART_MONEY_COHORTS — that endpoint is token-first and reports these six.
 *
 * Fixed here for the same reason the cohort list is: a segment appearing
 * upstream must be a reviewed change to the study rather than a silent
 * expansion of the search count. Six segments x three horizons is still
 * eighteen hypotheses, so the Bonferroni bar is unchanged.
 *
 * `Exchange` is the natural NEGATIVE CONTROL. Exchange flow is custody
 * movement, not conviction, and it should read `fail-signal`. If it does not,
 * the measurement is wrong and that is more informative than any positive
 * result in the same run.
 */
export const HISTORICAL_SEGMENTS = Object.freeze([
  'whale',
  'public_figure',
  'top_pnl',
  'smart_trader',
  'exchange',
  'fresh_wallets',
])

/** the display names the page and the MCP server use for the six segments */
export const SEGMENT_LABEL = Object.freeze({
  whale: 'Whale',
  public_figure: 'Public Figure',
  top_pnl: 'Top PnL',
  smart_trader: 'Smart Trader',
  exchange: 'Exchange',
  fresh_wallets: 'Fresh Wallets',
})

/**
 * The per-row fields the flow summary documents, per segment. `net_flow_usd`
 * is the signal; the other two are carried for provenance and are not
 * additive across windows (avg is a geometric mean, wallet_count a set size).
 */
export const SEGMENT_FIELDS = Object.freeze(['net_flow_usd', 'avg_flow_usd', 'wallet_count'])

/**
 * Read one flow-summary row into `{ segment: { netFlowUsd, avgFlowUsd, walletCount } }`.
 * A null column is ABSENCE — the segment's label coverage does not include the
 * window's `date_to` — and is returned as null, never as 0. A row missing a
 * segment's fields entirely (a rename upstream) is reported as `missingFields`
 * so drift is named rather than read as a quiet zero.
 */
export function readFlowRow(row) {
  const out = { tokenSymbol: row?.token_symbol ?? null, segments: {}, missingFields: [] }
  for (const s of HISTORICAL_SEGMENTS) {
    const k = `${s}_net_flow_usd`
    if (!row || !(k in row)) { out.missingFields.push(k); continue }
    const v = row[k]
    const num = (x) => (x === null || x === undefined ? null : Number.isFinite(Number(x)) ? Number(x) : null)
    out.segments[s] = { netFlowUsd: num(v), avgFlowUsd: num(row[`${s}_avg_flow_usd`]), walletCount: num(row[`${s}_wallet_count`]) }
  }
  return out
}

/**
 * Chains the historical flow summary covers. SEI and Arbitrum are NOT among them.
 * Hyperliquid IS covered for OHLCV and the perp endpoints.
 */
export const HISTORICAL_FLOW_CHAINS = Object.freeze(['ethereum', 'solana', 'base', 'bnb'])

/**
 * The six Smart Money label cohorts Nansen publishes. These are the contestants
 * in the tournament, and the list is FIXED here rather than discovered at
 * runtime so that a new cohort appearing upstream is a reviewed change to the
 * study rather than a silent expansion of the search count.
 */
export const SMART_MONEY_COHORTS = Object.freeze([
  'Fund',
  'Smart Trader',
  '30D Smart Trader',
  '90D Smart Trader',
  '180D Smart Trader',
  'Smart HL Perps Trader',
])

// ───────────────────────────────────────────── the Hyperliquid positioning family

/**
 * THE HYPERLIQUID ENDPOINTS ARE SNAPSHOTS. Read 2026-09-20 from their pages:
 * `tgm/perp-positions` "returns a current, point-in-time snapshot of open
 * positions for the token — there is no date-range parameter or historical
 * look-back"; `perp-screener`'s mark, funding and open interest are current
 * while its volumes cover the `date` range; `smart-money/perp-trades` serves
 * only the trailing seven days. Nothing here can be asked for as of a past
 * date. So the time series of labelled positioning on Hyperliquid exists only
 * if someone samples these on a clock and keeps every reply — which is what
 * `hl-sample.mjs` does, and why the raw pages are kept rather than summarised.
 */
export const PERP_LABEL_TYPES = Object.freeze(['all_traders', 'smart_money', 'whale', 'public_figure'])
export const SCREENER_TRADER_TYPES = Object.freeze(['all', 'sm', 'whale', 'public_figure'])

const num = (x) => (x === null || x === undefined || x === '' ? null : Number.isFinite(Number(x)) ? Number(x) : null)
/** "10x", "10", 10 → 10; anything else → null */
const lev = (x) => { if (x === null || x === undefined) return null; const n = Number(String(x).replace(/x$/i, '').trim()); return Number.isFinite(n) && n > 0 ? n : null }

/**
 * One open position as `tgm/perp-positions` returns it. A liquidation price of
 * 0 or below is ABSENCE (a cross-margined book with no single liquidation
 * level, or a field the venue did not fill) and is returned as null: it must
 * never land in the liquidation map as "liquidates at zero".
 */
export function readPositionRow(row) {
  const required = ['address', 'side', 'position_value_usd', 'liquidation_price', 'mark_price']
  const missingFields = required.filter((k) => !row || !(k in row))
  const side = typeof row?.side === 'string' ? (row.side.toLowerCase() === 'long' ? 'long' : row.side.toLowerCase() === 'short' ? 'short' : null) : null
  const liq = num(row?.liquidation_price)
  return {
    address: row?.address ?? null,
    addressLabel: row?.address_label ?? null,
    side,
    notionalUsd: num(row?.position_value_usd),
    size: num(row?.position_size),
    leverage: lev(row?.leverage),
    leverageType: row?.leverage_type ?? null,
    entryPrice: num(row?.entry_price),
    markPrice: num(row?.mark_price),
    liquidationPrice: liq !== null && liq > 0 ? liq : null,
    fundingUsd: num(row?.funding_usd),
    upnlUsd: num(row?.upnl_usd),
    missingFields,
  }
}

/**
 * One market as `perp-screener` returns it, for a given trader_type. The
 * smart-money shorts figure is NEGATIVE in the documented example
 * (`current_smart_money_position_shorts_usd: -3000000`); it is stored as a
 * magnitude here and the sign convention is noted, so a skew is never computed
 * from a sign the venue happened to choose.
 */
export function readScreenerRow(row, traderType = 'all') {
  const base = {
    market: row?.token_symbol ?? null,
    volume: num(row?.volume), buyVolume: num(row?.buy_volume), sellVolume: num(row?.sell_volume), pressure: num(row?.buy_sell_pressure),
    traderCount: num(row?.trader_count), markPrice: num(row?.mark_price), funding: num(row?.funding), openInterest: num(row?.open_interest), previousPrice: num(row?.previous_price_usd),
    sm: null, labelled: null, missingFields: [],
  }
  if (!row || !('token_symbol' in row)) base.missingFields.push('token_symbol')
  if (traderType === 'sm') {
    const l = num(row?.current_smart_money_position_longs_usd), s = num(row?.current_smart_money_position_shorts_usd)
    base.sm = {
      volume: num(row?.smart_money_volume), buyVolume: num(row?.smart_money_buy_volume), sellVolume: num(row?.smart_money_sell_volume), netPositionChange: num(row?.net_position_change),
      longsUsd: l === null ? null : Math.abs(l), shortsUsd: s === null ? null : Math.abs(s), longsCount: num(row?.smart_money_longs_count), shortsCount: num(row?.smart_money_shorts_count),
    }
    for (const k of ['current_smart_money_position_longs_usd', 'current_smart_money_position_shorts_usd']) if (row && !(k in row)) base.missingFields.push(k)
  } else if (traderType === 'whale' || traderType === 'public_figure') {
    const l = num(row?.current_position_longs_usd), s = num(row?.current_position_shorts_usd)
    base.labelled = { longsUsd: l === null ? null : Math.abs(l), shortsUsd: s === null ? null : Math.abs(s), longsCount: num(row?.longs_count), shortsCount: num(row?.shorts_count) }
  } else {
    for (const k of ['open_interest', 'funding', 'mark_price']) if (row && !(k in row)) base.missingFields.push(k)
  }
  return base
}

/** One trade as `smart-money/perp-trades` returns it. */
export function readPerpTradeRow(row) {
  const required = ['trader_address', 'token_symbol', 'side', 'action', 'value_usd', 'block_timestamp', 'transaction_hash']
  return {
    address: row?.trader_address ?? null,
    addressLabel: row?.trader_address_label ?? null,
    market: row?.token_symbol ?? null,
    side: typeof row?.side === 'string' ? row.side.toLowerCase() : null,
    action: row?.action ?? null,
    amount: num(row?.token_amount),
    priceUsd: num(row?.price_usd),
    valueUsd: num(row?.value_usd),
    type: row?.type ?? null,
    atIso: row?.block_timestamp ?? null,
    txHash: row?.transaction_hash ?? null,
    missingFields: required.filter((k) => !row || !(k in row)),
  }
}

/** Required response fields per endpoint. Missing any -> shape-refused. */
const REQUIRED_FIELDS = Object.freeze({
  '/api/v1/smart-money/netflow': ['data'],
  '/api/v1/smart-money/holdings': ['data'],
  '/api/v1/smart-money/perp-trades': ['data', 'pagination'],
  '/api/v1/tgm/perp-positions': ['data', 'pagination'],
  '/api/v1/perp-screener': ['data', 'pagination'],
  '/api/v1/tgm/token-ohlcv': ['data'],
  '/api/v1/account': [],
  '/api/v1beta1/tgm/historical-token-ohlcv': ['data'],
  '/api/v1beta1/tgm/historical-token-flow-summary': ['data'],
})

export class NansenError extends Error {}
export class BudgetExhausted extends NansenError {}
export class ShapeRefused extends NansenError {}

/**
 * The response headers Nansen documents, read on every reply and carried onto
 * the log row: what a call was QUOTED, what it actually DEDUCTED (0 on a
 * rejected request), what the account has LEFT, and the request id support
 * asks for. `X-Nansen-Credits-Remaining` is the account's own number and it
 * outranks our arithmetic — the client stops on it, not on its own tally.
 */
export function readHeaders(res) {
  const h = res?.headers
  const get = (k) => (h && typeof h.get === 'function' ? h.get(k) : null)
  const num = (k) => { const v = get(k); const n = v === null || v === undefined || v === '' ? NaN : Number(v); return Number.isFinite(n) ? n : null }
  return {
    creditsCost: num('x-nansen-credits-cost'),
    creditsUsed: num('x-nansen-credits-used'),
    creditsRemaining: num('x-nansen-credits-remaining'),
    requestId: get('x-request-id'),
    rateRemainingSecond: num('x-ratelimit-remaining-second'),
    rateRemainingMinute: num('x-ratelimit-remaining-minute'),
    retryAfterS: num('retry-after'),
    rateScope: get('x-nansen-ratelimit-scope'),
  }
}

/** A token bucket that never lets us be the reason someone else sees a 429. */
class RateGate {
  constructor({ perSecond = 15, perMinute = 300 } = {}) {
    this.perSecond = perSecond
    this.perMinute = perMinute
    this.second = []
    this.minute = []
  }
  async take(now = Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
    for (;;) {
      const t = Date.now()
      this.second = this.second.filter((x) => t - x < 1000)
      this.minute = this.minute.filter((x) => t - x < 60_000)
      if (this.second.length < this.perSecond && this.minute.length < this.perMinute) {
        this.second.push(t)
        this.minute.push(t)
        return
      }
      const waitS = this.second.length >= this.perSecond ? 1000 - (t - this.second[0]) : 0
      const waitM = this.minute.length >= this.perMinute ? 60_000 - (t - this.minute[0]) : 0
      await sleep(Math.max(25, waitS, waitM))
    }
  }
}

export class NansenClient {
  /**
   * @param {object} o
   * @param {string} o.apiKey
   * @param {number} o.creditBudget   hard ceiling; the client REFUSES past it rather than warning
   * @param {function} [o.fetchImpl]
   */
  constructor({ apiKey, creditBudget, fetchImpl = fetch, baseUrl = BASE_URL, tier = 'free', timeoutMs = 30_000, remainingFloor = 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 8) {
      // No key, no construction: never a silent degradation into a client that
      // fetches nothing and reports fine.
      throw new NansenError('NANSEN_API_KEY is required — this client refuses to construct without one rather than degrading quietly')
    }
    if (!Number.isFinite(creditBudget) || creditBudget <= 0) {
      throw new NansenError('creditBudget is required — an unmetered analytics client is a bill with a delay on it')
    }
    this.apiKey = apiKey
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
    this.budget = creditBudget
    this.spent = 0
    this.calls = 0
    this.gate = new RateGate(tier === 'pro' ? { perSecond: 75, perMinute: 1500 } : { perSecond: 15, perMinute: 300 })
    /**
     * The account's OWN remaining balance, read off the last reply's
     * `X-Nansen-Credits-Remaining`. Null until the first reply. When it is
     * known and falls to `remainingFloor`, the client refuses the next call:
     * the study is never the thing that drains the account to zero.
     */
    this.accountRemaining = null
    this.remainingFloor = remainingFloor
    this.sleep = sleep
    /** every call, for the ledger and for the contest's 1,000-call proof */
    this.log = []
  }

  /** Redact the key from ANY string that leaves this module, error paths included. */
  #redact(s) {
    return String(s).split(this.apiKey).join('[redacted]')
  }

  get creditsRemaining() { return this.budget - this.spent }

  /**
   * One metered POST.
   *
   * Returns `{ ok, data, cost, state }` where state is 'ok' | 'shape-refused' |
   * 'http-error' | 'network-error'. It throws only for BUDGET, because running
   * out of credits is a decision the caller made and must handle, while a bad
   * response is data about the upstream and belongs in the ledger.
   */
  async post(path, body = {}, { retries = 3 } = {}) {
    const cost = CREDIT_COST[path]
    if (cost === undefined) throw new NansenError(`unpriced endpoint ${path} — add it to CREDIT_COST before calling it, so the budget stays honest`)
    if (this.spent + cost > this.budget) {
      throw new BudgetExhausted(`refusing ${path}: ${cost} credits would exceed the ${this.budget}-credit budget (${this.spent} spent). Raise the budget deliberately or narrow the study.`)
    }
    if (this.accountRemaining !== null && this.accountRemaining - cost < this.remainingFloor) {
      throw new BudgetExhausted(`refusing ${path}: the account reports ${this.accountRemaining} credits remaining and the floor is ${this.remainingFloor}. The study does not drain the account.`)
    }

    await this.gate.take()
    const startedAt = new Date().toISOString()
    let res
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { apikey: this.apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      const row = { atIso: startedAt, path, cost: 0, state: 'network-error', note: this.#redact(e?.message ?? e) }
      this.log.push(row)
      return { ok: false, data: null, cost: 0, state: 'network-error', note: row.note, headers: null }
    }

    const headers = readHeaders(res)
    if (headers.creditsRemaining !== null) this.accountRemaining = headers.creditsRemaining

    /**
     * 429: the venue says wait, so wait, for as long as it says (Retry-After is
     * seconds) and once more than it says. Nothing was deducted (the docs put
     * `X-Nansen-Credits-Used` at 0 on a rejected request) so nothing is counted;
     * the attempt is logged so a run that keeps hitting the wall is visible.
     */
    if (res.status === 429 && retries > 0) {
      const waitS = headers.retryAfterS ?? 2
      this.log.push({ atIso: startedAt, path, cost: 0, state: 'rate-limited', status: 429, note: `429 (${headers.rateScope ?? 'scope unknown'}); waiting ${waitS}s`, requestId: headers.requestId })
      await this.sleep(waitS * 1000 + 250)
      return this.post(path, body, { retries: retries - 1 })
    }

    // credits are consumed by the upstream whether or not we like the answer —
    // by the account's own accounting when the header is present, by the table when not
    const charged = headers.creditsUsed !== null ? headers.creditsUsed : cost
    this.spent += charged
    this.calls += 1

    if (!res.ok) {
      /**
       * The ErrorEnvelope carries a stable `code`. Read it rather than the
       * message: `insufficient_credits` is the one that ends a run, and it is
       * thrown so the caller cannot mistake it for a data problem.
       */
      let code = null
      let message = null
      try { const j = await res.json(); code = j?.code ?? j?.error ?? null; message = j?.message ?? null } catch { /* no body, or not json */ }
      const note = this.#redact(`HTTP ${res.status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`)
      const row = { atIso: startedAt, path, cost: charged, state: 'http-error', status: res.status, code, note, requestId: headers.requestId, creditsRemaining: headers.creditsRemaining }
      this.log.push(row)
      if (code === 'insufficient_credits') throw new BudgetExhausted(`the account refused ${path}: ${note}`)
      return { ok: false, data: null, cost: charged, state: 'http-error', status: res.status, code, note, headers }
    }

    let json
    try {
      json = await res.json()
    } catch (e) {
      const row = { atIso: startedAt, path, cost: charged, state: 'shape-refused', note: this.#redact(`unparseable body: ${e?.message}`), requestId: headers.requestId }
      this.log.push(row)
      return { ok: false, data: null, cost: charged, state: 'shape-refused', note: row.note, headers }
    }

    const required = REQUIRED_FIELDS[path] ?? []
    const missing = required.filter((f) => !(f in (json ?? {})))
    if (missing.length > 0) {
      // Name what we DID see. A refusal that does not describe the surprise is
      // just a failure; one that names the observed keys is a bug report.
      const seen = Object.keys(json ?? {}).slice(0, 20)
      const row = {
        atIso: startedAt, path, cost: charged, state: 'shape-refused',
        note: this.#redact(`missing ${missing.join(', ')}; observed top-level keys: ${seen.join(', ') || '(none)'}`),
        requestId: headers.requestId,
      }
      this.log.push(row)
      return { ok: false, data: null, cost: charged, state: 'shape-refused', note: row.note, headers }
    }

    this.log.push({ atIso: startedAt, path, cost: charged, state: 'ok', rows: Array.isArray(json.data) ? json.data.length : null, requestId: headers.requestId, creditsRemaining: headers.creditsRemaining })
    return { ok: true, data: json, cost: charged, state: 'ok', headers }
  }

  // ───────────────────────────────────────────────── typed endpoint wrappers

  /** Smart money net capital flow per token, filtered to ONE label cohort. */
  async smartMoneyNetflow({ chains, cohort, perPage = 100, page = 1 }) {
    if (!SMART_MONEY_COHORTS.includes(cohort)) {
      throw new NansenError(`unknown cohort '${cohort}' — the tournament's contestant list is fixed so the search count cannot drift`)
    }
    return this.post('/api/v1/smart-money/netflow', {
      chains,
      filters: { include_smart_money_labels: [cohort] },
      pagination: { page, per_page: perPage },
      order_by: { field: 'value_usd', direction: 'desc' },
    })
  }

  /**
   * Hyperliquid perp trades by smart-money wallets — the trailing `lookbackHours`
   * (1–168; the venue serves seven days and no more). `cohort` narrows to one
   * label; `cohorts` to several; neither means every smart-money label. The
   * sampler asks for a little more than its own interval and de-duplicates by
   * transaction, so the kept tape is continuous while each call is short.
   */
  async smartMoneyPerpTrades({ cohort = null, cohorts = null, tokenSymbol = null, lookbackHours = 168, onlyNewPositions = false, perPage = 1000, page = 1, orderBy = [{ field: 'block_timestamp', direction: 'DESC' }] } = {}) {
    const labels = cohorts ?? (cohort ? [cohort] : null)
    if (labels) for (const c of labels) if (!SMART_MONEY_COHORTS.includes(c)) throw new NansenError(`unknown cohort '${c}'`)
    if (!(lookbackHours >= 1 && lookbackHours <= 168)) throw new NansenError('lookbackHours must be within 1..168 — the venue serves the trailing seven days only')
    const filters = {}
    if (labels) filters.include_smart_money_labels = labels
    if (tokenSymbol) filters.token_symbol = tokenSymbol
    return this.post('/api/v1/smart-money/perp-trades', {
      filters, lookback_hours: lookbackHours, only_new_positions: onlyNewPositions,
      pagination: { page, per_page: perPage }, order_by: orderBy,
    })
  }

  /**
   * Every open position on one Hyperliquid market, now. `labelType` selects
   * the book (`all_traders`, `smart_money`, `whale`, `public_figure`); pages of
   * up to 1,000, largest notional first so a capped pull keeps the positions
   * that carry the liquidation map's weight.
   */
  async perpPositions({ tokenSymbol, labelType = 'all_traders', page = 1, perPage = 1000, orderBy = [{ field: 'position_value_usd', direction: 'DESC' }] }) {
    if (!tokenSymbol) throw new NansenError('tokenSymbol is required')
    if (!PERP_LABEL_TYPES.includes(labelType)) throw new NansenError(`unknown label_type '${labelType}' (one of ${PERP_LABEL_TYPES.join(', ')})`)
    return this.post('/api/v1/tgm/perp-positions', {
      token_symbol: tokenSymbol, label_type: labelType,
      pagination: { page, per_page: perPage }, order_by: orderBy,
    })
  }

  /**
   * Every Hyperliquid perp market in one page: volumes over `[fromIso, toIso]`,
   * and mark, funding and open interest as of now. `traderType` `sm` adds the
   * smart-money book (longs, shorts, counts); `whale` / `public_figure` the
   * same for those labels.
   */
  async perpScreener({ traderType = 'all', fromIso, toIso, page = 1, perPage = 1000, orderBy = null, tokenSymbol = null } = {}) {
    if (!SCREENER_TRADER_TYPES.includes(traderType)) throw new NansenError(`unknown trader_type '${traderType}' (one of ${SCREENER_TRADER_TYPES.join(', ')})`)
    if (!fromIso || !toIso) throw new NansenError('fromIso and toIso are required — the screener\'s volumes are over a range')
    const body = { date: { from: fromIso, to: toIso }, pagination: { page, per_page: perPage }, filters: { trader_type: traderType } }
    if (tokenSymbol) body.filters.token_symbol = tokenSymbol
    if (orderBy) body.order_by = orderBy
    return this.post('/api/v1/perp-screener', body)
  }

  /** Aggregated cohort holdings — the stock, where netflow is the flow. */
  async smartMoneyHoldings({ chains, cohort, perPage = 100, page = 1 }) {
    return this.post('/api/v1/smart-money/holdings', {
      chains,
      filters: { include_smart_money_labels: [cohort] },
      pagination: { page, per_page: perPage },
    })
  }

  /**
   * OHLCV for outcome pricing.
   *
   * Deliberately sourced from Nansen too. A study that takes its signal from one
   * vendor and its outcome from another inherits both vendors' timestamp
   * conventions, and a half-hour disagreement about when a candle closes is
   * enough to invent or erase an edge at short horizons. One clock, one source.
   */
  async tokenOhlcv({ chain, tokenAddress, from, to, interval = '1h' }) {
    return this.post('/api/v1/tgm/token-ohlcv', {
      chain, token_address: tokenAddress,
      date: { from, to },
      interval,
    })
  }

  // ─────────────────────────────────── the backtesting family, /api/v1beta1/

  /**
   * THE LOOK-AHEAD TRAP, AND THE CALLING CONVENTION THAT AVOIDS IT.
   *
   * From Nansen's own stability notes on the endpoint whose headline feature is
   * "no look-ahead bias":
   *
   *   "For tgm/historical-token-flow-summary, segment labels are resolved at
   *    date_to. For multi-date ranges, date_to is the cohort date used for
   *    segment membership across the requested flow window."
   *
   * Ask for eighteen months in one call and you get TODAY'S Smart Money list
   * applied backwards across all of it — including wallets that entered that
   * list BECAUSE of trades inside your test window. That is survivorship bias,
   * and the naive call is also the cheap one, so it is the call most people
   * will make.
   *
   * This method windows the request so `date_to` is each window's own end.
   * Look-ahead is then bounded by the window length and is a declared parameter
   * rather than an accident. One call per window, so it costs
   * ceil(range / window) x 5 credits instead of 5 — the price of the study
   * being a study.
   *
   * @param {object} o
   * @param {string} o.chain          ethereum | solana | base | bnb
   * @param {string} o.tokenAddress
   * @param {string} o.fromIso        start of the whole range
   * @param {string} o.toIso          end of the whole range
   * @param {number} o.windowDays     look-ahead bound, in days. Smaller = honester = dearer.
   * @param {(w:object)=>void} [o.onWindow]  progress callback per window
   */
  async flowSummaryWindowed({ chain, tokenAddress, fromIso, toIso, windowDays = 30, onWindow }) {
    if (!HISTORICAL_FLOW_CHAINS.includes(chain)) {
      throw new NansenError(`chain '${chain}' is not covered by historical-token-flow-summary (covered: ${HISTORICAL_FLOW_CHAINS.join(', ')}). SEI is not among them.`)
    }
    if (!(windowDays >= 1)) throw new NansenError('windowDays must be >= 1 — it IS the look-ahead bound, and an unbounded window is the bias this method exists to avoid')

    const startMs = Date.parse(fromIso)
    const endMs = Date.parse(toIso)
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      throw new NansenError(`bad range ${fromIso} -> ${toIso}`)
    }
    const stepMs = windowDays * 86_400_000
    const windows = []
    for (let a = startMs; a < endMs; a += stepMs) {
      const b = Math.min(a + stepMs, endMs)
      windows.push({ fromIso: new Date(a).toISOString(), toIso: new Date(b).toISOString() })
    }

    const results = []
    for (const w of windows) {
      const r = await this.post('/api/v1beta1/tgm/historical-token-flow-summary', {
        chain,
        token_address: tokenAddress,
        date_range: { from: w.fromIso, to: w.toIso },
        apply_blacklist_filter: true,
      })
      /** the bound travels with the data, so a verdict can state its own exposure */
      results.push({ ...r, window: w, lookAheadBoundDays: windowDays, labelsResolvedAt: w.toIso })
      if (onWindow) onWindow({ ...w, ok: r.ok, state: r.state })
    }
    return { chain, tokenAddress, windowDays, windows: results, lookAheadBoundDays: windowDays }
  }

  /**
   * ONE window, one row. The documented contract (read 2026-09-19 from the
   * endpoint's own page): "The endpoint returns a single aggregated row per
   * (token_address, date_to)." So a daily signal is a daily CALL — one per
   * token per day, `from` = `to` = that day — and the look-ahead bound is one
   * day. Everything in the study is built from this call; the windowed and
   * naive variants above exist to measure what a longer window costs.
   *
   * Date-only strings are UTC midnight on the venue, and end-inclusivity is
   * what `study.mjs` probes on its first calls rather than assumes.
   */
  async flowSummaryWindow({ chain, tokenAddress, fromDate, toDate }) {
    if (!HISTORICAL_FLOW_CHAINS.includes(chain)) {
      throw new NansenError(`chain '${chain}' is not covered by historical-token-flow-summary (covered: ${HISTORICAL_FLOW_CHAINS.join(', ')}). SEI is not among them.`)
    }
    const r = await this.post('/api/v1beta1/tgm/historical-token-flow-summary', {
      chain, token_address: tokenAddress,
      date_range: { from: fromDate, to: toDate },
      apply_blacklist_filter: true,
    })
    return { ...r, window: { fromDate, toDate }, labelsResolvedAt: toDate }
  }

  /**
   * The SAME data, requested the cheap way: one call, whole range, labels
   * resolved at the far end.
   *
   * Named for what it is. This exists ONLY as the comparison arm — running both
   * and differencing them is how you measure what the leak is worth, and that
   * number is the most useful thing this project can hand Nansen. It must never
   * be the arm a verdict is published from.
   */
  async flowSummaryNaive({ chain, tokenAddress, fromIso, toIso }) {
    const r = await this.post('/api/v1beta1/tgm/historical-token-flow-summary', {
      chain, token_address: tokenAddress,
      date_range: { from: fromIso, to: toIso },
      apply_blacklist_filter: true,
    })
    const days = Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000)
    return {
      ...r,
      lookAheadBoundDays: days,
      labelsResolvedAt: toIso,
      warning: `LEAKY BY CONSTRUCTION: segment membership resolved at ${toIso} and applied across ${days} days. Comparison arm only — never publish a verdict from this.`,
    }
  }

  /**
   * Historical OHLCV — the price tape the outcomes mature against.
   *
   * Refuses a TRUNCATED response rather than returning it. The cap is 50,000
   * candles and which end gets dropped depends on the chain: most chains omit
   * the MOST RECENT candles, Hyperliquid omits the OLDEST. Either way a
   * silently short tape produces forecasts that cannot mature and outcomes that
   * look absent rather than unavailable — the same absence-as-zero failure the
   * whole engine refuses elsewhere. Narrow the range and call again.
   */
  async historicalOhlcv({ chain, tokenAddress, fromIso, asOfIso, timeframe = '1h', allowTruncated = false }) {
    const body = { chain, token_address: tokenAddress, date_from: fromIso, as_of_date: asOfIso, timeframe }
    /** high-tf only; passing it with a low timeframe is a 400 from the venue */
    if (timeframe === '1d' || timeframe === '1w') body.apply_blacklist_filter = true

    const r = await this.post('/api/v1beta1/tgm/historical-token-ohlcv', body)
    if (r.ok && r.data?.truncated === true && !allowTruncated) {
      const note = r.data.truncation_note ?? 'no note supplied'
      this.log.push({ atIso: new Date().toISOString(), path: '/api/v1beta1/tgm/historical-token-ohlcv', cost: 0, state: 'truncation-refused', note: this.#redact(note) })
      return {
        ok: false, state: 'truncation-refused', cost: r.cost, data: null,
        note: `REFUSED a truncated tape for ${tokenAddress} ${timeframe}: ${note}. A short tape makes unmaturable forecasts look like absent outcomes. Narrow the range, or pass allowTruncated to accept it deliberately.`,
      }
    }
    return r
  }

  /** Free. Useful as a key/liveness probe that costs nothing to run often. */
  async account() { return this.post('/api/v1/account', {}) }

  /** The receipt: what was spent, on what, and how many calls it took. */
  spendReport() {
    const byPath = new Map()
    for (const r of this.log) {
      const e = byPath.get(r.path) ?? { calls: 0, credits: 0, ok: 0, refused: 0, errors: 0 }
      e.calls += 1
      e.credits += r.cost ?? 0
      if (r.state === 'ok') e.ok += 1
      else if (r.state === 'shape-refused') e.refused += 1
      else e.errors += 1
      byPath.set(r.path, e)
    }
    return {
      calls: this.calls,
      creditsSpent: this.spent,
      creditsRemaining: this.creditsRemaining,
      byPath: Object.fromEntries(byPath),
      /** the contest wants 1,000 logged API calls; this is the proof */
      contestProgress: `${this.calls} / 1000 API calls`,
    }
  }
}
