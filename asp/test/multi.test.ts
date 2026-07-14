// Multi-outcome (multiple-choice) markets, end to end: answer-pool engine
// helpers, schema migration of pre-MULTI databases, the full service
// lifecycle (create -> quote -> buy -> sell -> resolve) including exact
// creator-refund math and conservation of money, CANCEL refunds, and the
// read-side surfaces (portfolio, trades, feed, reputation) fed by MULTI data.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { openDb, type Db } from '../src/engine/store'
import {
  MarketService,
  ServiceError,
  SIGNUP_GRANT,
  type Account,
} from '../src/engine/service'
import {
  creatorRefundForWinner,
  initialAnswerProb,
  leadingAnswer,
  normalizeAnswerTexts,
  type AnswerRow,
} from '../src/engine/answers'
import { accountStats } from '../src/engine/reputation'
import { createActivityRoutes } from '../src/routes/activity'

let db: Db
let svc: MarketService
let creator: Account
let bob: Account
let carol: Account
let bobKey: string

const FUTURE = () => Date.now() + 7 * 24 * 60 * 60 * 1000

function makeMulti(
  overrides: Record<string, unknown> = {},
  creatorId = creator.id
) {
  return svc.createMarket(creatorId, {
    question: 'Which team wins the 2026 agent hackathon?',
    criteria: 'Resolves to the winner announced on the official results page.',
    closeTime: FUTURE(),
    subsidy: 90,
    outcomeType: 'MULTI',
    answers: ['Team Alpha', 'Team Beta', 'Team Gamma'],
    ...overrides,
  })
}

function makeBinary(creatorId = creator.id) {
  return svc.createMarket(creatorId, {
    question: 'Will BTC close above $150k on Dec 31, 2026?',
    criteria: 'Resolves YES on a CoinGecko daily close above $150,000.',
    closeTime: FUTURE(),
    subsidy: 100,
  })
}

function answerRows(marketId: string): AnswerRow[] {
  return db
    .prepare('SELECT * FROM answers WHERE market_id = ? ORDER BY ord ASC')
    .all(marketId) as AnswerRow[]
}

function totalBalances(): number {
  const row = db
    .prepare('SELECT SUM(balance) AS total FROM accounts')
    .get() as { total: number }
  return row.total
}

beforeEach(() => {
  db = openDb(':memory:')
  svc = new MarketService(db)
  const a = svc.createAccount('creator-agent')
  const b = svc.createAccount('bob-agent')
  const c = svc.createAccount('carol-agent')
  creator = a.account
  bob = b.account
  carol = c.account
  bobKey = b.apiKey
})

// ---- pure answer helpers ----------------------------------------------------

describe('answer engine helpers', () => {
  it('normalizeAnswerTexts trims and enforces 2-12 distinct answers', () => {
    expect(normalizeAnswerTexts(['  A ', 'B'])).toEqual(['A', 'B'])
    expect(() => normalizeAnswerTexts(['only-one'])).toThrowError(/2-12/)
    expect(() =>
      normalizeAnswerTexts(Array.from({ length: 13 }, (_, i) => `a${i}`))
    ).toThrowError(/2-12/)
    expect(() => normalizeAnswerTexts(['dup', 'DUP '])).toThrowError(/distinct/)
    expect(() => normalizeAnswerTexts(['ok', '   '])).toThrowError(/1-120/)
    expect(() => normalizeAnswerTexts(['ok', 'x'.repeat(121)])).toThrowError(
      /1-120/
    )
  })

  it('initialAnswerProb is 1/n clamped to [0.02, 0.98]', () => {
    expect(initialAnswerProb(2)).toBeCloseTo(0.5, 12)
    expect(initialAnswerProb(12)).toBeCloseTo(1 / 12, 12)
    expect(initialAnswerProb(100)).toBe(0.02)
    expect(initialAnswerProb(1)).toBe(0.98)
  })

  it('creatorRefundForWinner sums winner pool_yes + loser pool_no', () => {
    const rows = [
      { id: 'a', pool_yes: 10, pool_no: 40 },
      { id: 'b', pool_yes: 25, pool_no: 7 },
      { id: 'c', pool_yes: 3, pool_no: 11 },
    ] as AnswerRow[]
    expect(creatorRefundForWinner(rows, 'b')).toBeCloseTo(40 + 25 + 11, 6)
  })

  it('leadingAnswer picks the highest probability, first ord on ties', () => {
    const rows = answerRows(makeMulti().id)
    // All pools start identical, so the first answer leads.
    expect(leadingAnswer(rows)?.text).toBe('Team Alpha')
  })
})

// ---- schema migration --------------------------------------------------------

describe('store migration for pre-MULTI databases', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'predikt-migration-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('upgrades an old-schema database in place, preserving positions', () => {
    const path = join(dir, 'old.db')
    const old = new Database(path)
    old.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        api_key_hash TEXT NOT NULL UNIQUE,
        balance REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE markets (
        id TEXT PRIMARY KEY, creator_id TEXT NOT NULL REFERENCES accounts(id),
        question TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        criteria TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'General',
        close_time INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN',
        outcome TEXT, pool_yes REAL NOT NULL, pool_no REAL NOT NULL,
        pool_p REAL NOT NULL, pool_k REAL NOT NULL, subsidy REAL NOT NULL,
        volume REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE TABLE positions (
        account_id TEXT NOT NULL REFERENCES accounts(id),
        market_id TEXT NOT NULL REFERENCES markets(id),
        yes_shares REAL NOT NULL DEFAULT 0, no_shares REAL NOT NULL DEFAULT 0,
        invested REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, market_id)
      );
      CREATE TABLE trades (
        id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL REFERENCES markets(id),
        account_id TEXT NOT NULL REFERENCES accounts(id),
        kind TEXT NOT NULL, side TEXT NOT NULL, amount REAL NOT NULL,
        shares REAL NOT NULL, fee REAL NOT NULL DEFAULT 0,
        prob_before REAL NOT NULL, prob_after REAL NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO accounts VALUES ('acct_1', 'legacy', 'hash1', 500, 1);
      INSERT INTO markets VALUES ('mkt_1', 'acct_1', 'Old binary question?',
        '', 'Some criteria here.', 'General', 9999999999999, 'OPEN', NULL,
        100, 100, 0.5, 100, 100, 25, 1, NULL);
      INSERT INTO positions VALUES ('acct_1', 'mkt_1', 3, 4, 20);
      INSERT INTO trades VALUES ('trd_1', 'mkt_1', 'acct_1', 'BUY', 'YES',
        10, 19, 0.1, 0.5, 0.55, 2);
    `)
    old.close()

    // openDb migrates; opening twice proves the migration is idempotent.
    openDb(path).close()
    const upgraded = openDb(path)

    const market = upgraded
      .prepare('SELECT outcome_type FROM markets WHERE id = ?')
      .get('mkt_1') as { outcome_type: string }
    expect(market.outcome_type).toBe('BINARY')

    const pos = upgraded
      .prepare('SELECT * FROM positions WHERE account_id = ?')
      .get('acct_1') as Record<string, unknown>
    expect(pos).toMatchObject({
      market_id: 'mkt_1',
      answer_id: '',
      yes_shares: 3,
      no_shares: 4,
      invested: 20,
    })

    const trade = upgraded
      .prepare('SELECT answer_id FROM trades WHERE id = ?')
      .get('trd_1') as { answer_id: string | null }
    expect(trade.answer_id).toBeNull()

    // The upgraded database is fully usable by the service.
    const upgradedSvc = new MarketService(upgraded)
    const acct = upgradedSvc.createAccount('post-migration').account
    const market2 = upgradedSvc.createMarket(acct.id, {
      question: 'Which option wins after migration?',
      criteria: 'Resolves to the announced winner.',
      closeTime: FUTURE(),
      outcomeType: 'MULTI',
      answers: ['One', 'Two'],
    })
    expect(market2.answers).toHaveLength(2)
    upgraded.close()
  })
})

// ---- createMarket -------------------------------------------------------------

describe('createMarket MULTI', () => {
  it('splits the subsidy equally and opens every answer at 1/n', () => {
    const market = makeMulti()
    expect(market.outcomeType).toBe('MULTI')
    expect(market.status).toBe('OPEN')
    expect(market.answers).toHaveLength(3)
    for (const answer of market.answers!) {
      expect(answer.probability).toBeCloseTo(1 / 3, 6)
      expect(answer.volume).toBe(0)
      expect(answer.id).toMatch(/^ans_/)
    }
    expect(market.answers!.map((a) => a.text)).toEqual([
      'Team Alpha',
      'Team Beta',
      'Team Gamma',
    ])
    // Top-level probability is the leading answer's probability.
    expect(market.probability).toBeCloseTo(1 / 3, 6)
    expect(svc.getAccount(creator.id).balance).toBe(SIGNUP_GRANT - 90)

    const rows = answerRows(market.id)
    for (const row of rows) {
      expect(row.pool_yes).toBeCloseTo(30, 9)
      expect(row.pool_no).toBeCloseTo(30, 9)
      expect(row.pool_p).toBeCloseTo(1 / 3, 9)
    }
  })

  it('rejects invalid MULTI inputs with 400s', () => {
    expect(() => makeMulti({ answers: undefined })).toThrowError(
      /require an answers array/
    )
    expect(() => makeMulti({ answers: ['solo'] })).toThrowError(/2-12/)
    expect(() =>
      makeMulti({ answers: Array.from({ length: 13 }, (_, i) => `t${i}`) })
    ).toThrowError(/2-12/)
    expect(() => makeMulti({ answers: ['Same', ' same '] })).toThrowError(
      /distinct/
    )
    expect(() => makeMulti({ initialProb: 0.4 })).toThrowError(
      /initialProb is not supported/
    )
    // answers on a BINARY market are rejected too.
    expect(() =>
      makeMulti({ outcomeType: 'BINARY', answers: ['A', 'B'] })
    ).toThrowError(/only valid for MULTI/)
  })

  it('binary markets stay BINARY with no answers attached', () => {
    const market = makeBinary()
    expect(market.outcomeType).toBe('BINARY')
    expect(market.answers).toBeUndefined()
  })
})

// ---- trading -------------------------------------------------------------------

describe('MULTI trading', () => {
  it('requires a valid answerId on quote, buy, and sell', () => {
    const market = makeMulti()
    expect(() => svc.quote(market.id, 'YES', 10)).toThrowError(
      /answerId is required/
    )
    expect(() => svc.buy(bob.id, market.id, 'YES', 10)).toThrowError(
      /answerId is required/
    )
    expect(() => svc.sell(bob.id, market.id, 'YES', 1)).toThrowError(
      /answerId is required/
    )
    expect(() =>
      svc.buy(bob.id, market.id, 'YES', 10, 'ans_nope')
    ).toThrowError(/Unknown answerId/)

    const binary = makeBinary()
    const wrongAnswer = market.answers![0]!.id
    expect(() =>
      svc.buy(bob.id, binary.id, 'YES', 10, wrongAnswer)
    ).toThrowError(/only valid for MULTI/)
    expect(() => svc.quote(binary.id, 'YES', 10, wrongAnswer)).toThrowError(
      /only valid for MULTI/
    )
  })

  it('a buy moves only the targeted answer pool and records answerId', () => {
    const market = makeMulti()
    const [alpha, beta, gamma] = market.answers!
    const quote = svc.quote(market.id, 'YES', 60, beta!.id)
    const trade = svc.buy(bob.id, market.id, 'YES', 60, beta!.id)

    expect(trade.shares).toBeCloseTo(quote.shares, 6)
    expect(trade.answerId).toBe(beta!.id)
    expect(trade.fee).toBeCloseTo(0.6, 6)
    expect(trade.probAfter).toBeGreaterThan(1 / 3)

    const after = svc.getMarket(market.id)
    const answersById = new Map(after.answers!.map((a) => [a.id, a]))
    expect(answersById.get(beta!.id)!.probability).toBeCloseTo(
      trade.probAfter,
      6
    )
    expect(answersById.get(alpha!.id)!.probability).toBeCloseTo(1 / 3, 6)
    expect(answersById.get(gamma!.id)!.probability).toBeCloseTo(1 / 3, 6)
    // Leading answer drives the top-level probability now.
    expect(after.probability).toBeCloseTo(trade.probAfter, 6)

    // Volume lands on both the answer and the market aggregate.
    expect(answersById.get(beta!.id)!.volume).toBeCloseTo(60, 6)
    expect(after.volume).toBeCloseTo(60, 6)

    // The fee went to the creator; the position carries the answerId.
    expect(svc.getAccount(creator.id).balance).toBeCloseTo(
      SIGNUP_GRANT - 90 + 0.6,
      6
    )
    const pos = svc.getPositions(bob.id)
    expect(pos).toHaveLength(1)
    // invested is the pool-net cost basis: the 1% fee went to the creator.
    expect(pos[0]).toMatchObject({
      marketId: market.id,
      answerId: beta!.id,
      invested: 59.4,
    })
    expect(pos[0]!.yesShares).toBeCloseTo(trade.shares, 6)
  })

  it('positions on different answers of one market stay separate', () => {
    const market = makeMulti()
    const [alpha, beta] = market.answers!
    const buyAlpha = svc.buy(bob.id, market.id, 'YES', 30, alpha!.id)
    const buyBeta = svc.buy(bob.id, market.id, 'NO', 20, beta!.id)

    const positions = svc.getPositions(bob.id)
    expect(positions).toHaveLength(2)
    const byAnswer = new Map(positions.map((p) => [p.answerId, p]))
    expect(byAnswer.get(alpha!.id)!.yesShares).toBeCloseTo(buyAlpha.shares, 6)
    expect(byAnswer.get(alpha!.id)!.noShares).toBe(0)
    expect(byAnswer.get(beta!.id)!.noShares).toBeCloseTo(buyBeta.shares, 6)

    // Selling requires holding shares on that specific answer.
    expect(() =>
      svc.sell(bob.id, market.id, 'YES', 5, beta!.id)
    ).toThrowError(/hold/)
    const sale = svc.sell(bob.id, market.id, 'YES', buyAlpha.shares, alpha!.id)
    expect(sale.amount).toBeGreaterThan(0)
    expect(sale.answerId).toBe(alpha!.id)
  })
})

// ---- resolution ----------------------------------------------------------------

describe('MULTI resolution and payouts', () => {
  it('validates the outcome and the resolver', () => {
    const market = makeMulti()
    const winner = market.answers![1]!.id
    expect(() => svc.resolveMarket(bob.id, market.id, winner)).toThrowError(
      /creator/
    )
    expect(() => svc.resolveMarket(creator.id, market.id, 'YES')).toThrowError(
      /winning answerId or CANCEL/
    )
    svc.resolveMarket(creator.id, market.id, winner)
    expect(() =>
      svc.resolveMarket(creator.id, market.id, winner)
    ).toThrowError(/already resolved/)
  })

  it('pays winner YES shares and loser NO shares 1 each; loser YES pays 0', () => {
    const market = makeMulti()
    const [alpha, beta] = market.answers!

    const bobWinnerYes = svc.buy(bob.id, market.id, 'YES', 50, beta!.id)
    const carolLoserNo = svc.buy(carol.id, market.id, 'NO', 40, alpha!.id)
    const carolLoserYes = svc.buy(carol.id, market.id, 'YES', 30, alpha!.id)
    expect(carolLoserYes.shares).toBeGreaterThan(0)

    const resolved = svc.resolveMarket(creator.id, market.id, beta!.id)
    expect(resolved.status).toBe('RESOLVED')
    expect(resolved.outcome).toBe(beta!.id)

    // Bob: staked 50 on the winning answer's YES -> shares pay 1 each.
    expect(svc.getAccount(bob.id).balance).toBeCloseTo(
      SIGNUP_GRANT - 50 + bobWinnerYes.shares,
      4
    )
    // Carol: her loser-NO shares pay 1 each, her loser-YES shares pay 0.
    expect(svc.getAccount(carol.id).balance).toBeCloseTo(
      SIGNUP_GRANT - 40 - 30 + carolLoserNo.shares,
      4
    )
  })

  it('refunds the creator the winner pool_yes + loser pool_no exactly', () => {
    const market = makeMulti()
    const [alpha, beta, gamma] = market.answers!
    svc.buy(bob.id, market.id, 'YES', 70, alpha!.id)
    svc.buy(carol.id, market.id, 'NO', 25, beta!.id)

    const rows = answerRows(market.id)
    const expectedRefund = creatorRefundForWinner(rows, gamma!.id)
    const feesEarned = 0.01 * (70 + 25)
    const before = svc.getAccount(creator.id).balance

    svc.resolveMarket(creator.id, market.id, gamma!.id)
    expect(svc.getAccount(creator.id).balance).toBeCloseTo(
      before + expectedRefund,
      4
    )
    // Sanity: full ledger for the creator from signup.
    expect(svc.getAccount(creator.id).balance).toBeCloseTo(
      SIGNUP_GRANT - 90 + feesEarned + expectedRefund,
      4
    )
  })

  it('conserves total money across a full MULTI lifecycle', () => {
    expect(totalBalances()).toBeCloseTo(3 * SIGNUP_GRANT, 6)

    const market = makeMulti()
    const [alpha, beta, gamma] = market.answers!
    const bobAlphaYes = svc.buy(bob.id, market.id, 'YES', 120, alpha!.id)
    svc.buy(carol.id, market.id, 'NO', 80, alpha!.id)
    svc.buy(bob.id, market.id, 'YES', 50, beta!.id)
    svc.buy(carol.id, market.id, 'YES', 40, gamma!.id)
    // A partial sell against the alpha pool stirs the ledger further.
    svc.sell(bob.id, market.id, 'YES', bobAlphaYes.shares / 2, alpha!.id)

    // Mid-lifecycle, money sits inside the pools: balances are lower.
    expect(totalBalances()).toBeLessThan(3 * SIGNUP_GRANT)

    svc.resolveMarket(creator.id, market.id, beta!.id)

    // No money minted or burned: payouts + creator refund exactly
    // redistribute the stakes and the subsidy.
    expect(totalBalances()).toBeCloseTo(3 * SIGNUP_GRANT, 2)
  })

  it('CANCEL refunds each trader their net cost across answers and the creator the subsidy', () => {
    const market = makeMulti()
    const [alpha, beta] = market.answers!
    const buy = svc.buy(bob.id, market.id, 'YES', 60, alpha!.id)
    svc.buy(bob.id, market.id, 'NO', 25, beta!.id)
    const sale = svc.sell(bob.id, market.id, 'YES', buy.shares / 2, alpha!.id)

    svc.resolveMarket(creator.id, market.id, 'CANCEL')

    // Bob spent 85 (0.85 of it fees), recouped `sale.amount` mid-flight, and
    // the CANCEL refund returns the remaining pool-net cost basis — his grant
    // minus the fees the creator keeps. Refunding the fees too would mint
    // money that no longer exists in the pool.
    expect(svc.getAccount(bob.id).balance).toBeCloseTo(SIGNUP_GRANT - 0.85, 4)
    expect(sale.amount).toBeGreaterThan(0)
    // Creator: subsidy back + buy fees kept.
    expect(svc.getAccount(creator.id).balance).toBeCloseTo(
      SIGNUP_GRANT + 0.01 * (60 + 25),
      4
    )
  })
})

// ---- read-side surfaces ---------------------------------------------------------

describe('MULTI read-side: portfolio, trades, feed, reputation', () => {
  let app: Hono

  beforeEach(() => {
    app = new Hono()
    app.route('/', createActivityRoutes(svc, db))
  })

  function get(path: string, key?: string) {
    return app.request(path, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    })
  }

  async function json(res: Response) {
    return (await res.json()) as { success: boolean; data?: any; error?: string }
  }

  it('portfolio marks MULTI positions against their answer probability', async () => {
    const market = makeMulti()
    const beta = market.answers![1]!
    const buy = svc.buy(bob.id, market.id, 'YES', 45, beta.id)

    const body = await json(await get('/accounts/me/portfolio', bobKey))
    expect(body.success).toBe(true)
    expect(body.data.positions).toHaveLength(1)
    const entry = body.data.positions[0]
    const answerProb = svc
      .getMarket(market.id)
      .answers!.find((a) => a.id === beta.id)!.probability

    expect(entry.answerId).toBe(beta.id)
    expect(entry.answerText).toBe('Team Beta')
    expect(entry.answerProbability).toBeCloseTo(answerProb, 6)
    expect(entry.markValue).toBeCloseTo(buy.shares * answerProb, 4)
    // Cost basis is net of the 1% fee: 45 * 0.99 = 44.55.
    expect(entry.unrealizedPnl).toBeCloseTo(buy.shares * answerProb - 44.55, 4)
  })

  it('portfolio values resolved MULTI positions at settlement', async () => {
    const market = makeMulti()
    const [alpha, beta] = market.answers!
    const winnerBuy = svc.buy(bob.id, market.id, 'YES', 30, beta!.id)
    const loserBuy = svc.buy(bob.id, market.id, 'YES', 20, alpha!.id)
    expect(loserBuy.shares).toBeGreaterThan(0)
    svc.resolveMarket(creator.id, market.id, beta!.id)

    const body = await json(await get('/accounts/me/portfolio', bobKey))
    const byAnswer = new Map<string, any>(
      body.data.positions.map((p: any) => [p.answerId, p])
    )
    expect(byAnswer.get(beta!.id)!.markValue).toBeCloseTo(winnerBuy.shares, 6)
    expect(byAnswer.get(alpha!.id)!.markValue).toBe(0)
  })

  it('trade history and the feed carry MULTI trades without corruption', async () => {
    const market = makeMulti()
    const beta = market.answers![1]!
    const trade = svc.buy(bob.id, market.id, 'YES', 35, beta.id)

    const trades = (await json(await get(`/markets/${market.id}/trades`))).data
      .trades
    expect(trades).toHaveLength(1)
    expect(trades[0].tradeId).toBe(trade.tradeId)
    expect(trades[0].answerId).toBe(beta.id)

    svc.resolveMarket(creator.id, market.id, beta.id)
    const events = (await json(await get('/feed'))).data.events
    const types = events.map((e: any) => e.type)
    expect(types).toEqual(
      expect.arrayContaining(['trade', 'market_created', 'resolved'])
    )
    const resolvedEvent = events.find((e: any) => e.type === 'resolved')
    expect(resolvedEvent.outcome).toBe(beta.id)
  })

  it('reputation: Brier treats each answer trade as a binary forecast, and MULTI payouts flow into realizedProfit', () => {
    const market = makeMulti()
    const [alpha, beta] = market.answers!
    const winBuy = svc.buy(bob.id, market.id, 'YES', 60, beta!.id) // right
    const loseBuy = svc.buy(bob.id, market.id, 'YES', 40, alpha!.id) // wrong
    svc.resolveMarket(creator.id, market.id, beta!.id)

    const stats = accountStats(db, bob.id)!
    const expectedBrier =
      (60 * (winBuy.probAfter - 1) ** 2 + 40 * loseBuy.probAfter ** 2) / 100
    expect(stats.brierScore).toBeCloseTo(expectedBrier, 5)

    // Profit is measured against the pool-net cost basis (99% of the stake);
    // the 1% fee is a separate transfer to the creator.
    const expectedProfit = winBuy.shares - 60 * 0.99 + (0 - 40 * 0.99)
    expect(stats.realizedProfit).toBeCloseTo(expectedProfit, 4)
    expect(stats.volume).toBeCloseTo(100, 6)
    expect(stats.marketsTraded).toBe(1)
    expect(stats.marketsResolvedTraded).toBe(1)
  })

  it('reputation: cancelled MULTI markets are excluded from Brier and profit-neutral', () => {
    const market = makeMulti()
    svc.buy(bob.id, market.id, 'YES', 50, market.answers![0]!.id)
    svc.buy(bob.id, market.id, 'NO', 20, market.answers![2]!.id)
    svc.resolveMarket(creator.id, market.id, 'CANCEL')

    const stats = accountStats(db, bob.id)!
    expect(stats.brierScore).toBeNull()
    expect(stats.realizedProfit).toBeCloseTo(0, 6)
  })
})
