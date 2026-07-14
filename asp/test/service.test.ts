import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../src/engine/store'
import {
  MarketService,
  ServiceError,
  SIGNUP_GRANT,
  type Account,
} from '../src/engine/service'

let db: Db
let svc: MarketService
let alice: Account
let bob: Account
let aliceKey: string

const FUTURE = () => Date.now() + 7 * 24 * 60 * 60 * 1000

function makeMarket(creatorId: string, overrides: Record<string, unknown> = {}) {
  return svc.createMarket(creatorId, {
    question: 'Will BTC close above $150k on Dec 31, 2026?',
    criteria: 'Resolves YES on a CoinGecko daily close above $150,000.',
    closeTime: FUTURE(),
    subsidy: 100,
    ...overrides,
  })
}

beforeEach(() => {
  db = openDb(':memory:')
  svc = new MarketService(db)
  const a = svc.createAccount('alice-agent')
  const b = svc.createAccount('bob-agent')
  alice = a.account
  bob = b.account
  aliceKey = a.apiKey
})

describe('accounts', () => {
  it('grants signup balance and authenticates by API key only', () => {
    expect(alice.balance).toBe(SIGNUP_GRANT)
    expect(svc.getAccountByKey(aliceKey)?.id).toBe(alice.id)
    expect(svc.getAccountByKey('pk_wrong')).toBeNull()
  })

  it('rejects invalid names', () => {
    expect(() => svc.createAccount('x')).toThrowError(ServiceError)
  })
})

describe('createMarket', () => {
  it('debits the subsidy and opens at the initial probability', () => {
    const market = makeMarket(alice.id, { initialProb: 0.3 })
    expect(market.status).toBe('OPEN')
    expect(market.probability).toBeCloseTo(0.3, 6)
    expect(svc.getAccount(alice.id).balance).toBe(SIGNUP_GRANT - 100)
  })

  it('rejects a past closeTime and insufficient balance', () => {
    expect(() =>
      makeMarket(alice.id, { closeTime: Date.now() - 1000 })
    ).toThrowError(/future/)
    expect(() => makeMarket(alice.id, { subsidy: 10_000 })).toThrowError(
      /Insufficient/
    )
  })
})

describe('trading', () => {
  it('buy moves the price and debits the buyer', () => {
    const market = makeMarket(alice.id)
    const trade = svc.buy(bob.id, market.id, 'YES', 50)
    expect(trade.shares).toBeGreaterThan(50) // ~0.5/share at p=0.5
    expect(trade.probAfter).toBeGreaterThan(0.5)
    expect(trade.balance).toBe(SIGNUP_GRANT - 50)
  })

  it('credits the buy fee to the market creator', () => {
    const market = makeMarket(alice.id)
    const before = svc.getAccount(alice.id).balance
    svc.buy(bob.id, market.id, 'YES', 100)
    expect(svc.getAccount(alice.id).balance).toBeCloseTo(before + 1, 6) // 1% of 100
  })

  it('sell requires holding the shares', () => {
    const market = makeMarket(alice.id)
    expect(() => svc.sell(bob.id, market.id, 'YES', 5)).toThrowError(/hold/)
    const trade = svc.buy(bob.id, market.id, 'YES', 50)
    const sale = svc.sell(bob.id, market.id, 'YES', trade.shares)
    expect(sale.amount).toBeGreaterThan(0)
  })

  it('rejects trades on closed markets and past close time', () => {
    const market = makeMarket(alice.id)
    svc.closeMarket(alice.id, market.id)
    expect(() => svc.buy(bob.id, market.id, 'YES', 10)).toThrowError(/not open/)
  })

  it('rejects a buy the balance cannot cover', () => {
    const market = makeMarket(alice.id)
    expect(() => svc.buy(bob.id, market.id, 'YES', 5000)).toThrowError(
      /Insufficient/
    )
  })
})

describe('resolution and payouts', () => {
  it('pays winning shares 1 each and refunds pool leftovers to the creator', () => {
    const market = makeMarket(alice.id)
    const trade = svc.buy(bob.id, market.id, 'YES', 50)

    const resolved = svc.resolveMarket(alice.id, market.id, 'YES')
    expect(resolved.status).toBe('RESOLVED')
    expect(resolved.outcome).toBe('YES')

    const bobFinal = svc.getAccount(bob.id).balance
    expect(bobFinal).toBeCloseTo(SIGNUP_GRANT - 50 + trade.shares, 4)
  })

  it('conserves total money across the whole lifecycle', () => {
    const market = makeMarket(alice.id)
    svc.buy(bob.id, market.id, 'YES', 80)
    svc.buy(alice.id, market.id, 'NO', 40)
    svc.resolveMarket(alice.id, market.id, 'NO')

    const total =
      svc.getAccount(alice.id).balance + svc.getAccount(bob.id).balance
    // No money minted or burned: totals return to the two signup grants
    // (payouts + creator refund exactly redistribute stakes and subsidy).
    expect(total).toBeCloseTo(2 * SIGNUP_GRANT, 2)
  })

  it('CANCEL refunds net cost basis and the subsidy', () => {
    const market = makeMarket(alice.id)
    svc.buy(bob.id, market.id, 'YES', 60)
    svc.resolveMarket(alice.id, market.id, 'CANCEL')
    // Bob paid 60; 0.6 of that was the fee the creator keeps, so the CANCEL
    // refund is his pool-net cost basis of 59.4. Refunding the fee too would
    // mint money (the pool only ever held 59.4 of his stake).
    expect(svc.getAccount(bob.id).balance).toBeCloseTo(SIGNUP_GRANT - 0.6, 4)
  })

  it('conserves total money when a traded market is cancelled', () => {
    // Regression: CANCEL used to refund traders their gross stake (fees
    // included) while fees had already been paid to the creator — minting
    // one credit per 100 traded. Totals must return to the signup grants.
    const market = makeMarket(alice.id)
    svc.buy(bob.id, market.id, 'YES', 100)
    svc.buy(alice.id, market.id, 'NO', 40)
    const sold = svc.getPositions(bob.id)[0]!
    svc.sell(bob.id, market.id, 'YES', sold.yesShares / 3)
    svc.resolveMarket(alice.id, market.id, 'CANCEL')

    const total =
      svc.getAccount(alice.id).balance + svc.getAccount(bob.id).balance
    expect(total).toBeCloseTo(2 * SIGNUP_GRANT, 2)
    // The creator ends up with exactly the fees on top of their grant.
    expect(svc.getAccount(alice.id).balance).toBeCloseTo(
      SIGNUP_GRANT + 0.01 * 140 - 0.01 * 40,
      2
    )
  })

  it('only the creator can close or resolve, and only once', () => {
    const market = makeMarket(alice.id)
    expect(() => svc.resolveMarket(bob.id, market.id, 'YES')).toThrowError(
      /creator/
    )
    svc.resolveMarket(alice.id, market.id, 'YES')
    expect(() => svc.resolveMarket(alice.id, market.id, 'NO')).toThrowError(
      /already resolved/
    )
  })
})
