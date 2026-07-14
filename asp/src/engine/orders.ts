// Limit orders resting against the AMM. An order reserves funds at placement
// (the full amount is debited up front), then fills by executing normal AMM
// buys — spending from the reservation, never the live balance — while the
// market price is on the maker's side of the limit:
//
//   YES order: fills while probability < limit_prob (buy YES at or below).
//   NO  order: fills while probability > limit_prob (buy NO at or above).
//
// Matching runs synchronously inside the same better-sqlite3 transaction as
// the mutation that triggered it (placement, buy, sell, or a fill), fills in
// bounded slices, and respects priority: best price first, then FIFO.
//
// The OrderBook receives the service's transaction-scoped primitives through
// OrderBookDeps so fills reuse the exact buy-path math (including the 1% fee
// to the market creator) without duplicating MarketService internals.

import type { Db } from './store'
import { ServiceError } from './errors'
import { calcBuy, CpmmError, getProb, round6, type Pool, type Side } from './cpmm'
import { newId } from './ids'
import { insertTrade } from './trades'
import type { MarketRow } from './rows'

export type OrderStatus = 'OPEN' | 'FILLED' | 'CANCELLED'

export const ORDER_STATUSES = ['OPEN', 'FILLED', 'CANCELLED'] as const

export const MIN_ORDER_AMOUNT = 1
export const MAX_ORDER_AMOUNT = 1_000_000
export const MIN_LIMIT_PROB = 0.01
export const MAX_LIMIT_PROB = 0.99

// Matching is bounded: at most this many fill slices per matching pass. Any
// still-marketable orders resume on the next balance-affecting trade.
const MAX_SLICES_PER_PASS = 20
// A limit counts as crossed only when the price is strictly past it.
const PROB_EPS = 1e-9

export type OrderRow = {
  id: string
  market_id: string
  answer_id: string | null
  account_id: string
  side: Side
  limit_prob: number
  amount_total: number
  amount_remaining: number
  status: OrderStatus
  created_at: number
  updated_at: number
}

// Public API shape of an order.
export type LimitOrder = {
  id: string
  marketId: string
  answerId: string | null
  accountId: string
  side: Side
  limitProb: number
  amountTotal: number
  amountRemaining: number
  status: OrderStatus
  createdAt: number
  updatedAt: number
}

// One anonymized price level of the public order book.
export type OrderLevel = {
  side: Side
  answerId: string | null
  limitProb: number
  amount: number
}

export type PlaceOrderInput = {
  side: Side
  limitProb: number
  amount: number
  answerId: string | null
}

// The pool a fill executes against, plus a persister bound to that target
// (market pool for BINARY, one answer's pool for MULTI).
export type OrderTarget = {
  pool: Pool
  answerId: string | null
  save(pool: Pool, tradeAmount: number): void
}

export type OrderBookDeps = {
  feeRate: number
  getMarketRow(id: string): MarketRow
  target(row: MarketRow, answerId: string | null): OrderTarget
  adjustPosition(
    accountId: string,
    marketId: string,
    answerKey: string,
    side: Side,
    sharesDelta: number,
    investedDelta: number
  ): void
  credit(accountId: string, amount: number): void
  debit(accountId: string, amount: number, what: string): void
}

export function toLimitOrder(row: OrderRow): LimitOrder {
  return {
    id: row.id,
    marketId: row.market_id,
    answerId: row.answer_id,
    accountId: row.account_id,
    side: row.side,
    limitProb: row.limit_prob,
    amountTotal: round6(row.amount_total),
    amountRemaining: round6(row.amount_remaining),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class OrderBook {
  constructor(
    private readonly db: Db,
    private readonly deps: OrderBookDeps
  ) {}

  /**
   * Places an order inside the caller's transaction: validates, debits the
   * full amount as a reservation, inserts the row, then runs a matching pass
   * (a marketable order fills immediately). Returns the post-match order.
   */
  place(accountId: string, market: MarketRow, input: PlaceOrderInput): LimitOrder {
    if (
      !Number.isFinite(input.limitProb) ||
      input.limitProb < MIN_LIMIT_PROB ||
      input.limitProb > MAX_LIMIT_PROB
    ) {
      throw new ServiceError(
        400,
        `limitProb must be between ${MIN_LIMIT_PROB} and ${MAX_LIMIT_PROB}.`
      )
    }
    if (
      !Number.isFinite(input.amount) ||
      input.amount < MIN_ORDER_AMOUNT ||
      input.amount > MAX_ORDER_AMOUNT
    ) {
      throw new ServiceError(
        400,
        `Order amount must be between ${MIN_ORDER_AMOUNT} and ${MAX_ORDER_AMOUNT} credits.`
      )
    }
    // Validates the target: rejects a missing/unknown answerId on MULTI
    // markets and a stray answerId on BINARY markets.
    const target = this.deps.target(market, input.answerId)

    this.deps.debit(accountId, input.amount, 'limit order reserve')
    const id = newId('ord')
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO limit_orders
          (id, market_id, answer_id, account_id, side, limit_prob,
           amount_total, amount_remaining, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)`
      )
      .run(
        id,
        market.id,
        target.answerId,
        accountId,
        input.side,
        input.limitProb,
        round6(input.amount),
        round6(input.amount),
        now,
        now
      )
    this.match(market.id)
    return toLimitOrder(this.requireOrderRow(id))
  }

  /** Cancels an OPEN order (owner only) and refunds the unfilled reservation. */
  cancel(accountId: string, orderId: string): LimitOrder {
    const row = this.getOrderRow(orderId)
    if (!row) throw new ServiceError(404, 'Order not found.')
    if (row.account_id !== accountId) {
      throw new ServiceError(403, 'Only the order owner can cancel it.')
    }
    if (row.status !== 'OPEN') {
      throw new ServiceError(409, `Order is already ${row.status}.`)
    }
    const refund = round6(row.amount_remaining)
    if (refund > 0) this.deps.credit(accountId, refund)
    this.db
      .prepare("UPDATE limit_orders SET status = 'CANCELLED', updated_at = ? WHERE id = ?")
      .run(Date.now(), orderId)
    return toLimitOrder(this.requireOrderRow(orderId))
  }

  /**
   * Cancels every OPEN order on a market and refunds each reservation. Called
   * when the market resolves (any outcome, including CANCEL).
   */
  cancelAllOpen(marketId: string): void {
    const rows = this.db
      .prepare("SELECT * FROM limit_orders WHERE market_id = ? AND status = 'OPEN'")
      .all(marketId) as OrderRow[]
    const now = Date.now()
    for (const row of rows) {
      const refund = round6(row.amount_remaining)
      if (refund > 0) this.deps.credit(row.account_id, refund)
      this.db
        .prepare("UPDATE limit_orders SET status = 'CANCELLED', updated_at = ? WHERE id = ?")
        .run(now, row.id)
    }
  }

  /** The caller's own orders, newest first, optionally filtered by status. */
  listForAccount(accountId: string, status?: OrderStatus): LimitOrder[] {
    const rows = (
      status
        ? this.db
            .prepare(
              `SELECT * FROM limit_orders WHERE account_id = ? AND status = ?
               ORDER BY rowid DESC LIMIT 200`
            )
            .all(accountId, status)
        : this.db
            .prepare(
              `SELECT * FROM limit_orders WHERE account_id = ?
               ORDER BY rowid DESC LIMIT 200`
            )
            .all(accountId)
    ) as OrderRow[]
    return rows.map(toLimitOrder)
  }

  /** Anonymized public order book: open amount per price level, no accounts. */
  levels(marketId: string): OrderLevel[] {
    const rows = this.db
      .prepare(
        `SELECT side, answer_id, limit_prob, SUM(amount_remaining) AS amount
         FROM limit_orders
         WHERE market_id = ? AND status = 'OPEN'
         GROUP BY side, answer_id, limit_prob
         ORDER BY side ASC, limit_prob DESC`
      )
      .all(marketId) as {
      side: Side
      answer_id: string | null
      limit_prob: number
      amount: number
    }[]
    return rows.map((row) => ({
      side: row.side,
      answerId: row.answer_id,
      limitProb: row.limit_prob,
      amount: round6(row.amount),
    }))
  }

  /**
   * One matching pass: repeatedly picks the highest-priority marketable order
   * and fills one bounded slice, re-reading market state between slices so
   * every fill sees the price its predecessors set. Runs inside the caller's
   * transaction; bounded at MAX_SLICES_PER_PASS slices.
   */
  match(marketId: string): void {
    for (let slice = 0; slice < MAX_SLICES_PER_PASS; slice++) {
      const market = this.deps.getMarketRow(marketId)
      if (market.status !== 'OPEN' || Date.now() >= market.close_time) return
      const order = this.bestMarketableOrder(market)
      if (!order) return
      this.fillSlice(market, order)
    }
  }

  // ---- internals ----------------------------------------------------------

  private getOrderRow(id: string): OrderRow | null {
    const row = this.db
      .prepare('SELECT * FROM limit_orders WHERE id = ?')
      .get(id) as OrderRow | undefined
    return row ?? null
  }

  private requireOrderRow(id: string): OrderRow {
    const row = this.getOrderRow(id)
    if (!row) throw new ServiceError(404, 'Order not found.')
    return row
  }

  /**
   * The next order to fill: largest price margin first (YES: limit - prob,
   * NO: prob - limit — so a higher YES limit / lower NO limit wins), FIFO on
   * ties (rows scan in insertion order — rowid is monotonic even within one
   * millisecond — and only a strictly better margin displaces the incumbent).
   */
  private bestMarketableOrder(market: MarketRow): OrderRow | null {
    const rows = this.db
      .prepare(
        `SELECT * FROM limit_orders WHERE market_id = ? AND status = 'OPEN'
         ORDER BY rowid ASC`
      )
      .all(market.id) as OrderRow[]
    let best: OrderRow | null = null
    let bestMargin = PROB_EPS
    for (const row of rows) {
      const prob = getProb(this.deps.target(market, row.answer_id).pool)
      const margin = row.side === 'YES' ? row.limit_prob - prob : prob - row.limit_prob
      if (margin > bestMargin) {
        best = row
        bestMargin = margin
      }
    }
    return best
  }

  /**
   * Executes one fill slice of min(remaining, max(1, remaining / 4)) as a
   * normal AMM buy paid from the order's reservation: fee to the creator,
   * pool moves, position grows, and the fill lands in the trade ledger.
   */
  private fillSlice(market: MarketRow, order: OrderRow): void {
    const remaining = round6(order.amount_remaining)
    const slice = round6(Math.min(remaining, Math.max(1, remaining / 4)))
    const fee = round6(slice * this.deps.feeRate)
    const target = this.deps.target(market, order.answer_id)
    const probBefore = getProb(target.pool)

    let result: ReturnType<typeof calcBuy>
    try {
      result = calcBuy(target.pool, order.side, round6(slice - fee))
    } catch (err) {
      if (err instanceof CpmmError) {
        // The residual reservation is too small for the AMM to price (dust).
        // Refund it and close the order so matching cannot loop on it.
        if (remaining > 0) this.deps.credit(order.account_id, remaining)
        this.db
          .prepare(
            "UPDATE limit_orders SET status = 'CANCELLED', updated_at = ? WHERE id = ?"
          )
          .run(Date.now(), order.id)
        return
      }
      throw err
    }

    // The reservation already left the balance at placement — no debit here.
    this.deps.credit(market.creator_id, fee)
    target.save(result.newPool, slice)
    // Cost basis is pool-net (slice minus fee), mirroring MarketService.buy:
    // a CANCEL refund of `invested` must not include fees already paid out.
    this.deps.adjustPosition(
      order.account_id,
      market.id,
      order.answer_id ?? '',
      order.side,
      result.shares,
      round6(slice - fee)
    )
    insertTrade(this.db, {
      marketId: market.id,
      accountId: order.account_id,
      kind: 'BUY',
      side: order.side,
      answerId: order.answer_id,
      amount: slice,
      shares: result.shares,
      fee,
      probBefore,
      probAfter: result.probAfter,
    })

    const newRemaining = round6(remaining - slice)
    const status: OrderStatus = newRemaining <= 0 ? 'FILLED' : 'OPEN'
    this.db
      .prepare(
        'UPDATE limit_orders SET amount_remaining = ?, status = ?, updated_at = ? WHERE id = ?'
      )
      .run(Math.max(0, newRemaining), status, Date.now(), order.id)
  }
}
