// Business logic for the agent prediction market. All mutations run inside
// SQLite transactions; every balance/share change is atomic. Amounts are in
// PRED credits (1 credit = 1 USDT-equivalent once x402 deposits are wired).
//
// Two market shapes share one engine:
//   BINARY — a single YES/NO CPMM pool stored on the market row.
//   MULTI  — one independent binary CPMM pool per answer (answers table);
//            trades target an answer via answerId, and resolution declares
//            one winning answer (its YES shares pay 1, every other answer's
//            NO shares pay 1) or CANCEL.

import type { Db } from './store'
import { ServiceError } from './errors'
import { hashApiKey, newApiKey, newId } from './ids'
import { insertTrade } from './trades'
import {
  OrderBook,
  type LimitOrder,
  type OrderLevel,
  type OrderStatus,
  type PlaceOrderInput,
} from './orders'
import {
  calcBuy,
  calcSell,
  CpmmError,
  getProb,
  initPool,
  round6,
  type Pool,
  type Side,
} from './cpmm'
import {
  AnswerValidationError,
  creatorRefundForWinner,
  getAnswerRow,
  initialAnswerProb,
  insertAnswer,
  listAnswerRows,
  normalizeAnswerTexts,
  rowToPool,
  saveAnswerPool,
  type AnswerRow,
  type AnswerView,
} from './answers'
import {
  rowPool,
  toAccount,
  toMarket,
  toPosition,
  type AccountRow,
  type MarketRow,
  type PositionRow,
} from './rows'

export type { AnswerView } from './answers'
export { ServiceError } from './errors'
export type { LimitOrder, OrderLevel, OrderStatus } from './orders'

// Every new agent account starts with a play-money grant so the market is
// usable the moment an agent signs up. Replaced by x402 deposits later.
export const SIGNUP_GRANT = 1000
// Fee on buys, credited to the market creator (their incentive to make
// well-specified markets). Sells are fee-free.
export const BUY_FEE_RATE = 0.01
export const MIN_SUBSIDY = 10
export const MAX_QUESTION_LEN = 240

export type MarketStatus = 'OPEN' | 'CLOSED' | 'RESOLVED'
export type OutcomeType = 'BINARY' | 'MULTI'
// Binary outcomes. MULTI markets resolve to a winning answer id or 'CANCEL',
// so market rows store outcomes as plain strings.
export type Outcome = 'YES' | 'NO' | 'CANCEL'

export type Account = {
  id: string
  name: string
  balance: number
  createdAt: number
}

export type Market = {
  id: string
  creatorId: string
  question: string
  description: string
  criteria: string
  category: string
  closeTime: number
  status: MarketStatus
  outcomeType: OutcomeType
  // YES | NO | CANCEL for BINARY; winning answer id or CANCEL for MULTI.
  outcome: string | null
  // For MULTI markets: probability of the current leading answer.
  probability: number
  subsidy: number
  volume: number
  createdAt: number
  resolvedAt: number | null
  // Present only on MULTI markets.
  answers?: AnswerView[]
}

export type Position = {
  accountId: string
  marketId: string
  // null for binary-market positions; the answer id for MULTI positions.
  answerId: string | null
  yesShares: number
  noShares: number
  invested: number
}

export type CreateMarketInput = {
  question: string
  criteria: string
  description?: string
  category?: string
  closeTime: number
  initialProb?: number
  subsidy?: number
  outcomeType?: OutcomeType
  answers?: string[]
}

// The pool a trade executes against: the market's own pool for BINARY, one
// answer's pool for MULTI.
type TradeTarget = {
  pool: Pool
  answer: AnswerRow | null
}

export class MarketService {
  // Limit orders resting against the AMM. The book borrows this service's
  // transaction-scoped primitives so fills execute the exact buy-path math.
  private readonly orderBook: OrderBook

  constructor(private readonly db: Db) {
    this.orderBook = new OrderBook(db, {
      feeRate: BUY_FEE_RATE,
      getMarketRow: (id) => this.getMarketRow(id),
      target: (row, answerId) => {
        const target = this.tradeTarget(row, answerId ?? undefined)
        return {
          pool: target.pool,
          answerId: target.answer?.id ?? null,
          save: (pool, tradeAmount) =>
            this.saveTargetPool(row, target, pool, tradeAmount),
        }
      },
      adjustPosition: (accountId, marketId, answerKey, side, shares, invested) =>
        this.adjustPosition(accountId, marketId, answerKey, side, shares, invested),
      credit: (accountId, amount) => this.credit(accountId, amount),
      debit: (accountId, amount, what) => this.debit(accountId, amount, what),
    })
  }

  // ---- accounts -----------------------------------------------------------

  createAccount(name: string): { account: Account; apiKey: string } {
    const trimmed = name.trim()
    if (trimmed.length < 2 || trimmed.length > 80) {
      throw new ServiceError(400, 'Account name must be 2-80 characters.')
    }
    const apiKey = newApiKey()
    const id = newId('acct')
    const now = Date.now()
    this.db
      .prepare(
        'INSERT INTO accounts (id, name, api_key_hash, balance, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(id, trimmed, hashApiKey(apiKey), SIGNUP_GRANT, now)
    return {
      account: { id, name: trimmed, balance: SIGNUP_GRANT, createdAt: now },
      apiKey,
    }
  }

  getAccountByKey(apiKey: string): Account | null {
    const row = this.db
      .prepare('SELECT * FROM accounts WHERE api_key_hash = ?')
      .get(hashApiKey(apiKey)) as AccountRow | undefined
    return row ? toAccount(row) : null
  }

  getAccount(id: string): Account {
    const row = this.db
      .prepare('SELECT * FROM accounts WHERE id = ?')
      .get(id) as AccountRow | undefined
    if (!row) throw new ServiceError(404, 'Account not found.')
    return toAccount(row)
  }

  getPositions(accountId: string): Position[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM positions WHERE account_id = ? AND (yes_shares > 0 OR no_shares > 0)'
      )
      .all(accountId) as PositionRow[]
    return rows.map(toPosition)
  }

  // ---- markets ------------------------------------------------------------

  createMarket(creatorId: string, input: CreateMarketInput): Market {
    const question = input.question.trim()
    const criteria = input.criteria.trim()
    if (question.length < 8 || question.length > MAX_QUESTION_LEN) {
      throw new ServiceError(400, 'Question must be 8-240 characters.')
    }
    if (criteria.length < 10) {
      throw new ServiceError(
        400,
        'Resolution criteria must be at least 10 characters.'
      )
    }
    if (!Number.isFinite(input.closeTime) || input.closeTime <= Date.now()) {
      throw new ServiceError(400, 'closeTime must be in the future.')
    }
    const subsidy = input.subsidy ?? MIN_SUBSIDY
    if (subsidy < MIN_SUBSIDY) {
      throw new ServiceError(400, `Subsidy must be at least ${MIN_SUBSIDY}.`)
    }

    const outcomeType: OutcomeType = input.outcomeType ?? 'BINARY'
    let answerTexts: string[] | null = null
    if (outcomeType === 'MULTI') {
      if (!input.answers) {
        throw new ServiceError(400, 'MULTI markets require an answers array.')
      }
      if (input.initialProb !== undefined) {
        throw new ServiceError(
          400,
          'initialProb is not supported for MULTI markets; each answer starts at 1/answers.length.'
        )
      }
      try {
        answerTexts = normalizeAnswerTexts(input.answers)
      } catch (err) {
        throw new ServiceError(
          400,
          err instanceof AnswerValidationError ? err.message : 'Invalid answers.'
        )
      }
    } else if (input.answers !== undefined) {
      throw new ServiceError(400, 'answers are only valid for MULTI markets.')
    }

    // BINARY: the tradable pool. MULTI: a placeholder that satisfies the
    // schema; MULTI trading only ever touches the per-answer pools.
    let pool: Pool
    try {
      pool =
        outcomeType === 'MULTI'
          ? initPool(subsidy, 0.5)
          : initPool(subsidy, input.initialProb ?? 0.5)
    } catch (err) {
      throw new ServiceError(
        400,
        err instanceof CpmmError ? err.message : 'Invalid market parameters.'
      )
    }

    const run = this.db.transaction((): Market => {
      this.debit(creatorId, subsidy, 'market subsidy')
      const id = newId('mkt')
      const now = Date.now()
      this.db
        .prepare(
          `INSERT INTO markets
            (id, creator_id, question, description, criteria, category,
             close_time, status, outcome_type, pool_yes, pool_no, pool_p,
             pool_k, subsidy, volume, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, 0, ?)`
        )
        .run(
          id,
          creatorId,
          question,
          input.description?.trim() ?? '',
          criteria,
          input.category?.trim() || 'General',
          input.closeTime,
          outcomeType,
          pool.yes,
          pool.no,
          pool.p,
          pool.k,
          subsidy,
          now
        )
      if (answerTexts) {
        // The subsidy is split equally across the answers; each answer pool
        // opens at probability 1/n (clamped to the CPMM's valid range).
        const perAnswer = subsidy / answerTexts.length
        const prob = initialAnswerProb(answerTexts.length)
        answerTexts.forEach((text, ord) => {
          insertAnswer(this.db, {
            marketId: id,
            ord,
            text,
            pool: initPool(perAnswer, prob),
          })
        })
      }
      return this.getMarket(id)
    })
    return run()
  }

  listMarkets(status?: MarketStatus): Market[] {
    const rows = (
      status
        ? this.db
            .prepare(
              'SELECT * FROM markets WHERE status = ? ORDER BY created_at DESC LIMIT 200'
            )
            .all(status)
        : this.db
            .prepare('SELECT * FROM markets ORDER BY created_at DESC LIMIT 200')
            .all()
    ) as MarketRow[]
    return rows.map((row) => this.hydrateMarket(row))
  }

  getMarket(id: string): Market {
    return this.hydrateMarket(this.getMarketRow(id))
  }

  // ---- trading ------------------------------------------------------------

  quote(
    marketId: string,
    side: Side,
    amount: number,
    answerId?: string
  ): {
    shares: number
    probBefore: number
    probAfter: number
    fee: number
  } {
    const row = this.requireTradable(this.getMarketRow(marketId))
    const target = this.tradeTarget(row, answerId)
    const fee = round6(amount * BUY_FEE_RATE)
    const result = this.tryCpmm(() =>
      calcBuy(target.pool, side, round6(amount - fee))
    )
    return {
      shares: result.shares,
      probBefore: getProb(target.pool),
      probAfter: round6(result.probAfter),
      fee,
    }
  }

  buy(
    accountId: string,
    marketId: string,
    side: Side,
    amount: number,
    answerId?: string
  ) {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ServiceError(400, 'Amount must be positive.')
    }
    const run = this.db.transaction(() => {
      const row = this.requireTradable(this.getMarketRow(marketId))
      const target = this.tradeTarget(row, answerId)
      const fee = round6(amount * BUY_FEE_RATE)
      const probBefore = getProb(target.pool)
      const result = this.tryCpmm(() =>
        calcBuy(target.pool, side, round6(amount - fee))
      )

      this.debit(accountId, amount, 'buy')
      this.credit(row.creator_id, fee)
      this.saveTargetPool(row, target, result.newPool, amount)
      // Cost basis tracks only what entered the pool (amount minus fee): the
      // fee is a service charge kept by the creator, so a CANCEL refund of
      // `invested` plus the subsidy refund exactly drains the pool backing —
      // refunding the gross amount would mint the fee out of nothing.
      this.adjustPosition(
        accountId,
        row.id,
        target.answer?.id ?? '',
        side,
        result.shares,
        round6(amount - fee)
      )

      const trade = insertTrade(this.db, {
        marketId: row.id,
        accountId,
        kind: 'BUY',
        side,
        answerId: target.answer?.id ?? null,
        amount,
        shares: result.shares,
        fee,
        probBefore,
        probAfter: result.probAfter,
      })
      // The price moved: fill any resting limit orders it crossed.
      this.orderBook.match(row.id)
      return { ...trade, balance: this.getAccount(accountId).balance }
    })
    return run()
  }

  sell(
    accountId: string,
    marketId: string,
    side: Side,
    shares: number,
    answerId?: string
  ) {
    if (!Number.isFinite(shares) || shares <= 0) {
      throw new ServiceError(400, 'Shares must be positive.')
    }
    const run = this.db.transaction(() => {
      const row = this.requireTradable(this.getMarketRow(marketId))
      const target = this.tradeTarget(row, answerId)
      const position = this.getPositionRow(
        accountId,
        marketId,
        target.answer?.id ?? ''
      )
      const held = side === 'YES' ? position.yes_shares : position.no_shares
      if (held + 1e-9 < shares) {
        throw new ServiceError(
          400,
          `You hold ${round6(held)} ${side} shares, cannot sell ${shares}.`
        )
      }
      const probBefore = getProb(target.pool)
      const result = this.tryCpmm(() => calcSell(target.pool, side, shares))

      this.credit(accountId, result.amount)
      this.saveTargetPool(row, target, result.newPool, result.amount)
      this.adjustPosition(
        accountId,
        row.id,
        target.answer?.id ?? '',
        side,
        -shares,
        -result.amount
      )

      const trade = insertTrade(this.db, {
        marketId: row.id,
        accountId,
        kind: 'SELL',
        side,
        answerId: target.answer?.id ?? null,
        amount: result.amount,
        shares,
        fee: 0,
        probBefore,
        probAfter: result.probAfter,
      })
      // The price moved: fill any resting limit orders it crossed.
      this.orderBook.match(row.id)
      return { ...trade, balance: this.getAccount(accountId).balance }
    })
    return run()
  }

  // ---- limit orders -------------------------------------------------------

  /**
   * Places a limit order. The full amount is reserved (debited) immediately;
   * a marketable order starts filling in the same transaction.
   */
  placeOrder(
    accountId: string,
    marketId: string,
    input: { side: Side; limitProb: number; amount: number; answerId?: string }
  ): { order: LimitOrder; balance: number } {
    const run = this.db.transaction(() => {
      const row = this.requireTradable(this.getMarketRow(marketId))
      const order = this.orderBook.place(accountId, row, {
        side: input.side,
        limitProb: input.limitProb,
        amount: input.amount,
        answerId: input.answerId ?? null,
      } satisfies PlaceOrderInput)
      return { order, balance: this.getAccount(accountId).balance }
    })
    return run()
  }

  /** Cancels the caller's OPEN order and refunds the unfilled reservation. */
  cancelOrder(
    accountId: string,
    orderId: string
  ): { order: LimitOrder; balance: number } {
    const run = this.db.transaction(() => {
      const order = this.orderBook.cancel(accountId, orderId)
      return { order, balance: this.getAccount(accountId).balance }
    })
    return run()
  }

  /** The caller's own orders, optionally filtered by status. */
  listOrders(accountId: string, status?: OrderStatus): LimitOrder[] {
    return this.orderBook.listForAccount(accountId, status)
  }

  /** Public order book: anonymized open price levels (404 if no market). */
  getOrderBook(marketId: string): OrderLevel[] {
    this.getMarketRow(marketId)
    return this.orderBook.levels(marketId)
  }

  // ---- lifecycle ----------------------------------------------------------

  closeMarket(accountId: string, marketId: string): Market {
    const run = this.db.transaction(() => {
      const row = this.getMarketRow(marketId)
      this.requireCreator(row, accountId)
      if (row.status !== 'OPEN') {
        throw new ServiceError(409, 'Market is not open.')
      }
      this.db
        .prepare("UPDATE markets SET status = 'CLOSED' WHERE id = ?")
        .run(marketId)
      return this.getMarket(marketId)
    })
    return run()
  }

  /**
   * Resolve a market. BINARY: outcome is YES | NO | CANCEL. MULTI: outcome is
   * the winning answer id or CANCEL. CANCEL refunds every trader's net cost
   * basis per (account, market); otherwise winning shares pay 1 each and the
   * leftover pool value returns to the creator.
   */
  resolveMarket(accountId: string, marketId: string, outcome: string): Market {
    const run = this.db.transaction(() => {
      const row = this.getMarketRow(marketId)
      this.requireCreator(row, accountId)
      if (row.status === 'RESOLVED') {
        throw new ServiceError(409, 'Market is already resolved.')
      }
      const isMulti = row.outcome_type === 'MULTI'
      const winner = this.requireValidOutcome(row, outcome)

      // Resolution retires the book: every OPEN limit order is cancelled and
      // its unfilled reservation refunded before payouts are computed.
      this.orderBook.cancelAllOpen(marketId)

      const positions = this.db
        .prepare('SELECT * FROM positions WHERE market_id = ?')
        .all(marketId) as PositionRow[]

      if (outcome === 'CANCEL') {
        this.refundInvested(positions)
      } else {
        for (const pos of positions) {
          const winningShares = isMulti
            ? pos.answer_id === winner
              ? pos.yes_shares
              : pos.no_shares
            : outcome === 'YES'
            ? pos.yes_shares
            : pos.no_shares
          const payout = round6(winningShares)
          if (payout > 0) this.credit(pos.account_id, payout)
        }
      }

      // Leftover pool value returns to the creator: the pool's winning-side
      // shares each pay 1; on CANCEL the original subsidy is refunded.
      const creatorRefund =
        outcome === 'CANCEL'
          ? row.subsidy
          : isMulti
          ? creatorRefundForWinner(listAnswerRows(this.db, row.id), winner!)
          : outcome === 'YES'
          ? row.pool_yes
          : row.pool_no
      if (creatorRefund > 0) this.credit(row.creator_id, round6(creatorRefund))

      this.db
        .prepare(
          "UPDATE markets SET status = 'RESOLVED', outcome = ?, resolved_at = ? WHERE id = ?"
        )
        .run(outcome, Date.now(), marketId)
      return this.getMarket(marketId)
    })
    return run()
  }

  // ---- internals ----------------------------------------------------------

  private getMarketRow(id: string): MarketRow {
    const row = this.db.prepare('SELECT * FROM markets WHERE id = ?').get(id) as
      | MarketRow
      | undefined
    if (!row) throw new ServiceError(404, 'Market not found.')
    return row
  }

  private hydrateMarket(row: MarketRow): Market {
    const answers =
      row.outcome_type === 'MULTI' ? listAnswerRows(this.db, row.id) : null
    return toMarket(row, answers)
  }

  // Validates the outcome for this market's type. Returns the winning answer
  // id for a non-CANCEL MULTI resolution, null otherwise.
  private requireValidOutcome(row: MarketRow, outcome: string): string | null {
    if (outcome === 'CANCEL') return null
    if (row.outcome_type === 'MULTI') {
      const answer = getAnswerRow(this.db, row.id, outcome)
      if (!answer) {
        throw new ServiceError(
          400,
          'MULTI outcome must be the winning answerId or CANCEL.'
        )
      }
      return answer.id
    }
    if (outcome !== 'YES' && outcome !== 'NO') {
      throw new ServiceError(400, 'Outcome must be YES, NO, or CANCEL.')
    }
    return null
  }

  // CANCEL refund: net cost basis per (account, market), aggregated across a
  // MULTI market's answer positions (a binary market has one row per account).
  private refundInvested(positions: readonly PositionRow[]): void {
    const investedByAccount = new Map<string, number>()
    for (const pos of positions) {
      investedByAccount.set(
        pos.account_id,
        (investedByAccount.get(pos.account_id) ?? 0) + pos.invested
      )
    }
    for (const [account, invested] of investedByAccount) {
      const refund = Math.max(0, round6(invested))
      if (refund > 0) this.credit(account, refund)
    }
  }

  private tradeTarget(row: MarketRow, answerId: string | undefined): TradeTarget {
    if (row.outcome_type === 'MULTI') {
      if (!answerId) {
        throw new ServiceError(400, 'answerId is required for MULTI markets.')
      }
      const answer = getAnswerRow(this.db, row.id, answerId)
      if (!answer) {
        throw new ServiceError(400, 'Unknown answerId for this market.')
      }
      return { pool: rowToPool(answer), answer }
    }
    if (answerId !== undefined) {
      throw new ServiceError(400, 'answerId is only valid for MULTI markets.')
    }
    return { pool: rowPool(row), answer: null }
  }

  // Persists a trade's pool movement: the answer pool for MULTI (market row
  // keeps aggregate volume), the market pool for BINARY.
  private saveTargetPool(
    row: MarketRow,
    target: TradeTarget,
    pool: Pool,
    tradeAmount: number
  ): void {
    if (target.answer) {
      saveAnswerPool(
        this.db,
        target.answer.id,
        pool,
        target.answer.volume + tradeAmount
      )
      this.db
        .prepare('UPDATE markets SET volume = ROUND(?, 6) WHERE id = ?')
        .run(row.volume + tradeAmount, row.id)
      return
    }
    this.savePool(row.id, pool, row.volume + tradeAmount)
  }

  private requireTradable(row: MarketRow): MarketRow {
    if (row.status !== 'OPEN') {
      throw new ServiceError(409, 'Market is not open for trading.')
    }
    if (Date.now() >= row.close_time) {
      throw new ServiceError(409, 'Market is past its close time.')
    }
    return row
  }

  private requireCreator(row: MarketRow, accountId: string): void {
    if (row.creator_id !== accountId) {
      throw new ServiceError(403, 'Only the market creator can do this.')
    }
  }

  private tryCpmm<T>(fn: () => T): T {
    try {
      return fn()
    } catch (err) {
      if (err instanceof CpmmError) throw new ServiceError(400, err.message)
      throw err
    }
  }

  private debit(accountId: string, amount: number, what: string): void {
    const account = this.getAccount(accountId)
    if (account.balance + 1e-9 < amount) {
      throw new ServiceError(
        402,
        `Insufficient balance for ${what}: need ${round6(amount)}, have ${round6(
          account.balance
        )}.`
      )
    }
    this.db
      .prepare('UPDATE accounts SET balance = ROUND(balance - ?, 6) WHERE id = ?')
      .run(amount, accountId)
  }

  private credit(accountId: string, amount: number): void {
    this.db
      .prepare('UPDATE accounts SET balance = ROUND(balance + ?, 6) WHERE id = ?')
      .run(amount, accountId)
  }

  private savePool(marketId: string, pool: Pool, volume: number): void {
    this.db
      .prepare(
        'UPDATE markets SET pool_yes = ?, pool_no = ?, volume = ROUND(?, 6) WHERE id = ?'
      )
      .run(pool.yes, pool.no, volume, marketId)
  }

  private getPositionRow(
    accountId: string,
    marketId: string,
    answerKey: string
  ): PositionRow {
    const row = this.db
      .prepare(
        'SELECT * FROM positions WHERE account_id = ? AND market_id = ? AND answer_id = ?'
      )
      .get(accountId, marketId, answerKey) as PositionRow | undefined
    return (
      row ?? {
        account_id: accountId,
        market_id: marketId,
        answer_id: answerKey,
        yes_shares: 0,
        no_shares: 0,
        invested: 0,
      }
    )
  }

  private adjustPosition(
    accountId: string,
    marketId: string,
    answerKey: string,
    side: Side,
    sharesDelta: number,
    investedDelta: number
  ): void {
    const pos = this.getPositionRow(accountId, marketId, answerKey)
    const yes = round6(pos.yes_shares + (side === 'YES' ? sharesDelta : 0))
    const no = round6(pos.no_shares + (side === 'NO' ? sharesDelta : 0))
    const invested = round6(pos.invested + investedDelta)
    this.db
      .prepare(
        `INSERT INTO positions (account_id, market_id, answer_id, yes_shares, no_shares, invested)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, market_id, answer_id)
         DO UPDATE SET yes_shares = excluded.yes_shares,
                       no_shares = excluded.no_shares,
                       invested = excluded.invested`
      )
      .run(accountId, marketId, answerKey, Math.max(0, yes), Math.max(0, no), invested)
  }

}

