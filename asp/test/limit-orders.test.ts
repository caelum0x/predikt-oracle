// Limit orders resting against the AMM: reservation accounting, immediate and
// deferred fills, price-priority + FIFO matching, partial fills and the
// per-pass slice bound, resolution auto-cancel, conservation of money
// (including reserved funds), HTTP endpoints, and MCP tools.

import { beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createApp } from '../src/app'
import { openDb, type Db } from '../src/engine/store'
import {
  MarketService,
  ServiceError,
  SIGNUP_GRANT,
  type Account,
} from '../src/engine/service'
import { createMcpServer } from '../src/mcp/server'

const FUTURE = () => Date.now() + 7 * 24 * 60 * 60 * 1000

let db: Db
let svc: MarketService
let alice: Account // market creator
let bob: Account
let carol: Account
let dave: Account

function makeMarket(overrides: Record<string, unknown> = {}) {
  return svc.createMarket(alice.id, {
    question: 'Will BTC close above $150k on Dec 31, 2026?',
    criteria: 'Resolves YES on a CoinGecko daily close above $150,000.',
    closeTime: FUTURE(),
    subsidy: 300,
    ...overrides,
  })
}

// Fill trades for the given accounts on a market, in execution (rowid) order.
function fillTradesOf(marketId: string, accountIds: string[]) {
  const placeholders = accountIds.map(() => '?').join(', ')
  return db
    .prepare(
      `SELECT rowid AS rid, account_id, amount, fee FROM trades
       WHERE market_id = ? AND kind = 'BUY' AND account_id IN (${placeholders})
       ORDER BY rowid ASC`
    )
    .all(marketId, ...accountIds) as {
    rid: number
    account_id: string
    amount: number
    fee: number
  }[]
}

beforeEach(() => {
  db = openDb(':memory:')
  svc = new MarketService(db)
  alice = svc.createAccount('alice-agent').account
  bob = svc.createAccount('bob-agent').account
  carol = svc.createAccount('carol-agent').account
  dave = svc.createAccount('dave-agent').account
})

describe('placement reserves funds', () => {
  it('debits the full amount up front and rests a non-marketable order', () => {
    const market = makeMarket() // prob 0.5
    const { order, balance } = svc.placeOrder(bob.id, market.id, {
      side: 'YES',
      limitProb: 0.4, // fills only below 0.4 -> rests at 0.5
      amount: 100,
    })
    expect(order.status).toBe('OPEN')
    expect(order.amountTotal).toBe(100)
    expect(order.amountRemaining).toBe(100)
    expect(order.limitProb).toBe(0.4)
    expect(balance).toBe(SIGNUP_GRANT - 100)
    expect(svc.getAccount(bob.id).balance).toBe(SIGNUP_GRANT - 100)
    // No trades happened and the pool did not move.
    expect(svc.getMarket(market.id).probability).toBeCloseTo(0.5, 6)
    expect(fillTradesOf(market.id, [bob.id])).toHaveLength(0)
  })

  it('cancellation refunds exactly the unfilled reservation', () => {
    const market = makeMarket()
    const { order } = svc.placeOrder(bob.id, market.id, {
      side: 'YES',
      limitProb: 0.4,
      amount: 100,
    })
    const { order: cancelled, balance } = svc.cancelOrder(bob.id, order.id)
    expect(cancelled.status).toBe('CANCELLED')
    expect(balance).toBe(SIGNUP_GRANT)
    // Cancelling twice is a conflict; funds are never refunded twice.
    expect(() => svc.cancelOrder(bob.id, order.id)).toThrowError(/already CANCELLED/)
    expect(svc.getAccount(bob.id).balance).toBe(SIGNUP_GRANT)
  })

  it('rejects an order the balance cannot cover', () => {
    const market = makeMarket()
    expect(() =>
      svc.placeOrder(bob.id, market.id, { side: 'YES', limitProb: 0.4, amount: 5000 })
    ).toThrowError(/Insufficient/)
    expect(svc.getAccount(bob.id).balance).toBe(SIGNUP_GRANT)
  })

  it('validates limitProb, amount, market state, and ownership', () => {
    const market = makeMarket()
    expect(() =>
      svc.placeOrder(bob.id, market.id, { side: 'YES', limitProb: 0.995, amount: 10 })
    ).toThrowError(/limitProb/)
    expect(() =>
      svc.placeOrder(bob.id, market.id, { side: 'YES', limitProb: 0.005, amount: 10 })
    ).toThrowError(/limitProb/)
    expect(() =>
      svc.placeOrder(bob.id, market.id, { side: 'YES', limitProb: 0.4, amount: 0.5 })
    ).toThrowError(/amount/)
    expect(() =>
      svc.placeOrder(bob.id, market.id, { side: 'YES', limitProb: 0.4, amount: -5 })
    ).toThrowError(/amount/)
    expect(() =>
      svc.placeOrder(bob.id, 'mkt_missing', { side: 'YES', limitProb: 0.4, amount: 10 })
    ).toThrowError(/not found/)
    // answerId is invalid on BINARY markets.
    expect(() =>
      svc.placeOrder(bob.id, market.id, {
        side: 'YES',
        limitProb: 0.4,
        amount: 10,
        answerId: 'ans_x',
      })
    ).toThrowError(/only valid for MULTI/)

    svc.closeMarket(alice.id, market.id)
    expect(() =>
      svc.placeOrder(bob.id, market.id, { side: 'YES', limitProb: 0.4, amount: 10 })
    ).toThrowError(/not open/)

    // Cancel: unknown order and foreign order.
    expect(() => svc.cancelOrder(bob.id, 'ord_missing')).toThrowError(/not found/)
  })

  it('only the owner can cancel', () => {
    const market = makeMarket()
    const { order } = svc.placeOrder(bob.id, market.id, {
      side: 'YES',
      limitProb: 0.4,
      amount: 50,
    })
    expect(() => svc.cancelOrder(carol.id, order.id)).toThrowError(/owner/)
    expect(svc.listOrders(bob.id, 'OPEN')).toHaveLength(1)
  })
})

describe('immediate fills', () => {
  it('a marketable YES order fills in the placement transaction', () => {
    const market = makeMarket({ subsidy: 100 })
    const before = svc.getAccount(alice.id).balance
    const { order, balance } = svc.placeOrder(bob.id, market.id, {
      side: 'YES',
      limitProb: 0.9, // prob 0.5 < 0.9 -> marketable now
      amount: 20,
    })
    expect(order.status).toBe('FILLED')
    expect(order.amountRemaining).toBe(0)
    expect(balance).toBe(SIGNUP_GRANT - 20) // spent from the reservation only

    // Fills are real trades: position, history, fee to the creator.
    const pos = svc.getPositions(bob.id).find((p) => p.marketId === market.id)
    expect(pos?.yesShares ?? 0).toBeGreaterThan(20) // < 1 credit per share
    // Cost basis is pool-net: 20 minus the 1% fee paid to the creator.
    expect(pos?.invested).toBeCloseTo(19.8, 6)
    const fills = fillTradesOf(market.id, [bob.id])
    expect(fills.length).toBeGreaterThan(0)
    const spent = fills.reduce((sum, t) => sum + t.amount, 0)
    const fees = fills.reduce((sum, t) => sum + t.fee, 0)
    expect(spent).toBeCloseTo(20, 6)
    expect(fees).toBeCloseTo(0.2, 4) // 1% buy fee on every slice
    expect(svc.getAccount(alice.id).balance).toBeCloseTo(before + fees, 6)
    expect(svc.getMarket(market.id).probability).toBeGreaterThan(0.5)
  })

  it('a marketable NO order fills toward its limit from above', () => {
    const market = makeMarket() // prob 0.5
    const { order } = svc.placeOrder(dave.id, market.id, {
      side: 'NO',
      limitProb: 0.35, // fills while prob > 0.35
      amount: 20,
    })
    expect(order.status).toBe('FILLED')
    const pos = svc.getPositions(dave.id).find((p) => p.marketId === market.id)
    expect(pos?.noShares ?? 0).toBeGreaterThan(0)
    const prob = svc.getMarket(market.id).probability
    expect(prob).toBeLessThan(0.5)
    expect(prob).toBeGreaterThan(0.35) // small order stops well before the limit
  })

  it('a partial fill stops once the price crosses the limit', () => {
    const market = makeMarket() // subsidy 300, prob 0.5
    const { order } = svc.placeOrder(bob.id, market.id, {
      side: 'YES',
      limitProb: 0.55,
      amount: 200,
    })
    expect(order.status).toBe('OPEN')
    expect(order.amountRemaining).toBeGreaterThan(0)
    expect(order.amountRemaining).toBeLessThan(200)
    expect(svc.getMarket(market.id).probability).toBeGreaterThanOrEqual(0.55)
  })
})

describe('resting orders fill when trades move the price', () => {
  it('a resting YES order fills after a NO buy drops the probability through it', () => {
    const market = makeMarket() // prob 0.5
    const { order } = svc.placeOrder(bob.id, market.id, {
      side: 'YES',
      limitProb: 0.4,
      amount: 50,
    })
    expect(order.status).toBe('OPEN')

    svc.buy(carol.id, market.id, 'NO', 150) // drops prob below 0.4
    const after = svc.listOrders(bob.id)[0]!
    expect(after.amountRemaining).toBeLessThan(50)
    const pos = svc.getPositions(bob.id).find((p) => p.marketId === market.id)
    expect(pos?.yesShares ?? 0).toBeGreaterThan(0)
    expect(fillTradesOf(market.id, [bob.id]).length).toBeGreaterThan(0)
  })

  it('a resting NO order fills after a YES buy lifts the probability through it', () => {
    const market = makeMarket() // prob 0.5
    const { order } = svc.placeOrder(bob.id, market.id, {
      side: 'NO',
      limitProb: 0.6, // fills only above 0.6
      amount: 50,
    })
    expect(order.status).toBe('OPEN')

    svc.buy(carol.id, market.id, 'YES', 150) // lifts prob above 0.6
    const after = svc.listOrders(bob.id)[0]!
    expect(after.amountRemaining).toBeLessThan(50)
    const pos = svc.getPositions(bob.id).find((p) => p.marketId === market.id)
    expect(pos?.noShares ?? 0).toBeGreaterThan(0)
  })

  it('a partially filled order resumes when the price comes back', () => {
    const market = makeMarket() // subsidy 300
    const { order } = svc.placeOrder(bob.id, market.id, {
      side: 'YES',
      limitProb: 0.55,
      amount: 200,
    })
    const restingBefore = order.amountRemaining
    expect(order.status).toBe('OPEN')

    svc.buy(carol.id, market.id, 'NO', 150) // back below 0.55 -> more fills
    const after = svc.listOrders(bob.id)[0]!
    expect(after.amountRemaining).toBeLessThan(restingBefore)
  })
})

describe('matching priority', () => {
  it('fills the best-priced order first (YES: highest limit wins)', () => {
    const market = makeMarket({ subsidy: 500 })
    const bobOrder = svc.placeOrder(bob.id, market.id, {
      side: 'YES',
      limitProb: 0.3,
      amount: 30,
    }).order
    const carolOrder = svc.placeOrder(carol.id, market.id, {
      side: 'YES',
      limitProb: 0.35,
      amount: 100,
    }).order
    expect(bobOrder.status).toBe('OPEN')
    expect(carolOrder.status).toBe('OPEN')

    svc.buy(dave.id, market.id, 'NO', 300) // prob ~0.28: both marketable

    // Carol's higher limit fills first and lifts the price back above 0.30,
    // so Bob's worse-priced order never trades.
    const carolAfter = svc.listOrders(carol.id)[0]!
    const bobAfter = svc.listOrders(bob.id)[0]!
    expect(carolAfter.amountRemaining).toBeLessThan(100)
    expect(bobAfter.amountRemaining).toBe(30)
    const fills = fillTradesOf(market.id, [bob.id, carol.id])
    expect(fills.length).toBeGreaterThan(0)
    expect(fills.every((t) => t.account_id === carol.id)).toBe(true)
    expect(svc.getMarket(market.id).probability).toBeGreaterThanOrEqual(0.3)
  })

  it('breaks price ties FIFO: the earlier order fills completely first', () => {
    const market = makeMarket({ subsidy: 500 })
    svc.placeOrder(bob.id, market.id, { side: 'YES', limitProb: 0.45, amount: 8 })
    svc.placeOrder(carol.id, market.id, { side: 'YES', limitProb: 0.45, amount: 8 })

    svc.buy(dave.id, market.id, 'NO', 200) // prob ~0.34: both marketable

    expect(svc.listOrders(bob.id)[0]!.status).toBe('FILLED')
    expect(svc.listOrders(carol.id)[0]!.status).toBe('FILLED')
    const fills = fillTradesOf(market.id, [bob.id, carol.id])
    const lastBob = Math.max(
      ...fills.filter((t) => t.account_id === bob.id).map((t) => t.rid)
    )
    const firstCarol = Math.min(
      ...fills.filter((t) => t.account_id === carol.id).map((t) => t.rid)
    )
    expect(lastBob).toBeLessThan(firstCarol)
  })

  it('bounds a matching pass at 20 slices and resumes on the next trade', () => {
    const market = makeMarket({ subsidy: 900 })
    const { order } = svc.placeOrder(bob.id, market.id, {
      side: 'YES',
      limitProb: 0.9,
      amount: 600, // needs > 20 slices of min(remaining, max(1, remaining/4))
    })
    expect(order.status).toBe('OPEN')
    expect(order.amountRemaining).toBeGreaterThan(0)
    expect(fillTradesOf(market.id, [bob.id])).toHaveLength(20)

    // Any later trade on the market triggers another pass that finishes it.
    svc.buy(carol.id, market.id, 'YES', 5)
    expect(svc.listOrders(bob.id)[0]!.status).toBe('FILLED')
    expect(svc.listOrders(bob.id)[0]!.amountRemaining).toBe(0)
  })
})

describe('MULTI market orders', () => {
  function makeMulti() {
    return svc.createMarket(alice.id, {
      question: 'Which model tops LMArena at end of 2026?',
      criteria: 'Resolves to the #1 overall model on the LMArena leaderboard.',
      closeTime: FUTURE(),
      subsidy: 90,
      outcomeType: 'MULTI',
      answers: ['GPT', 'Claude', 'Gemini'],
    })
  }

  it('fills against the targeted answer pool only', () => {
    const market = makeMulti()
    const target = market.answers![0]!
    const { order } = svc.placeOrder(bob.id, market.id, {
      side: 'YES',
      limitProb: 0.9,
      amount: 5,
      answerId: target.id,
    })
    expect(order.answerId).toBe(target.id)
    expect(order.status).toBe('FILLED')

    const after = svc.getMarket(market.id)
    const targetAfter = after.answers!.find((a) => a.id === target.id)!
    const others = after.answers!.filter((a) => a.id !== target.id)
    expect(targetAfter.probability).toBeGreaterThan(1 / 3)
    for (const other of others) {
      expect(other.probability).toBeCloseTo(1 / 3, 6) // untouched pools
    }
    const pos = svc
      .getPositions(bob.id)
      .find((p) => p.marketId === market.id && p.answerId === target.id)
    expect(pos?.yesShares ?? 0).toBeGreaterThan(0)
  })

  it('requires a valid answerId', () => {
    const market = makeMulti()
    expect(() =>
      svc.placeOrder(bob.id, market.id, { side: 'YES', limitProb: 0.5, amount: 5 })
    ).toThrowError(/answerId is required/)
    expect(() =>
      svc.placeOrder(bob.id, market.id, {
        side: 'YES',
        limitProb: 0.5,
        amount: 5,
        answerId: 'ans_bogus',
      })
    ).toThrowError(/Unknown answerId/)
  })

  it('resolution cancels and refunds resting MULTI orders', () => {
    const market = makeMulti()
    const target = market.answers![0]!
    svc.placeOrder(bob.id, market.id, {
      side: 'YES',
      limitProb: 0.1, // rests: answer prob is 1/3
      amount: 40,
      answerId: target.id,
    })
    expect(svc.getAccount(bob.id).balance).toBe(SIGNUP_GRANT - 40)
    svc.resolveMarket(alice.id, market.id, target.id)
    expect(svc.getAccount(bob.id).balance).toBe(SIGNUP_GRANT) // full refund
    expect(svc.listOrders(bob.id)[0]!.status).toBe('CANCELLED')
  })
})

describe('resolution and conservation of money', () => {
  it('resolution cancels open orders and refunds the remaining reservation', () => {
    const market = makeMarket({ subsidy: 100 })
    svc.buy(bob.id, market.id, 'YES', 50) // prob above 0.5
    const { order } = svc.placeOrder(carol.id, market.id, {
      side: 'YES',
      limitProb: 0.3, // rests
      amount: 40,
    })
    expect(order.status).toBe('OPEN')
    expect(svc.getAccount(carol.id).balance).toBe(SIGNUP_GRANT - 40)

    svc.resolveMarket(alice.id, market.id, 'CANCEL')
    // Carol never filled: her reservation comes back in full. Bob's pool-net
    // cost basis (49.5) is refunded by CANCEL; the 0.5 fee stays with the
    // creator, so no money is minted.
    expect(svc.getAccount(carol.id).balance).toBe(SIGNUP_GRANT)
    expect(svc.getAccount(bob.id).balance).toBeCloseTo(SIGNUP_GRANT - 0.5, 4)
    expect(svc.listOrders(carol.id)[0]!.status).toBe('CANCELLED')
    // Regression: CANCEL with prior trading used to mint the collected fees.
    const total =
      svc.getAccount(alice.id).balance +
      svc.getAccount(bob.id).balance +
      svc.getAccount(carol.id).balance +
      svc.getAccount(dave.id).balance
    expect(total).toBeCloseTo(4 * SIGNUP_GRANT, 4)
  })

  it('conserves total money across a lifecycle with direct trades, fills, and reserved funds', () => {
    const market = makeMarket({ subsidy: 100 })

    // Direct buy lifts the price.
    svc.buy(bob.id, market.id, 'YES', 80)
    // Carol rests a YES bid below the market.
    const carolOrder = svc.placeOrder(carol.id, market.id, {
      side: 'YES',
      limitProb: 0.45,
      amount: 120,
    }).order
    expect(carolOrder.status).toBe('OPEN')
    expect(svc.getAccount(carol.id).balance).toBe(SIGNUP_GRANT - 120)
    // Dave's NO order is marketable immediately (prob > 0.5) and fills.
    svc.placeOrder(dave.id, market.id, { side: 'NO', limitProb: 0.5, amount: 60 })
    // Bob sells half his shares; the dip can trigger more resting fills.
    const bobPos = svc.getPositions(bob.id).find((p) => p.marketId === market.id)!
    svc.sell(bob.id, market.id, 'YES', bobPos.yesShares / 2)

    // Mid-flight: whatever filled, Carol's balance only ever saw the
    // reservation debit — fills spend from the reservation, never twice.
    expect(svc.getAccount(carol.id).balance).toBe(SIGNUP_GRANT - 120)

    svc.resolveMarket(alice.id, market.id, 'YES')

    // Every OPEN order is auto-cancelled at resolution.
    for (const account of [bob, carol, dave]) {
      for (const order of svc.listOrders(account.id)) {
        expect(order.status).not.toBe('OPEN')
      }
    }
    // No money minted or destroyed: payouts + creator refund + order refunds
    // return the system to the four signup grants.
    const total =
      svc.getAccount(alice.id).balance +
      svc.getAccount(bob.id).balance +
      svc.getAccount(carol.id).balance +
      svc.getAccount(dave.id).balance
    expect(total).toBeCloseTo(4 * SIGNUP_GRANT, 2)
  })

  it('conserves money when orders fully fill and the other side wins', () => {
    const market = makeMarket({ subsidy: 100 })
    svc.placeOrder(bob.id, market.id, { side: 'YES', limitProb: 0.9, amount: 50 })
    svc.buy(carol.id, market.id, 'NO', 30)
    svc.resolveMarket(alice.id, market.id, 'NO')
    const total =
      svc.getAccount(alice.id).balance +
      svc.getAccount(bob.id).balance +
      svc.getAccount(carol.id).balance
    expect(total).toBeCloseTo(3 * SIGNUP_GRANT, 2)
  })
})

describe('order listings', () => {
  it('filters by status and returns newest first', () => {
    const market = makeMarket()
    const resting = svc.placeOrder(bob.id, market.id, {
      side: 'YES',
      limitProb: 0.4,
      amount: 10,
    }).order
    svc.placeOrder(bob.id, market.id, { side: 'YES', limitProb: 0.9, amount: 10 })

    expect(svc.listOrders(bob.id)).toHaveLength(2)
    const open = svc.listOrders(bob.id, 'OPEN')
    expect(open).toHaveLength(1)
    expect(open[0]!.id).toBe(resting.id)
    expect(svc.listOrders(bob.id, 'FILLED')).toHaveLength(1)
    expect(svc.listOrders(carol.id)).toHaveLength(0)
  })

  it('aggregates the public book into anonymous price levels', () => {
    const market = makeMarket()
    svc.placeOrder(bob.id, market.id, { side: 'YES', limitProb: 0.4, amount: 10 })
    svc.placeOrder(carol.id, market.id, { side: 'YES', limitProb: 0.4, amount: 15 })
    svc.placeOrder(dave.id, market.id, { side: 'NO', limitProb: 0.7, amount: 5 })

    const levels = svc.getOrderBook(market.id)
    expect(levels).toHaveLength(2) // same-price orders merge into one level
    const yesLevel = levels.find((l) => l.side === 'YES')!
    expect(yesLevel.limitProb).toBe(0.4)
    expect(yesLevel.amount).toBe(25)
    expect(Object.keys(yesLevel).sort()).toEqual([
      'amount',
      'answerId',
      'limitProb',
      'side',
    ]) // no account ids in the public book
    expect(() => svc.getOrderBook('mkt_missing')).toThrowError(ServiceError)
  })
})

// ---- HTTP endpoints ---------------------------------------------------------

describe('HTTP limit-order endpoints', () => {
  type App = ReturnType<typeof createApp>
  let app: App

  function req(
    path: string,
    options: { method?: string; body?: unknown; key?: string } = {}
  ) {
    return app.request(path, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: {
        'Content-Type': 'application/json',
        ...(options.key ? { Authorization: `Bearer ${options.key}` } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
  }

  async function json(res: Response) {
    return (await res.json()) as { success: boolean; data?: any; error?: string }
  }

  async function signup(name: string): Promise<{ id: string; key: string }> {
    const body = await json(await req('/accounts', { body: { name } }))
    return { id: body.data.account.id, key: body.data.apiKey }
  }

  async function createMarket(key: string) {
    const res = await req('/markets', {
      key,
      body: {
        question: 'Will ETH close above $10k on Dec 31, 2026?',
        criteria: 'Resolves YES on a CoinGecko daily close above $10,000.',
        closeTime: FUTURE(),
        subsidy: 100,
      },
    })
    return (await json(res)).data.market
  }

  let creator: { id: string; key: string }
  let trader: { id: string; key: string }
  let marketId: string

  beforeEach(async () => {
    app = createApp({ db: openDb(':memory:'), complete: async () => '{}' })
    creator = await signup('creator-agent')
    trader = await signup('trader-agent')
    marketId = (await createMarket(creator.key)).id
  })

  it('POST /markets/:id/orders places an order and reports the new balance', async () => {
    const res = await req(`/markets/${marketId}/orders`, {
      key: trader.key,
      body: { side: 'YES', limitProb: 0.4, amount: 50 },
    })
    expect(res.status).toBe(201)
    const body = await json(res)
    expect(body.success).toBe(true)
    expect(body.data.order.status).toBe('OPEN')
    expect(body.data.order.amountRemaining).toBe(50)
    expect(body.data.balance).toBe(SIGNUP_GRANT - 50)
  })

  it('requires auth and validates the body with zod', async () => {
    const noAuth = await req(`/markets/${marketId}/orders`, {
      body: { side: 'YES', limitProb: 0.4, amount: 50 },
    })
    expect(noAuth.status).toBe(401)

    for (const bad of [
      { side: 'MAYBE', limitProb: 0.4, amount: 50 },
      { side: 'YES', limitProb: 1.5, amount: 50 },
      { side: 'YES', limitProb: 0.4, amount: 0.2 },
      { side: 'YES', limitProb: 0.4 },
      { limitProb: 0.4, amount: 50 },
    ]) {
      const res = await req(`/markets/${marketId}/orders`, {
        key: trader.key,
        body: bad,
      })
      expect(res.status).toBe(400)
      expect((await json(res)).success).toBe(false)
    }
  })

  it('GET /markets/:id/orders is public and anonymized', async () => {
    await req(`/markets/${marketId}/orders`, {
      key: trader.key,
      body: { side: 'YES', limitProb: 0.4, amount: 50 },
    })
    const res = await req(`/markets/${marketId}/orders`)
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.data.orders).toHaveLength(1)
    expect(body.data.orders[0]).toEqual({
      side: 'YES',
      answerId: null,
      limitProb: 0.4,
      amount: 50,
    })
    const missing = await req('/markets/mkt_missing/orders')
    expect(missing.status).toBe(404)
  })

  it('GET /accounts/me/orders lists own orders with a status filter', async () => {
    await req(`/markets/${marketId}/orders`, {
      key: trader.key,
      body: { side: 'YES', limitProb: 0.4, amount: 50 },
    })
    await req(`/markets/${marketId}/orders`, {
      key: trader.key,
      body: { side: 'YES', limitProb: 0.9, amount: 10 }, // fills immediately
    })

    const all = await json(await req('/accounts/me/orders', { key: trader.key }))
    expect(all.data.orders).toHaveLength(2)
    const open = await json(
      await req('/accounts/me/orders?status=OPEN', { key: trader.key })
    )
    expect(open.data.orders).toHaveLength(1)
    expect(open.data.orders[0].limitProb).toBe(0.4)

    const bad = await req('/accounts/me/orders?status=BOGUS', { key: trader.key })
    expect(bad.status).toBe(400)
    const noAuth = await req('/accounts/me/orders')
    expect(noAuth.status).toBe(401)
  })

  it('DELETE /orders/:id cancels for the owner only and refunds', async () => {
    const placed = await json(
      await req(`/markets/${marketId}/orders`, {
        key: trader.key,
        body: { side: 'YES', limitProb: 0.4, amount: 50 },
      })
    )
    const orderId = placed.data.order.id

    const foreign = await req(`/orders/${orderId}`, {
      method: 'DELETE',
      key: creator.key,
    })
    expect(foreign.status).toBe(403)

    const cancelled = await json(
      await req(`/orders/${orderId}`, { method: 'DELETE', key: trader.key })
    )
    expect(cancelled.data.order.status).toBe('CANCELLED')
    expect(cancelled.data.balance).toBe(SIGNUP_GRANT)

    const missing = await req('/orders/ord_missing', {
      method: 'DELETE',
      key: trader.key,
    })
    expect(missing.status).toBe(404)
  })

  it('fills show up in market trade history and the global feed', async () => {
    await req(`/markets/${marketId}/orders`, {
      key: trader.key,
      body: { side: 'YES', limitProb: 0.9, amount: 20 }, // fills immediately
    })
    const trades = await json(await req(`/markets/${marketId}/trades`))
    expect(trades.data.trades.length).toBeGreaterThan(0)
    expect(
      trades.data.trades.every(
        (t: { kind: string; accountId: string }) =>
          t.kind === 'BUY' && t.accountId === trader.id
      )
    ).toBe(true)

    const feed = await json(await req('/feed'))
    const tradeEvents = feed.data.events.filter(
      (e: { type: string }) => e.type === 'trade'
    )
    expect(tradeEvents.length).toBeGreaterThan(0)
  })
})

// ---- MCP tools ----------------------------------------------------------------

describe('MCP limit-order tools', () => {
  type ToolCallResult = {
    isError?: boolean
    content: Array<{ type: string; text?: string }>
  }

  async function setup() {
    const service = new MarketService(openDb(':memory:'))
    const server = createMcpServer({
      service,
      complete: async () => '{}',
    })
    const client = new Client({ name: 'limit-order-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])
    return { client, service }
  }

  async function call(
    client: Client,
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    return (await client.callTool({ name, arguments: args })) as ToolCallResult
  }

  function dataOf<T>(result: ToolCallResult): T {
    expect(result.isError ?? false).toBe(false)
    return JSON.parse(result.content[0]?.text ?? '{}') as T
  }

  it('place -> list -> cancel round trip', async () => {
    const { client, service } = await setup()
    const created = service.createAccount('mcp-creator')
    const traderCreated = service.createAccount('mcp-trader')
    const market = service.createMarket(created.account.id, {
      question: 'Will SOL close above $500 on Dec 31, 2026?',
      criteria: 'Resolves YES on a CoinGecko daily close above $500.',
      closeTime: FUTURE(),
      subsidy: 100,
    })

    const placed = dataOf<{ order: { id: string; status: string }; balance: number }>(
      await call(client, 'predikt_place_order', {
        apiKey: traderCreated.apiKey,
        marketId: market.id,
        side: 'YES',
        limitProb: 0.4,
        amount: 25,
      })
    )
    expect(placed.order.status).toBe('OPEN')
    expect(placed.balance).toBe(SIGNUP_GRANT - 25)

    const listed = dataOf<{ orders: { id: string }[] }>(
      await call(client, 'predikt_list_my_orders', {
        apiKey: traderCreated.apiKey,
        status: 'OPEN',
      })
    )
    expect(listed.orders).toHaveLength(1)

    const cancelled = dataOf<{ order: { status: string }; balance: number }>(
      await call(client, 'predikt_cancel_order', {
        apiKey: traderCreated.apiKey,
        orderId: placed.order.id,
      })
    )
    expect(cancelled.order.status).toBe('CANCELLED')
    expect(cancelled.balance).toBe(SIGNUP_GRANT)

    // Bad key surfaces as a tool error, not a crash.
    const badKey = await call(client, 'predikt_place_order', {
      apiKey: 'pk_wrong_key',
      marketId: market.id,
      side: 'YES',
      limitProb: 0.4,
      amount: 25,
    })
    expect(badKey.isError).toBe(true)
  })
})
