// Reputation analytics tests: Brier weighting math against hand-computed
// values, realized profit correctness on real resolved markets, leaderboard
// ordering (including the Brier volume floor), platform totals, and the
// public stats routes. Everything runs on a real in-memory engine.

import { beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { openDb, type Db } from '../src/engine/store'
import {
  MarketService,
  BUY_FEE_RATE,
  type Account,
  type Position,
} from '../src/engine/service'
import {
  accountStats,
  computeBrier,
  leaderboard,
  platformStats,
  BRIER_MIN_VOLUME,
  type BrierTrade,
} from '../src/engine/reputation'
import { createStatsRoutes } from '../src/routes/stats'

let db: Db
let svc: MarketService
let creator: Account
let bob: Account
let carol: Account

const FUTURE = () => Date.now() + 7 * 24 * 60 * 60 * 1000

function makeMarket() {
  return svc.createMarket(creator.id, {
    question: 'Will BTC close above $150k on Dec 31, 2026?',
    criteria: 'Resolves YES on a CoinGecko daily close above $150,000.',
    closeTime: FUTURE(),
    subsidy: 100,
  })
}

function getPos(accountId: string, marketId: string): Position {
  const pos = svc
    .getPositions(accountId)
    .find((p) => p.marketId === marketId)
  if (!pos) throw new Error(`no position for ${accountId} in ${marketId}`)
  return pos
}

// Two markets: m1 resolves YES (bob right, carol wrong), m2 resolves NO
// (bob right again). Positions are captured before resolution.
function buildResolvedScenario() {
  const m1 = makeMarket()
  const bobBuy1 = svc.buy(bob.id, m1.id, 'YES', 100)
  const carolBuy1 = svc.buy(carol.id, m1.id, 'NO', 60)
  const bobPos1 = getPos(bob.id, m1.id)
  const carolPos1 = getPos(carol.id, m1.id)
  svc.resolveMarket(creator.id, m1.id, 'YES')

  const m2 = makeMarket()
  const bobBuy2 = svc.buy(bob.id, m2.id, 'NO', 40)
  const bobPos2 = getPos(bob.id, m2.id)
  svc.resolveMarket(creator.id, m2.id, 'NO')

  return { m1, m2, bobBuy1, bobBuy2, carolBuy1, bobPos1, bobPos2, carolPos1 }
}

beforeEach(() => {
  db = openDb(':memory:')
  svc = new MarketService(db)
  creator = svc.createAccount('creator-agent').account
  bob = svc.createAccount('bob-agent').account
  carol = svc.createAccount('carol-agent').account
})

describe('computeBrier (pure)', () => {
  const trades: BrierTrade[] = [
    { kind: 'BUY', amount: 100, probAfter: 0.6 },
    { kind: 'BUY', amount: 50, probAfter: 0.8 },
    { kind: 'SELL', amount: 30, probAfter: 0.7 }, // ignored
  ]

  it('weights squared error by amount for a YES outcome', () => {
    // (100*(0.6-1)^2 + 50*(0.8-1)^2) / 150 = (16 + 2) / 150 = 0.12
    expect(computeBrier(trades, 'YES')).toBeCloseTo(0.12, 10)
  })

  it('scores the same forecasts worse when NO wins', () => {
    // (100*0.36 + 50*0.64) / 150 = 68 / 150
    expect(computeBrier(trades, 'NO')).toBeCloseTo(68 / 150, 10)
  })

  it('returns null for CANCEL, empty input, and SELL-only input', () => {
    expect(computeBrier(trades, 'CANCEL')).toBeNull()
    expect(computeBrier([], 'YES')).toBeNull()
    expect(
      computeBrier([{ kind: 'SELL', amount: 30, probAfter: 0.7 }], 'YES')
    ).toBeNull()
  })
})

describe('accountStats', () => {
  it('computes trade-weighted brier across resolved markets', () => {
    const s = buildResolvedScenario()

    // Bob: BUY 100 in m1 (YES won, o=1) + BUY 40 in m2 (NO won, o=0).
    const f1 = s.bobBuy1.probAfter
    const f2 = s.bobBuy2.probAfter
    const expectedBob = (100 * (f1 - 1) ** 2 + 40 * f2 ** 2) / 140
    expect(accountStats(db, bob.id)?.brierScore).toBeCloseTo(expectedBob, 5)

    // Carol: single BUY of 60, so the weighted score is just (f-1)^2.
    const fc = s.carolBuy1.probAfter
    expect(accountStats(db, carol.id)?.brierScore).toBeCloseTo(
      (fc - 1) ** 2,
      5
    )

    // Creator never traded: no forecasts to score.
    expect(accountStats(db, creator.id)?.brierScore).toBeNull()
  })

  it('computes realized profit: winners positive, losers negative', () => {
    const s = buildResolvedScenario()

    const bobStats = accountStats(db, bob.id)
    const expectedBob =
      s.bobPos1.yesShares - s.bobPos1.invested +
      (s.bobPos2.noShares - s.bobPos2.invested)
    expect(bobStats?.realizedProfit).toBeCloseTo(expectedBob, 4)
    expect(bobStats?.realizedProfit ?? 0).toBeGreaterThan(0)

    // Carol held only NO shares in a YES market: total loss of her stake.
    expect(accountStats(db, carol.id)?.realizedProfit).toBeCloseTo(-60, 4)
  })

  it('credits creators with fees and counts their markets', () => {
    buildResolvedScenario()
    const s = accountStats(db, creator.id)
    expect(s?.marketsCreated).toBe(2)
    expect(s?.feesEarned).toBeCloseTo(BUY_FEE_RATE * (100 + 60 + 40), 6)
    expect(s?.realizedProfit).toBe(0) // never held a position
    expect(s?.marketsTraded).toBe(0)
  })

  it('tracks volume and traded-market counts', () => {
    buildResolvedScenario()
    const bobStats = accountStats(db, bob.id)
    expect(bobStats?.volume).toBeCloseTo(140, 6)
    expect(bobStats?.marketsTraded).toBe(2)
    expect(bobStats?.marketsResolvedTraded).toBe(2)

    const carolStats = accountStats(db, carol.id)
    expect(carolStats?.volume).toBeCloseTo(60, 6)
    expect(carolStats?.marketsTraded).toBe(1)
  })

  it('treats CANCEL markets as zero profit and excludes them from brier', () => {
    const m = makeMarket()
    svc.buy(bob.id, m.id, 'YES', 50)
    svc.resolveMarket(creator.id, m.id, 'CANCEL')

    const s = accountStats(db, bob.id)
    expect(s?.realizedProfit).toBeCloseTo(0, 6) // invested refunded
    expect(s?.brierScore).toBeNull()
    expect(s?.marketsResolvedTraded).toBe(1)
  })

  it('returns null for unknown accounts', () => {
    expect(accountStats(db, 'acct_missing')).toBeNull()
  })
})

describe('leaderboard', () => {
  it('ranks by profit descending and respects limit', () => {
    buildResolvedScenario()
    const entries = leaderboard(db, { by: 'profit', limit: 10 })
    expect(entries).toHaveLength(3)
    expect(entries[0]!.accountId).toBe(bob.id)
    expect(entries[0]!.rank).toBe(1)
    expect(entries[2]!.accountId).toBe(carol.id)

    const limited = leaderboard(db, { by: 'profit', limit: 1 })
    expect(limited).toHaveLength(1)
    expect(limited[0]!.accountId).toBe(bob.id)
  })

  it('ranks by volume descending', () => {
    buildResolvedScenario()
    const entries = leaderboard(db, { by: 'volume', limit: 10 })
    expect(entries[0]!.accountId).toBe(bob.id) // 140
    expect(entries[1]!.accountId).toBe(carol.id) // 60
  })

  it('ranks by brier ascending and enforces the volume floor', () => {
    buildResolvedScenario()

    // Dave trades below the volume floor in a resolved market.
    const dave = svc.createAccount('dave-agent').account
    const m3 = makeMarket()
    svc.buy(dave.id, m3.id, 'YES', BRIER_MIN_VOLUME / 5)
    svc.resolveMarket(creator.id, m3.id, 'YES')

    const entries = leaderboard(db, { by: 'brier', limit: 10 })
    const ids = entries.map((e) => e.accountId)
    expect(ids).not.toContain(dave.id) // volume 10 < 50
    expect(ids).not.toContain(creator.id) // no forecasts at all
    expect(ids).toEqual(expect.arrayContaining([bob.id, carol.id]))
    expect(entries).toHaveLength(2)
    // Ascending: lower (better) brier first.
    expect(entries[0]!.brierScore!).toBeLessThanOrEqual(
      entries[1]!.brierScore!
    )
    expect(entries[0]!.accountId).toBe(bob.id) // right twice beats wrong once
  })
})

describe('platformStats', () => {
  it('reports real totals across accounts, markets, and trades', () => {
    const s = buildResolvedScenario()
    const open = makeMarket() // one still-open market

    const stats = platformStats(db)
    expect(stats.accounts).toBe(3)
    expect(stats.markets).toBe(3)
    expect(stats.openMarkets).toBe(1)
    expect(stats.resolvedMarkets).toBe(2)
    expect(stats.totalTrades).toBe(3)

    const expectedVolume =
      svc.getMarket(s.m1.id).volume +
      svc.getMarket(s.m2.id).volume +
      svc.getMarket(open.id).volume
    expect(stats.totalVolume).toBeCloseTo(expectedVolume, 6)
    expect(stats.totalVolume).toBeCloseTo(200, 6) // 100+60 in m1, 40 in m2
  })
})

describe('stats routes', () => {
  function makeApp() {
    const app = new Hono()
    app.route('/', createStatsRoutes(db))
    return app
  }

  async function json(res: Response) {
    return (await res.json()) as { success: boolean; data?: any; error?: string }
  }

  it('GET /stats/platform returns totals', async () => {
    buildResolvedScenario()
    const res = await makeApp().request('/stats/platform')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.success).toBe(true)
    expect(body.data.platform.accounts).toBe(3)
    expect(body.data.platform.resolvedMarkets).toBe(2)
  })

  it('GET /stats/leaderboard defaults to profit and applies query params', async () => {
    buildResolvedScenario()
    const app = makeApp()

    const dflt = await json(await app.request('/stats/leaderboard'))
    expect(dflt.success).toBe(true)
    expect(dflt.data.by).toBe('profit')
    expect(dflt.data.leaderboard[0].accountId).toBe(bob.id)

    const byVolume = await json(
      await app.request('/stats/leaderboard?by=volume&limit=1')
    )
    expect(byVolume.data.by).toBe('volume')
    expect(byVolume.data.leaderboard).toHaveLength(1)
    expect(byVolume.data.leaderboard[0].accountId).toBe(bob.id)
  })

  it('GET /stats/leaderboard rejects invalid query params', async () => {
    const app = makeApp()
    for (const qs of ['?by=bogus', '?limit=0', '?limit=101', '?limit=abc']) {
      const res = await app.request(`/stats/leaderboard${qs}`)
      expect(res.status).toBe(400)
      expect((await json(res)).success).toBe(false)
    }
  })

  it('GET /stats/accounts/:id returns stats or 404', async () => {
    buildResolvedScenario()
    const app = makeApp()

    const res = await app.request(`/stats/accounts/${bob.id}`)
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.data.stats.name).toBe('bob-agent')
    expect(body.data.stats.volume).toBeCloseTo(140, 6)
    expect(body.data.stats.marketsResolvedTraded).toBe(2)

    const missing = await app.request('/stats/accounts/acct_missing')
    expect(missing.status).toBe(404)
    expect((await json(missing)).success).toBe(false)
  })
})
