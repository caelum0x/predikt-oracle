// Tests for the read-side activity API: market trade history with cursor
// pagination, per-account trades, portfolio valuation math (open, resolved
// YES, and CANCEL cases hand-verified), and the merged global feed.
// Lifecycles are driven through the real MarketService on an in-memory DB.

import { beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { openDb, type Db } from '../src/engine/store'
import { MarketService } from '../src/engine/service'
import { createActivityRoutes } from '../src/routes/activity'

let db: Db
let service: MarketService
let app: Hono

beforeEach(() => {
  db = openDb(':memory:')
  service = new MarketService(db)
  app = new Hono()
  app.route('/', createActivityRoutes(service, db))
})

function get(path: string, key?: string) {
  return app.request(path, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  })
}

async function json(res: Response) {
  return (await res.json()) as { success: boolean; data?: any; error?: string }
}

const FUTURE = () => Date.now() + 7 * 24 * 60 * 60 * 1000

function makeMarket(creatorId: string, question = 'Will BTC close above $150k on Dec 31, 2026?') {
  return service.createMarket(creatorId, {
    question,
    criteria: 'Resolves YES on a CoinGecko daily close above the threshold.',
    closeTime: FUTURE(),
    subsidy: 100,
  })
}

function setTradeTime(tradeId: string, ts: number) {
  db.prepare('UPDATE trades SET created_at = ? WHERE id = ?').run(ts, tradeId)
}

function setMarketCreatedTime(marketId: string, ts: number) {
  db.prepare('UPDATE markets SET created_at = ? WHERE id = ?').run(ts, marketId)
}

function setMarketResolvedTime(marketId: string, ts: number) {
  db.prepare('UPDATE markets SET resolved_at = ? WHERE id = ?').run(ts, marketId)
}

describe('GET /markets/:id/trades', () => {
  it('returns 404 for an unknown market', async () => {
    const res = await get('/markets/mkt_nope/trades')
    expect(res.status).toBe(404)
    const body = await json(res)
    expect(body.success).toBe(false)
    expect(body.error).toBeTruthy()
  })

  it('lists trades newest first with the documented shape', async () => {
    const alice = service.createAccount('alice-agent')
    const bob = service.createAccount('bob-agent')
    const market = makeMarket(alice.account.id)

    const t1 = service.buy(bob.account.id, market.id, 'YES', 50)
    const t2 = service.buy(bob.account.id, market.id, 'NO', 60)
    const t3 = service.sell(bob.account.id, market.id, 'YES', t1.shares)
    setTradeTime(t1.tradeId, 1000)
    setTradeTime(t2.tradeId, 2000)
    setTradeTime(t3.tradeId, 3000)

    const body = await json(await get(`/markets/${market.id}/trades`))
    expect(body.success).toBe(true)
    const trades = body.data.trades
    expect(trades).toHaveLength(3)
    expect(trades.map((t: any) => t.tradeId)).toEqual([
      t3.tradeId,
      t2.tradeId,
      t1.tradeId,
    ])

    const first = trades[2]
    expect(first).toEqual({
      tradeId: t1.tradeId,
      kind: 'BUY',
      side: 'YES',
      amount: 50,
      shares: t1.shares,
      fee: t1.fee,
      probBefore: expect.any(Number),
      probAfter: t1.probAfter,
      createdAt: 1000,
      accountId: bob.account.id,
    })
    expect(trades[0].kind).toBe('SELL')
    expect(trades[0].fee).toBe(0)
  })

  it('paginates with limit and a before cursor', async () => {
    const alice = service.createAccount('alice-agent')
    const bob = service.createAccount('bob-agent')
    const market = makeMarket(alice.account.id)

    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const t = service.buy(bob.account.id, market.id, 'YES', 10 + i)
      setTradeTime(t.tradeId, (i + 1) * 1000)
      ids.push(t.tradeId)
    }

    const page1 = await json(await get(`/markets/${market.id}/trades?limit=2`))
    expect(page1.data.trades.map((t: any) => t.tradeId)).toEqual([ids[4], ids[3]])

    const cursor = page1.data.trades[1].createdAt
    const page2 = await json(
      await get(`/markets/${market.id}/trades?limit=2&before=${cursor}`)
    )
    expect(page2.data.trades.map((t: any) => t.tradeId)).toEqual([ids[2], ids[1]])

    const page3 = await json(
      await get(
        `/markets/${market.id}/trades?limit=2&before=${page2.data.trades[1].createdAt}`
      )
    )
    expect(page3.data.trades.map((t: any) => t.tradeId)).toEqual([ids[0]])
  })

  it('rejects out-of-range or malformed query params', async () => {
    const alice = service.createAccount('alice-agent')
    const market = makeMarket(alice.account.id)
    for (const q of ['limit=0', 'limit=201', 'limit=abc', 'before=-5', 'before=xyz']) {
      const res = await get(`/markets/${market.id}/trades?${q}`)
      expect(res.status).toBe(400)
      expect((await json(res)).success).toBe(false)
    }
  })
})

describe('GET /accounts/me/trades', () => {
  it('requires a valid Bearer key', async () => {
    expect((await get('/accounts/me/trades')).status).toBe(401)
    expect((await get('/accounts/me/trades', 'pk_bogus')).status).toBe(401)
  })

  it('returns only the callers trades, joined with the market question', async () => {
    const alice = service.createAccount('alice-agent')
    const bob = service.createAccount('bob-agent')
    const market = makeMarket(alice.account.id)

    const aliceTrade = service.buy(alice.account.id, market.id, 'NO', 25)
    const bobTrade = service.buy(bob.account.id, market.id, 'YES', 40)
    setTradeTime(aliceTrade.tradeId, 1000)
    setTradeTime(bobTrade.tradeId, 2000)

    const body = await json(await get('/accounts/me/trades', bob.apiKey))
    expect(body.success).toBe(true)
    expect(body.data.trades).toHaveLength(1)
    const trade = body.data.trades[0]
    expect(trade.tradeId).toBe(bobTrade.tradeId)
    expect(trade.accountId).toBe(bob.account.id)
    expect(trade.marketId).toBe(market.id)
    expect(trade.question).toBe(market.question)
  })

  it('paginates the callers trades with a before cursor', async () => {
    const alice = service.createAccount('alice-agent')
    const bob = service.createAccount('bob-agent')
    const market = makeMarket(alice.account.id)

    const t1 = service.buy(bob.account.id, market.id, 'YES', 20)
    const t2 = service.buy(bob.account.id, market.id, 'YES', 30)
    const t3 = service.buy(bob.account.id, market.id, 'NO', 15)
    setTradeTime(t1.tradeId, 1000)
    setTradeTime(t2.tradeId, 2000)
    setTradeTime(t3.tradeId, 3000)

    const page1 = await json(await get('/accounts/me/trades?limit=2', bob.apiKey))
    expect(page1.data.trades.map((t: any) => t.tradeId)).toEqual([
      t3.tradeId,
      t2.tradeId,
    ])
    const page2 = await json(
      await get('/accounts/me/trades?limit=2&before=2000', bob.apiKey)
    )
    expect(page2.data.trades.map((t: any) => t.tradeId)).toEqual([t1.tradeId])
  })
})

describe('GET /accounts/me/portfolio', () => {
  it('requires auth', async () => {
    expect((await get('/accounts/me/portfolio')).status).toBe(401)
  })

  it('marks an open position to market: markValue = yes*p + no*(1-p)', async () => {
    const alice = service.createAccount('alice-agent')
    const bob = service.createAccount('bob-agent')
    const market = makeMarket(alice.account.id)

    service.buy(bob.account.id, market.id, 'YES', 100)
    service.buy(bob.account.id, market.id, 'NO', 50)

    const pos = service.getPositions(bob.account.id)[0]!
    const current = service.getMarket(market.id)
    const expectedMark =
      pos.yesShares * current.probability + pos.noShares * (1 - current.probability)

    const body = await json(await get('/accounts/me/portfolio', bob.apiKey))
    expect(body.success).toBe(true)
    expect(body.data.positions).toHaveLength(1)
    const entry = body.data.positions[0]
    expect(entry.marketId).toBe(market.id)
    expect(entry.question).toBe(market.question)
    expect(entry.status).toBe('OPEN')
    expect(entry.outcome).toBeNull()
    expect(entry.probability).toBeCloseTo(current.probability, 6)
    expect(entry.yesShares).toBeCloseTo(pos.yesShares, 6)
    expect(entry.noShares).toBeCloseTo(pos.noShares, 6)
    expect(entry.invested).toBeCloseTo(150, 6)
    expect(entry.markValue).toBeCloseTo(expectedMark, 5)
    expect(entry.unrealizedPnl).toBeCloseTo(expectedMark - 150, 5)

    const totals = body.data.totals
    expect(totals.balance).toBeCloseTo(1000 - 150, 6)
    expect(totals.portfolioValue).toBeCloseTo(expectedMark, 5)
    expect(totals.totalInvested).toBeCloseTo(150, 6)
    expect(totals.totalUnrealizedPnl).toBeCloseTo(expectedMark - 150, 5)
  })

  it('values resolved markets at settlement: YES pays yesShares, CANCEL refunds invested', async () => {
    const alice = service.createAccount('alice-agent')
    const bob = service.createAccount('bob-agent')
    const won = makeMarket(alice.account.id, 'Will ETH flip BTC by 2030?')
    const cancelled = makeMarket(alice.account.id, 'Will it rain in Lisbon tomorrow?')

    const buyWon = service.buy(bob.account.id, won.id, 'YES', 80)
    service.buy(bob.account.id, cancelled.id, 'NO', 60)
    service.resolveMarket(alice.account.id, won.id, 'YES')
    service.resolveMarket(alice.account.id, cancelled.id, 'CANCEL')

    const body = await json(await get('/accounts/me/portfolio', bob.apiKey))
    const byId = new Map<string, any>(
      body.data.positions.map((p: any) => [p.marketId, p])
    )

    const wonEntry = byId.get(won.id)
    expect(wonEntry.status).toBe('RESOLVED')
    expect(wonEntry.outcome).toBe('YES')
    expect(wonEntry.markValue).toBeCloseTo(buyWon.shares, 6)
    expect(wonEntry.unrealizedPnl).toBeCloseTo(buyWon.shares - 80, 5)

    const cancelEntry = byId.get(cancelled.id)
    expect(cancelEntry.outcome).toBe('CANCEL')
    expect(cancelEntry.markValue).toBeCloseTo(60, 6)
    expect(cancelEntry.unrealizedPnl).toBeCloseTo(0, 6)

    const totals = body.data.totals
    expect(totals.portfolioValue).toBeCloseTo(buyWon.shares + 60, 5)
    expect(totals.totalInvested).toBeCloseTo(140, 6)
    expect(totals.totalUnrealizedPnl).toBeCloseTo(buyWon.shares - 80, 5)
  })

  it('excludes positions whose shares were fully sold', async () => {
    const alice = service.createAccount('alice-agent')
    const bob = service.createAccount('bob-agent')
    const market = makeMarket(alice.account.id)

    const buy = service.buy(bob.account.id, market.id, 'YES', 40)
    service.sell(bob.account.id, market.id, 'YES', buy.shares)

    const body = await json(await get('/accounts/me/portfolio', bob.apiKey))
    expect(body.data.positions).toHaveLength(0)
    expect(body.data.totals.portfolioValue).toBe(0)
    expect(body.data.totals.totalInvested).toBe(0)
    expect(body.data.totals.balance).toBeCloseTo(
      service.getAccount(bob.account.id).balance,
      6
    )
  })
})

describe('GET /feed', () => {
  it('merges trades, market creations, and resolutions newest first', async () => {
    const alice = service.createAccount('alice-agent')
    const bob = service.createAccount('bob-agent')

    const m1 = makeMarket(alice.account.id, 'Will BTC close above $150k in 2026?')
    const trade = service.buy(bob.account.id, m1.id, 'YES', 30)
    const m2 = makeMarket(alice.account.id, 'Will SOL hit $1000 in 2026?')
    service.resolveMarket(alice.account.id, m1.id, 'YES')

    setMarketCreatedTime(m1.id, 1000)
    setTradeTime(trade.tradeId, 2000)
    setMarketCreatedTime(m2.id, 3000)
    setMarketResolvedTime(m1.id, 4000)

    const body = await json(await get('/feed'))
    expect(body.success).toBe(true)
    const events = body.data.events
    expect(events).toHaveLength(4)
    expect(events.map((e: any) => e.type)).toEqual([
      'resolved',
      'market_created',
      'trade',
      'market_created',
    ])
    expect(events.map((e: any) => e.createdAt)).toEqual([4000, 3000, 2000, 1000])

    expect(events[0]).toEqual({
      type: 'resolved',
      marketId: m1.id,
      question: m1.question,
      outcome: 'YES',
      createdAt: 4000,
    })
    expect(events[1]).toEqual({
      type: 'market_created',
      marketId: m2.id,
      question: m2.question,
      probability: service.getMarket(m2.id).probability,
      createdAt: 3000,
    })
    expect(events[2]).toEqual({
      type: 'trade',
      marketId: m1.id,
      question: m1.question,
      side: 'YES',
      kind: 'BUY',
      amount: 30,
      probAfter: trade.probAfter,
      createdAt: 2000,
    })
    expect(events[3].marketId).toBe(m1.id)
  })

  it('applies the limit after merging', async () => {
    const alice = service.createAccount('alice-agent')
    const bob = service.createAccount('bob-agent')
    const m1 = makeMarket(alice.account.id)
    const trade = service.buy(bob.account.id, m1.id, 'YES', 20)

    setMarketCreatedTime(m1.id, 1000)
    setTradeTime(trade.tradeId, 2000)

    const body = await json(await get('/feed?limit=1'))
    expect(body.data.events).toHaveLength(1)
    expect(body.data.events[0].type).toBe('trade')
  })

  it('returns an empty feed on a fresh database and validates limit', async () => {
    const empty = await json(await get('/feed'))
    expect(empty.success).toBe(true)
    expect(empty.data.events).toEqual([])

    for (const q of ['limit=0', 'limit=101', 'limit=abc']) {
      const res = await get(`/feed?${q}`)
      expect(res.status).toBe(400)
      expect((await json(res)).success).toBe(false)
    }
  })
})
