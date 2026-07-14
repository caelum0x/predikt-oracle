// Read-side activity API: per-market trade history, per-account trade history,
// portfolio valuation, and a global event feed that agents can poll.
// Follows the markets.ts route conventions: {success, data?, error?} envelope,
// zod-validated inputs, Bearer auth via service.getAccountByKey.

import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import { z } from 'zod'
import type { Db } from '../engine/store'
import { round6 } from '../engine/cpmm'
import {
  MarketService,
  ServiceError,
  type Account,
  type Market,
  type Position,
} from '../engine/service'

type ApiResponse<T> = { success: boolean; data?: T; error?: string }

type Env = { Variables: { account: Account } }

type TradeRow = {
  id: string
  market_id: string
  account_id: string
  kind: 'BUY' | 'SELL'
  side: 'YES' | 'NO'
  answer_id: string | null
  amount: number
  shares: number
  fee: number
  prob_before: number
  prob_after: number
  created_at: number
}

type AccountTradeRow = TradeRow & { question: string }

type CreatedFeedRow = {
  id: string
  question: string
  created_at: number
  outcome_type: 'BINARY' | 'MULTI'
  pool_yes: number
  pool_no: number
  pool_p: number
}

type AnswerPoolRow = {
  market_id: string
  pool_yes: number
  pool_no: number
  pool_p: number
}

type ResolvedFeedRow = {
  id: string
  question: string
  // YES | NO | CANCEL for binary markets, the winning answer id for MULTI.
  outcome: string
  resolved_at: number
}

type TradeFeedRow = {
  market_id: string
  question: string
  side: 'YES' | 'NO'
  kind: 'BUY' | 'SELL'
  amount: number
  prob_after: number
  created_at: number
}

export type FeedEvent =
  | {
      type: 'trade'
      marketId: string
      question: string
      side: 'YES' | 'NO'
      kind: 'BUY' | 'SELL'
      amount: number
      probAfter: number
      createdAt: number
    }
  | {
      type: 'market_created'
      marketId: string
      question: string
      probability: number
      createdAt: number
    }
  | {
      type: 'resolved'
      marketId: string
      question: string
      outcome: string
      createdAt: number
    }

const tradesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
})

const feedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
})

function ok<T>(c: Context, data: T) {
  return c.json({ success: true, data } satisfies ApiResponse<T>, 200)
}

function failFrom(c: Context, err: unknown) {
  if (err instanceof ServiceError) {
    return c.json(
      { success: false, error: err.message } satisfies ApiResponse<never>,
      err.status
    )
  }
  console.error(
    'activity route unexpected error:',
    err instanceof Error ? err.message : 'unknown error'
  )
  return c.json(
    { success: false, error: 'Unexpected server error.' } satisfies ApiResponse<never>,
    500
  )
}

function parseQuery<S extends z.ZodTypeAny>(
  c: Context,
  schema: S
): { data: z.infer<S> } | { error: string } {
  const result = schema.safeParse({
    limit: c.req.query('limit') || undefined,
    before: c.req.query('before') || undefined,
  })
  if (!result.success) {
    return {
      error:
        'Invalid query: limit must be a positive integer within range and before an epoch-ms integer.',
    }
  }
  return { data: result.data }
}

function toTradeItem(row: TradeRow) {
  return {
    tradeId: row.id,
    kind: row.kind,
    side: row.side,
    // Binary trades keep their historical shape; MULTI trades carry the
    // answer they targeted.
    ...(row.answer_id ? { answerId: row.answer_id } : {}),
    amount: round6(row.amount),
    shares: round6(row.shares),
    fee: round6(row.fee),
    probBefore: round6(row.prob_before),
    probAfter: round6(row.prob_after),
    createdAt: row.created_at,
    accountId: row.account_id,
  }
}

// Mark-to-market value of a position: probability-weighted for live markets,
// settlement value once resolved (CANCEL refunds the net cost basis). MULTI
// positions are valued against their answer's own pool probability.
function markValueOf(market: Market, pos: Position): number {
  if (market.outcomeType === 'MULTI' && pos.answerId) {
    if (market.status === 'RESOLVED') {
      if (market.outcome === 'CANCEL') return round6(pos.invested)
      return round6(
        pos.answerId === market.outcome ? pos.yesShares : pos.noShares
      )
    }
    const answer = market.answers?.find((a) => a.id === pos.answerId)
    const prob = answer?.probability ?? 0
    return round6(pos.yesShares * prob + pos.noShares * (1 - prob))
  }
  if (market.status === 'RESOLVED') {
    if (market.outcome === 'YES') return round6(pos.yesShares)
    if (market.outcome === 'NO') return round6(pos.noShares)
    return round6(pos.invested)
  }
  return round6(
    pos.yesShares * market.probability + pos.noShares * (1 - market.probability)
  )
}

const MAX_EPOCH = Number.MAX_SAFE_INTEGER

export function createActivityRoutes(service: MarketService, db: Db): Hono<Env> {
  const app = new Hono<Env>()

  const auth: MiddlewareHandler<Env> = async (c, next) => {
    const header = c.req.header('Authorization') ?? ''
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const account = key ? service.getAccountByKey(key) : null
    if (!account) {
      return failFrom(
        c,
        new ServiceError(401, 'Provide a valid API key: Authorization: Bearer pk_...')
      )
    }
    c.set('account', account)
    await next()
  }

  // Public: trade history for one market, newest first, cursor on created_at.
  app.get('/markets/:id/trades', (c) => {
    const parsed = parseQuery(c, tradesQuerySchema)
    if ('error' in parsed) return failFrom(c, new ServiceError(400, parsed.error))
    try {
      const market = service.getMarket(c.req.param('id')) // 404 if unknown
      const rows = db
        .prepare(
          `SELECT * FROM trades
           WHERE market_id = ? AND created_at < ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?`
        )
        .all(
          market.id,
          parsed.data.before ?? MAX_EPOCH,
          parsed.data.limit
        ) as TradeRow[]
      return ok(c, { trades: rows.map(toTradeItem) })
    } catch (err) {
      return failFrom(c, err)
    }
  })

  // Authed: the caller's own trade history across markets.
  app.get('/accounts/me/trades', auth, (c) => {
    const parsed = parseQuery(c, tradesQuerySchema)
    if ('error' in parsed) return failFrom(c, new ServiceError(400, parsed.error))
    try {
      const rows = db
        .prepare(
          `SELECT t.*, m.question AS question
           FROM trades t
           JOIN markets m ON m.id = t.market_id
           WHERE t.account_id = ? AND t.created_at < ?
           ORDER BY t.created_at DESC, t.id DESC
           LIMIT ?`
        )
        .all(
          c.get('account').id,
          parsed.data.before ?? MAX_EPOCH,
          parsed.data.limit
        ) as AccountTradeRow[]
      const trades = rows.map((row) => ({
        ...toTradeItem(row),
        marketId: row.market_id,
        question: row.question,
      }))
      return ok(c, { trades })
    } catch (err) {
      return failFrom(c, err)
    }
  })

  // Authed: open positions marked to market, plus account-level totals.
  app.get('/accounts/me/portfolio', auth, (c) => {
    try {
      const accountId = c.get('account').id
      // One market fetch per market, not per answer position.
      const marketCache = new Map<string, Market>()
      const marketOf = (id: string): Market => {
        const cached = marketCache.get(id)
        if (cached) return cached
        const market = service.getMarket(id)
        marketCache.set(id, market)
        return market
      }
      const positions = service.getPositions(accountId).map((pos) => {
        const market = marketOf(pos.marketId)
        const markValue = markValueOf(market, pos)
        const answer = pos.answerId
          ? market.answers?.find((a) => a.id === pos.answerId)
          : undefined
        return {
          marketId: market.id,
          question: market.question,
          status: market.status,
          outcome: market.outcome,
          probability: market.probability,
          // MULTI positions identify their answer and its own probability.
          ...(pos.answerId
            ? {
                answerId: pos.answerId,
                answerText: answer?.text ?? null,
                answerProbability: answer?.probability ?? null,
              }
            : {}),
          yesShares: pos.yesShares,
          noShares: pos.noShares,
          invested: pos.invested,
          markValue,
          unrealizedPnl: round6(markValue - pos.invested),
        }
      })
      const totals = positions.reduce(
        (acc, p) => ({
          ...acc,
          portfolioValue: round6(acc.portfolioValue + p.markValue),
          totalInvested: round6(acc.totalInvested + p.invested),
          totalUnrealizedPnl: round6(acc.totalUnrealizedPnl + p.unrealizedPnl),
        }),
        {
          balance: service.getAccount(accountId).balance,
          portfolioValue: 0,
          totalInvested: 0,
          totalUnrealizedPnl: 0,
        }
      )
      return ok(c, { positions, totals })
    } catch (err) {
      return failFrom(c, err)
    }
  })

  // Public: merged newest-first activity stream across all markets.
  app.get('/feed', (c) => {
    const result = feedQuerySchema.safeParse({
      limit: c.req.query('limit') || undefined,
    })
    if (!result.success) {
      return failFrom(c, new ServiceError(400, 'limit must be an integer from 1 to 100.'))
    }
    try {
      return ok(c, { events: buildFeed(db, result.data.limit) })
    } catch (err) {
      return failFrom(c, err)
    }
  })

  return app
}

function buildFeed(db: Db, limit: number): FeedEvent[] {
  const tradeRows = db
    .prepare(
      `SELECT t.market_id, m.question, t.side, t.kind, t.amount, t.prob_after, t.created_at
       FROM trades t
       JOIN markets m ON m.id = t.market_id
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT ?`
    )
    .all(limit) as TradeFeedRow[]

  const createdRows = db
    .prepare(
      `SELECT id, question, created_at, outcome_type, pool_yes, pool_no, pool_p
       FROM markets ORDER BY created_at DESC LIMIT ?`
    )
    .all(limit) as CreatedFeedRow[]

  // Probabilities are computed from the pool columns already fetched — plus
  // one bulk answers query for the MULTI markets in the page — instead of a
  // per-market service.getMarket() round trip (an N+1 on a public endpoint).
  const probabilityByMarket = feedProbabilities(db, createdRows)

  const resolvedRows = db
    .prepare(
      `SELECT id, question, outcome, resolved_at FROM markets
       WHERE status = 'RESOLVED' AND resolved_at IS NOT NULL
       ORDER BY resolved_at DESC LIMIT ?`
    )
    .all(limit) as ResolvedFeedRow[]

  const events: FeedEvent[] = [
    ...tradeRows.map(
      (row): FeedEvent => ({
        type: 'trade',
        marketId: row.market_id,
        question: row.question,
        side: row.side,
        kind: row.kind,
        amount: round6(row.amount),
        probAfter: round6(row.prob_after),
        createdAt: row.created_at,
      })
    ),
    ...createdRows.map(
      (row): FeedEvent => ({
        type: 'market_created',
        marketId: row.id,
        question: row.question,
        probability: probabilityByMarket.get(row.id) ?? 0,
        createdAt: row.created_at,
      })
    ),
    ...resolvedRows.map(
      (row): FeedEvent => ({
        type: 'resolved',
        marketId: row.id,
        question: row.question,
        outcome: row.outcome,
        createdAt: row.resolved_at,
      })
    ),
  ]

  return [...events].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
}

// CPMM YES-price straight from stored pool columns (mirrors cpmm.getProb).
function poolProb(row: { pool_yes: number; pool_no: number; pool_p: number }): number {
  const { pool_yes: yes, pool_no: no, pool_p: p } = row
  return (p * no) / (p * no + (1 - p) * yes)
}

// Market probability for each feed row: the market's own pool for BINARY,
// the leading answer's pool for MULTI (same rule as rows.toMarket). All
// MULTI answer pools for the page are fetched in one query.
function feedProbabilities(
  db: Db,
  rows: readonly CreatedFeedRow[]
): Map<string, number> {
  const raw = new Map<string, number>()
  const multiIds: string[] = []
  for (const row of rows) {
    if (row.outcome_type === 'MULTI') {
      multiIds.push(row.id)
      raw.set(row.id, 0) // no answers -> 0, like toMarket
    } else {
      raw.set(row.id, poolProb(row))
    }
  }

  if (multiIds.length > 0) {
    const placeholders = multiIds.map(() => '?').join(', ')
    const answerRows = db
      .prepare(
        `SELECT market_id, pool_yes, pool_no, pool_p FROM answers
         WHERE market_id IN (${placeholders}) ORDER BY ord ASC`
      )
      .all(...multiIds) as AnswerPoolRow[]
    for (const answer of answerRows) {
      const prob = poolProb(answer)
      const best = raw.get(answer.market_id) ?? 0
      // Strictly-greater keeps the earliest (lowest ord) answer on ties,
      // matching answers.leadingAnswer's 1e-12 epsilon rule.
      if (prob > best + 1e-12) raw.set(answer.market_id, prob)
    }
  }

  const probabilities = new Map<string, number>()
  for (const [id, prob] of raw) probabilities.set(id, round6(prob))
  return probabilities
}
