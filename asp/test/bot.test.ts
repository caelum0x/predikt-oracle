// Trader bot tests. The strategy is covered as a pure function; the bot is
// exercised end-to-end against the REAL app (in-memory DB, deterministic AI
// completion) via an injected fetchFn that routes into app.request — no
// hand-written fake responses anywhere.
//
// The tool routes are rate limited per client IP. Bot tests that must not be
// throttled wrap fetch to tag requests with a unique X-Forwarded-For; the 429
// test deliberately uses a bare fetch (the bot itself never sets the header),
// so all of its tool calls share the single 'unknown' bucket.

import { describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { createApp } from '../src/app'
import { openDb } from '../src/engine/store'
import type { ChatCompletionFn } from '../src/ai/openrouter'
import { decideTrade, shouldTakeProfit } from '../src/bots/strategy'
import { TraderBot, type FetchLike } from '../src/bots/trader'

// ---- strategy: decideTrade -------------------------------------------------

describe('decideTrade', () => {
  const base = {
    marketProb: 0.5,
    estimatedProb: 0.9,
    confidence: 'high' as const,
    balance: 1000,
  }

  it('skips when the edge is below the minimum', () => {
    const decision = decideTrade({ ...base, estimatedProb: 0.54 })
    expect(decision.action).toBe('skip')
    if (decision.action === 'skip') expect(decision.reason).toContain('edge')
  })

  it('trades at exactly the minimum edge', () => {
    const decision = decideTrade({ ...base, estimatedProb: 0.55 })
    expect(decision).toEqual({
      action: 'buy',
      side: 'YES',
      // 1000 * 0.05 * 1 * (0.05 / 0.25) = 10
      amount: 10,
      edge: expect.closeTo(0.05, 10),
    })
  })

  it('skips when the balance is below 1, even with a huge edge', () => {
    const decision = decideTrade({ ...base, balance: 0.5 })
    expect(decision.action).toBe('skip')
    if (decision.action === 'skip') expect(decision.reason).toContain('balance')
  })

  it('buys NO when the estimate is below the market, with a negative edge', () => {
    const decision = decideTrade({ ...base, estimatedProb: 0.1 })
    expect(decision).toEqual({
      action: 'buy',
      side: 'NO',
      amount: 50,
      edge: expect.closeTo(-0.4, 10),
    })
  })

  it('scales the stake by confidence: low 0.25x, medium 0.5x, high 1x', () => {
    const at = (confidence: 'low' | 'medium' | 'high') =>
      decideTrade({ ...base, estimatedProb: 0.75, confidence })
    // Full edge saturation (0.25), so stake = 1000 * 0.05 * weight.
    expect(at('low')).toMatchObject({ action: 'buy', amount: 12.5 })
    expect(at('medium')).toMatchObject({ action: 'buy', amount: 25 })
    expect(at('high')).toMatchObject({ action: 'buy', amount: 50 })
  })

  it('saturates the edge at 0.25 — a bigger edge does not raise the stake', () => {
    const atEdge25 = decideTrade({ ...base, estimatedProb: 0.75 })
    const atEdge45 = decideTrade({ ...base, estimatedProb: 0.95 })
    expect(atEdge25).toMatchObject({ action: 'buy', amount: 50 })
    expect(atEdge45).toMatchObject({ action: 'buy', amount: 50 })
  })

  it('skips when the computed stake lands below 1', () => {
    // 30 * 0.05 * 0.25 * (0.06 / 0.25) = 0.09 -> below the 1-credit floor.
    const decision = decideTrade({
      marketProb: 0.5,
      estimatedProb: 0.56,
      confidence: 'low',
      balance: 30,
    })
    expect(decision.action).toBe('skip')
    if (decision.action === 'skip') expect(decision.reason).toContain('stake')
  })

  it('honors custom minEdge and maxStakeFraction', () => {
    const tightEdge = decideTrade({
      ...base,
      estimatedProb: 0.52,
      minEdge: 0.01,
    })
    // 1000 * 0.05 * 1 * (0.02 / 0.25) = 4
    expect(tightEdge).toMatchObject({ action: 'buy', side: 'YES', amount: 4 })

    const bigStake = decideTrade({
      ...base,
      estimatedProb: 0.75,
      maxStakeFraction: 0.1,
    })
    expect(bigStake).toMatchObject({ action: 'buy', amount: 100 })
  })

  it('rounds the stake to 2 decimal places', () => {
    const decision = decideTrade({ ...base, balance: 333 })
    // 333 * 0.05 = 16.65 at full saturation and high confidence.
    expect(decision).toMatchObject({ action: 'buy', amount: 16.65 })
  })
})

// ---- strategy: shouldTakeProfit ---------------------------------------------

describe('shouldTakeProfit', () => {
  const position = (yes: number, no: number, invested: number) => ({
    yesShares: yes,
    noShares: no,
    invested,
  })

  it('sells half the YES side at exactly +30% vs average cost', () => {
    // avg cost 50/100 = 0.5; value 0.65 = +30%.
    const decision = shouldTakeProfit({
      position: position(100, 0, 50),
      marketProb: 0.65,
    })
    expect(decision).toEqual({ action: 'sell', side: 'YES', shares: 50 })
  })

  it('returns null just below the +30% threshold', () => {
    const decision = shouldTakeProfit({
      position: position(100, 0, 50),
      marketProb: 0.64,
    })
    expect(decision).toBeNull()
  })

  it('values the NO side at 1 - marketProb', () => {
    // avg cost 0.5; NO value 1 - 0.3 = 0.7 = +40%.
    const decision = shouldTakeProfit({
      position: position(0, 100, 50),
      marketProb: 0.3,
    })
    expect(decision).toEqual({ action: 'sell', side: 'NO', shares: 50 })
  })

  it('returns null for an empty position', () => {
    expect(
      shouldTakeProfit({ position: position(0, 0, 0), marketProb: 0.9 })
    ).toBeNull()
  })

  it('rounds the half-position to 6 decimal places', () => {
    // avg cost 0.1/1.234567 ~= 0.081; value 0.9 is far above +30%.
    const decision = shouldTakeProfit({
      position: position(1.234567, 0, 0.1),
      marketProb: 0.9,
    })
    expect(decision).toEqual({
      action: 'sell',
      side: 'YES',
      shares: 0.617284, // round6(0.6172835)
    })
  })

  it('treats a fully-recouped (zero cost) position as pure profit', () => {
    const decision = shouldTakeProfit({
      position: position(10, 0, 0),
      marketProb: 0.2,
    })
    expect(decision).toEqual({ action: 'sell', side: 'YES', shares: 5 })
  })

  it('checks the YES side before the NO side', () => {
    // Both sides held at a tiny cost basis; YES wins the tie.
    const decision = shouldTakeProfit({
      position: position(10, 10, 2),
      marketProb: 0.5,
    })
    expect(decision).toEqual({ action: 'sell', side: 'YES', shares: 5 })
  })
})

// ---- TraderBot end-to-end against the real app ------------------------------

const BASE_URL = 'http://predikt.test'
const FUTURE_MS = Date.now() + 90 * 24 * 60 * 60 * 1000

type OddsFake = { probability: number; confidence: 'low' | 'medium' | 'high' }

// Deterministic AI: always returns the same valid odds estimate.
function makeComplete(odds: OddsFake): ChatCompletionFn {
  return async () =>
    JSON.stringify({
      probability: odds.probability,
      confidence: odds.confidence,
      rationale: 'Deterministic test forecast, fixed for repeatability.',
      baseRate: 'Fixed test base rate.',
      keyDrivers: ['test driver'],
      updateTriggers: [],
      citations: [],
    })
}

// Route bot fetches into the in-process app — the real ASP handles them.
function appFetch(app: Hono): FetchLike {
  return (url, init) =>
    Promise.resolve(app.request(url.replace(BASE_URL, ''), init))
}

// Same, but tags requests with a fixed client IP so the per-IP rate limiter
// (module-level, shared across tests) never throttles this test's traffic.
let ipCounter = 0
function isolatedFetch(app: Hono): FetchLike {
  ipCounter += 1
  const ip = `203.0.113.${ipCounter}`
  return (url, init) => {
    const headers = new Headers(init?.headers)
    headers.set('X-Forwarded-For', ip)
    return Promise.resolve(
      app.request(url.replace(BASE_URL, ''), { ...init, headers })
    )
  }
}

async function json(res: Response): Promise<any> {
  expect(res.ok).toBe(true)
  const body = await res.json()
  expect(body.success).toBe(true)
  return body.data
}

async function createAccount(app: Hono, name: string) {
  const res = await app.request('/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  expect(res.status).toBe(201)
  const body = await res.json()
  return body.data as { account: { id: string }; apiKey: string }
}

async function createMarket(
  app: Hono,
  apiKey: string,
  question: string,
  initialProb = 0.5
) {
  const res = await app.request('/markets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      question,
      criteria: 'Resolves YES if the referenced event verifiably happens.',
      closeTime: FUTURE_MS,
      initialProb,
    }),
  })
  expect(res.status).toBe(201)
  const body = await res.json()
  return body.data.market as { id: string; probability: number }
}

async function setup(odds: OddsFake) {
  const app = createApp({ db: openDb(':memory:'), complete: makeComplete(odds) })
  const creator = await createAccount(app, 'Market Creator')
  const bot = await createAccount(app, 'Trader Bot')
  return { app, creator, bot }
}

describe('TraderBot.runOnce', () => {
  it('buys YES on an underpriced market and moves the price up', async () => {
    const { app, creator, bot } = await setup({
      probability: 0.9,
      confidence: 'high',
    })
    const market = await createMarket(
      app,
      creator.apiKey,
      'Will the deterministic test event happen by 2027?'
    )
    expect(market.probability).toBeCloseTo(0.5, 6)

    const trader = new TraderBot({
      baseUrl: BASE_URL,
      apiKey: bot.apiKey,
      fetchFn: isolatedFetch(app),
      log: () => {},
    })
    const report = await trader.runOnce()

    expect(report.considered).toBe(1)
    expect(report.errors).toEqual([])
    expect(report.skipped).toEqual([])
    expect(report.traded).toHaveLength(1)
    expect(report.traded[0]).toEqual({
      marketId: market.id,
      side: 'YES',
      // 1000 * 0.05 * 1 * min(1, 0.4 / 0.25) = 50
      amount: 50,
      edge: expect.closeTo(0.4, 10),
    })

    // The trade hit the real engine: price up, balance down, shares held.
    const after = await json(await app.request(`/markets/${market.id}`))
    expect(after.market.probability).toBeGreaterThan(0.5)

    const me = await json(
      await app.request('/accounts/me', {
        headers: { Authorization: `Bearer ${bot.apiKey}` },
      })
    )
    expect(me.account.balance).toBeCloseTo(950, 6)
    expect(me.positions).toHaveLength(1)
    expect(me.positions[0].yesShares).toBeGreaterThan(0)
  })

  it('buys NO when the market is overpriced', async () => {
    const { app, creator, bot } = await setup({
      probability: 0.1,
      confidence: 'high',
    })
    const market = await createMarket(
      app,
      creator.apiKey,
      'Will the overpriced test event happen by 2027?'
    )

    const trader = new TraderBot({
      baseUrl: BASE_URL,
      apiKey: bot.apiKey,
      fetchFn: isolatedFetch(app),
      log: () => {},
    })
    const report = await trader.runOnce()

    expect(report.traded).toEqual([
      {
        marketId: market.id,
        side: 'NO',
        amount: 50,
        edge: expect.closeTo(-0.4, 10),
      },
    ])
    const after = await json(await app.request(`/markets/${market.id}`))
    expect(after.market.probability).toBeLessThan(0.5)
  })

  it('skips fairly-priced markets with a reason', async () => {
    const { app, creator, bot } = await setup({
      probability: 0.52,
      confidence: 'high',
    })
    const market = await createMarket(
      app,
      creator.apiKey,
      'Will the fairly priced test event happen by 2027?'
    )

    const trader = new TraderBot({
      baseUrl: BASE_URL,
      apiKey: bot.apiKey,
      fetchFn: isolatedFetch(app),
      log: () => {},
    })
    const report = await trader.runOnce()

    expect(report).toEqual({
      considered: 1,
      traded: [],
      skipped: [{ marketId: market.id, reason: expect.stringContaining('edge') }],
      errors: [],
    })
  })

  it('trades multiple markets in one cycle, sizing against the running balance', async () => {
    const { app, creator, bot } = await setup({
      probability: 0.9,
      confidence: 'high',
    })
    await createMarket(app, creator.apiKey, 'Multi-market test question A?')
    await createMarket(app, creator.apiKey, 'Multi-market test question B?')

    const trader = new TraderBot({
      baseUrl: BASE_URL,
      apiKey: bot.apiKey,
      fetchFn: isolatedFetch(app),
      log: () => {},
    })
    const report = await trader.runOnce()

    expect(report.considered).toBe(2)
    expect(report.traded).toHaveLength(2)
    // First trade stakes 5% of 1000 = 50; the second 5% of 950 = 47.5.
    const amounts = report.traded.map((t) => t.amount).sort((a, b) => a - b)
    expect(amounts).toEqual([47.5, 50])
    expect(report.errors).toEqual([])
  })

  it('reports an authentication failure without throwing', async () => {
    const { app, creator } = await setup({ probability: 0.9, confidence: 'high' })
    await createMarket(app, creator.apiKey, 'Auth failure test question?')

    const trader = new TraderBot({
      baseUrl: BASE_URL,
      apiKey: 'pk_not_a_real_key',
      fetchFn: isolatedFetch(app),
      log: () => {},
    })
    const report = await trader.runOnce()

    expect(report.considered).toBe(0)
    expect(report.traded).toEqual([])
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]!.error).toContain('balance')
  })

  it('stops the cycle on a 429 from estimate-odds and reports it', async () => {
    const { app, creator, bot } = await setup({
      probability: 0.9,
      confidence: 'high',
    })
    const first = await createMarket(app, creator.apiKey, 'Rate limit test A?')
    await createMarket(app, creator.apiKey, 'Rate limit test B?')

    // Exhaust the estimate-odds bucket for the 'unknown' client: these
    // requests carry no X-Forwarded-For, exactly like the bot's own calls.
    let sawTooMany = false
    for (let i = 0; i < 15 && !sawTooMany; i += 1) {
      const res = await app.request('/tools/estimate-odds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'Warm-up rate limit question?' }),
      })
      sawTooMany = res.status === 429
    }
    expect(sawTooMany).toBe(true)

    const trader = new TraderBot({
      baseUrl: BASE_URL,
      apiKey: bot.apiKey,
      fetchFn: appFetch(app), // bare fetch: bot sets no X-Forwarded-For
      log: () => {},
    })
    const report = await trader.runOnce()

    // Two open markets, but the cycle stops at the first 429.
    expect(report.considered).toBe(1)
    expect(report.traded).toEqual([])
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]).toEqual({
      marketId: expect.any(String),
      error: expect.stringContaining('429'),
    })
    // No trade went through on either market.
    const after = await json(await app.request(`/markets/${first.id}`))
    expect(after.market.probability).toBeCloseTo(0.5, 6)
  })
})

describe('TraderBot.runForever', () => {
  it('loops runOnce on the interval and halts after stop()', async () => {
    const { app, creator, bot } = await setup({
      probability: 0.9,
      confidence: 'high',
    })
    await createMarket(app, creator.apiKey, 'Run-forever loop test question?')

    const logs: string[] = []
    const trader = new TraderBot({
      baseUrl: BASE_URL,
      apiKey: bot.apiKey,
      fetchFn: isolatedFetch(app),
      log: (...args) => logs.push(args.map(String).join(' ')),
    })

    trader.runForever({ intervalMs: 10 })
    await waitFor(() => logs.length >= 2, 3000)
    trader.stop()

    const settled = logs.length
    await sleep(60)
    expect(logs.length).toBe(settled) // no cycles after stop()

    // Every log line is a valid JSON cycle report.
    const first = JSON.parse(logs[0]!)
    expect(first).toMatchObject({
      considered: 1,
      traded: expect.any(Array),
      skipped: expect.any(Array),
      errors: [],
    })
  })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await sleep(5)
  }
}
