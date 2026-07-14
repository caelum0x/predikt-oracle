// TraderBot — an autonomous agent that keeps Predikt Oracle markets liquid
// and prices honest. Each cycle it forecasts every open market with the
// ASP's own estimate-odds tool and buys into any mispricing the strategy
// deems worth acting on. All network I/O goes through an injected fetchFn so
// tests can point the bot at an in-process app.

import { z } from 'zod'
import { ODDS_CONFIDENCE_LEVELS } from '../ai/schema'
import { decideTrade, type TradeSide } from './strategy'

// A cycle inspects at most this many open markets.
const MAX_MARKETS_PER_CYCLE = 10

export type FetchLike = (
  url: string,
  init?: RequestInit
) => Promise<Response>

export type StrategyOpts = {
  minEdge?: number
  maxStakeFraction?: number
}

export type TraderBotOptions = {
  baseUrl: string
  apiKey: string
  fetchFn?: FetchLike
  log?: (...args: unknown[]) => void
  strategyOpts?: StrategyOpts
}

export type CycleTrade = {
  marketId: string
  side: TradeSide
  amount: number
  edge: number
}

export type CycleSkip = { marketId: string; reason: string }

export type CycleError = { marketId: string | null; error: string }

export type CycleReport = {
  considered: number
  traded: CycleTrade[]
  skipped: CycleSkip[]
  errors: CycleError[]
}

// ---- response validation (never trust the wire) ---------------------------

const envelopeSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
})

const marketSchema = z.object({
  id: z.string(),
  question: z.string(),
  criteria: z.string(),
  closeTime: z.number(),
  probability: z.number(),
})

const marketsDataSchema = z.object({ markets: z.array(marketSchema) })

const balanceDataSchema = z.object({
  account: z.object({ balance: z.number() }),
})

const oddsDataSchema = z.object({
  estimate: z.object({
    probability: z.number().min(0).max(1),
    confidence: z.enum(ODDS_CONFIDENCE_LEVELS),
  }),
})

const buyDataSchema = z.object({
  trade: z.object({ balance: z.number() }),
})

type OpenMarket = z.infer<typeof marketSchema>

type ApiResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'rate-limited' }
  | { kind: 'error'; message: string }

// Epoch millis -> the YYYY-MM-DD deadline estimate-odds expects.
function toDeadline(closeTimeMs: number): string {
  return new Date(closeTimeMs).toISOString().slice(0, 10)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error'
}

export class TraderBot {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly fetchFn: FetchLike
  private readonly log: (...args: unknown[]) => void
  private readonly strategyOpts: StrategyOpts
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false

  constructor(options: TraderBotOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.apiKey = options.apiKey
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
    this.log = options.log ?? console.error
    this.strategyOpts = options.strategyOpts ?? {}
  }

  /**
   * Run a single trading cycle. Never throws: every failure is captured in
   * the returned report. A 429 from the odds tool aborts the cycle early so
   * the bot respects the service's rate limits.
   */
  async runOnce(): Promise<CycleReport> {
    const traded: CycleTrade[] = []
    const skipped: CycleSkip[] = []
    const errors: CycleError[] = []
    let considered = 0

    const marketsResult = await this.fetchOpenMarkets()
    if (marketsResult.kind !== 'ok') {
      errors.push({
        marketId: null,
        error: `list markets failed: ${describe(marketsResult)}`,
      })
      return { considered, traded, skipped, errors }
    }

    const balanceResult = await this.fetchBalance()
    if (balanceResult.kind !== 'ok') {
      errors.push({
        marketId: null,
        error: `fetch balance failed: ${describe(balanceResult)}`,
      })
      return { considered, traded, skipped, errors }
    }

    let balance = balanceResult.data
    const markets = marketsResult.data.slice(0, MAX_MARKETS_PER_CYCLE)

    for (const market of markets) {
      considered += 1

      const odds = await this.estimateOdds(market)
      if (odds.kind === 'rate-limited') {
        errors.push({
          marketId: market.id,
          error:
            'estimate-odds rate limited (429); stopping cycle to respect limits',
        })
        break
      }
      if (odds.kind === 'error') {
        errors.push({
          marketId: market.id,
          error: `estimate-odds failed: ${odds.message}`,
        })
        continue
      }

      const decision = decideTrade({
        marketProb: market.probability,
        estimatedProb: odds.data.probability,
        confidence: odds.data.confidence,
        balance,
        ...this.strategyOpts,
      })
      if (decision.action === 'skip') {
        skipped.push({ marketId: market.id, reason: decision.reason })
        continue
      }

      const buy = await this.executeBuy(market.id, decision.side, decision.amount)
      if (buy.kind !== 'ok') {
        errors.push({
          marketId: market.id,
          error: `buy failed: ${describe(buy)}`,
        })
        continue
      }
      balance = buy.data
      traded.push({
        marketId: market.id,
        side: decision.side,
        amount: decision.amount,
        edge: decision.edge,
      })
    }

    return { considered, traded, skipped, errors }
  }

  /** Loop runOnce forever, logging each cycle report as JSON. */
  runForever({ intervalMs }: { intervalMs: number }): void {
    if (this.running) return
    this.running = true
    const tick = async (): Promise<void> => {
      if (!this.running) return
      try {
        const report = await this.runOnce()
        this.log(JSON.stringify(report))
      } catch (err) {
        // runOnce never throws by design; this is a last-resort guard.
        this.log(`trader cycle crashed: ${errorMessage(err)}`)
      }
      if (this.running) {
        this.timer = setTimeout(() => void tick(), intervalMs)
      }
    }
    void tick()
  }

  /** Stop the runForever loop; safe to call at any time. */
  stop(): void {
    this.running = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  // ---- HTTP helpers --------------------------------------------------------

  private async fetchOpenMarkets(): Promise<ApiResult<OpenMarket[]>> {
    const result = await this.call('/markets?status=OPEN', {
      method: 'GET',
      dataSchema: marketsDataSchema,
    })
    return result.kind === 'ok'
      ? { kind: 'ok', data: result.data.markets }
      : result
  }

  private async fetchBalance(): Promise<ApiResult<number>> {
    const result = await this.call('/accounts/me', {
      method: 'GET',
      auth: true,
      dataSchema: balanceDataSchema,
    })
    return result.kind === 'ok'
      ? { kind: 'ok', data: result.data.account.balance }
      : result
  }

  private async estimateOdds(
    market: OpenMarket
  ): Promise<ApiResult<z.infer<typeof oddsDataSchema>['estimate']>> {
    const result = await this.call('/tools/estimate-odds', {
      method: 'POST',
      body: {
        question: market.question,
        resolutionCriteria: market.criteria,
        deadline: toDeadline(market.closeTime),
      },
      dataSchema: oddsDataSchema,
    })
    return result.kind === 'ok'
      ? { kind: 'ok', data: result.data.estimate }
      : result
  }

  private async executeBuy(
    marketId: string,
    side: TradeSide,
    amount: number
  ): Promise<ApiResult<number>> {
    const result = await this.call(`/markets/${marketId}/buy`, {
      method: 'POST',
      auth: true,
      body: { side, amount },
      dataSchema: buyDataSchema,
    })
    return result.kind === 'ok'
      ? { kind: 'ok', data: result.data.trade.balance }
      : result
  }

  // One place for fetch + envelope + zod validation. Returns 'rate-limited'
  // on 429, 'error' with a message otherwise; never throws.
  private async call<T>(
    path: string,
    opts: {
      method: 'GET' | 'POST'
      auth?: boolean
      body?: unknown
      dataSchema: z.ZodType<T>
    }
  ): Promise<ApiResult<T>> {
    let response: Response
    try {
      const headers: Record<string, string> = {}
      if (opts.auth) headers['Authorization'] = `Bearer ${this.apiKey}`
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: opts.method,
        headers,
        ...(opts.body !== undefined
          ? { body: JSON.stringify(opts.body) }
          : {}),
      })
    } catch (err) {
      return { kind: 'error', message: `network error: ${errorMessage(err)}` }
    }

    if (response.status === 429) return { kind: 'rate-limited' }

    let raw: unknown
    try {
      raw = await response.json()
    } catch {
      return { kind: 'error', message: `HTTP ${response.status}: not JSON` }
    }

    const envelope = envelopeSchema.safeParse(raw)
    if (!envelope.success) {
      return {
        kind: 'error',
        message: `HTTP ${response.status}: malformed envelope`,
      }
    }
    if (!envelope.data.success) {
      return {
        kind: 'error',
        message: `HTTP ${response.status}: ${
          envelope.data.error ?? 'request failed'
        }`,
      }
    }

    const data = opts.dataSchema.safeParse(
      (raw as { data?: unknown }).data
    )
    if (!data.success) {
      return {
        kind: 'error',
        message: `HTTP ${response.status}: unexpected response shape`,
      }
    }
    return { kind: 'ok', data: data.data }
  }
}

function describe(result: { kind: 'rate-limited' } | { kind: 'error'; message: string }): string {
  return result.kind === 'rate-limited' ? 'rate limited (429)' : result.message
}
