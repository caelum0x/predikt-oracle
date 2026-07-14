// Auto-resolution pipeline: the sweeper closes overdue markets and stores
// validated AI suggestions (BINARY + MULTI, including answer-text matching and
// the unmatched -> UNCLEAR path), tracks failures with a retry cap, and the
// routes apply decisive suggestions under a confidence gate. The completion
// function is injected and deterministic — no network.

import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../src/engine/store'
import { MarketService, type Account } from '../src/engine/service'
import type { ChatCompletionFn } from '../src/ai/openrouter'
import {
  getAttemptCount,
  getSuggestion,
  MAX_ATTEMPTS,
  ResolutionSweeper,
} from '../src/resolution/sweeper'
import { createResolutionRoutes } from '../src/routes/resolution'

let db: Db
let svc: MarketService
let alice: Account
let aliceKey: string
let bob: Account
let bobKey: string

const FUTURE = () => Date.now() + 7 * 24 * 60 * 60 * 1000

beforeEach(() => {
  db = openDb(':memory:')
  svc = new MarketService(db)
  const a = svc.createAccount('alice-agent')
  alice = a.account
  aliceKey = a.apiKey
  const b = svc.createAccount('bob-agent')
  bob = b.account
  bobKey = b.apiKey
})

function makeMarket(overrides: Record<string, unknown> = {}) {
  return svc.createMarket(alice.id, {
    question: 'Will BTC close above $150k on Dec 31, 2026?',
    criteria: 'Resolves YES on a CoinGecko daily close above $150,000.',
    closeTime: FUTURE(),
    subsidy: 100,
    ...overrides,
  })
}

// Backdate a market's close time so the sweeper treats it as overdue.
function overdue(marketId: string): void {
  db.prepare('UPDATE markets SET close_time = ? WHERE id = ?').run(
    Date.now() - 60_000,
    marketId
  )
}

// A completion fn that answers based on the market question in the prompt.
function responder(fn: (userText: string) => string): ChatCompletionFn {
  return async ({ messages }) => {
    const user = messages.find((m) => m.role === 'user')?.content ?? ''
    return fn(user)
  }
}

const YES_HIGH = JSON.stringify({
  verdict: 'YES',
  confidence: 0.92,
  rationale: 'The close was above the threshold on the resolution date.',
  citations: ['coingecko.com'],
})

const NO_LOW = JSON.stringify({
  verdict: 'NO',
  confidence: 0.4,
  rationale: 'Evidence is thin and mixed.',
  citations: [],
})

function sweeper(complete: ChatCompletionFn): ResolutionSweeper {
  return new ResolutionSweeper({ db, service: svc, complete })
}

describe('ResolutionSweeper.tick', () => {
  it('closes overdue OPEN markets and stores a validated BINARY suggestion', async () => {
    const market = makeMarket()
    overdue(market.id)

    const result = await sweeper(responder(() => YES_HIGH)).tick()
    expect(result.closed).toBe(1)
    expect(result.suggested).toBe(1)
    expect(svc.getMarket(market.id).status).toBe('CLOSED')

    const stored = getSuggestion(db, market.id)!
    expect(stored.verdict).toBe('YES')
    expect(stored.confidence).toBeCloseTo(0.92, 6)
    expect(stored.answerId).toBeNull()
    expect(stored.citations).toEqual(['coingecko.com'])
  })

  it('matches a MULTI ANSWER verdict to an answer id by text', async () => {
    const market = makeMarket({
      question: 'Which team wins the final?',
      outcomeType: 'MULTI',
      answers: ['Red Team', 'Blue Team', 'Draw'],
    })
    overdue(market.id)
    const winner = market.answers!.find((a) => a.text === 'Blue Team')!

    await sweeper(
      responder(() =>
        JSON.stringify({
          verdict: 'ANSWER',
          answer: 'blue team', // case-insensitive match
          confidence: 0.81,
          rationale: 'Blue Team won 3-1.',
          citations: [],
        })
      )
    ).tick()

    const stored = getSuggestion(db, market.id)!
    expect(stored.verdict).toBe('ANSWER')
    expect(stored.answerId).toBe(winner.id)
  })

  it('maps an unmatched MULTI answer to UNCLEAR with a note', async () => {
    const market = makeMarket({
      question: 'Which team wins the final?',
      outcomeType: 'MULTI',
      answers: ['Red Team', 'Blue Team'],
    })
    overdue(market.id)

    await sweeper(
      responder(() =>
        JSON.stringify({
          verdict: 'ANSWER',
          answer: 'Green Team', // no such answer
          confidence: 0.7,
          rationale: 'Ambiguous source.',
          citations: [],
        })
      )
    ).tick()

    const stored = getSuggestion(db, market.id)!
    expect(stored.verdict).toBe('UNCLEAR')
    expect(stored.answerId).toBeNull()
    expect(stored.rationale).toContain('did not match')
  })

  it('does not touch markets that are not yet overdue', async () => {
    const market = makeMarket() // closes in the future
    const result = await sweeper(responder(() => YES_HIGH)).tick()
    expect(result.closed).toBe(0)
    expect(result.suggested).toBe(0)
    expect(getSuggestion(db, market.id)).toBeNull()
    expect(svc.getMarket(market.id).status).toBe('OPEN')
  })

  it('retries on malformed AI output and stops after MAX_ATTEMPTS', async () => {
    const market = makeMarket()
    overdue(market.id)
    const bad = sweeper(responder(() => 'not json at all'))

    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      const result = await bad.tick()
      expect(result.failed).toBe(1)
      expect(getAttemptCount(db, market.id)).toBe(i)
      expect(getSuggestion(db, market.id)).toBeNull()
    }
    // Cap reached: the market is no longer a candidate.
    const afterCap = await bad.tick()
    expect(afterCap.failed).toBe(0)
    expect(afterCap.suggested).toBe(0)
  })

  it('guards against overlapping ticks (no duplicate AI calls)', async () => {
    const market = makeMarket()
    overdue(market.id)

    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // A slow AI call: it blocks until we release the gate, letting a second
    // tick start while the first is still in flight.
    const complete: ChatCompletionFn = async () => {
      calls += 1
      await gate
      return YES_HIGH
    }

    const s = sweeper(complete)
    const first = s.tick() // begins, running = true, then awaits the AI call
    const second = await s.tick() // must short-circuit on the running guard

    expect(second).toEqual({ closed: 0, suggested: 0, failed: 0 })
    expect(calls).toBe(1) // the overlapping tick did NOT issue a second AI call

    release()
    const firstResult = await first
    expect(firstResult.suggested).toBe(1)
    expect(calls).toBe(1)
    expect(getSuggestion(db, market.id)!.verdict).toBe('YES')
  })

  it('is idempotent: a second tick re-suggests nothing', async () => {
    const market = makeMarket()
    overdue(market.id)
    const s = sweeper(responder(() => YES_HIGH))
    await s.tick()
    const second = await s.tick()
    expect(second.suggested).toBe(0)
    expect(second.closed).toBe(0)
    expect(getSuggestion(db, market.id)!.verdict).toBe('YES')
  })
})

describe('resolution routes', () => {
  type Api = Hono
  let api: Api

  beforeEach(() => {
    api = new Hono()
    api.route('/', createResolutionRoutes({ service: svc, db }))
  })

  function req(
    path: string,
    options: { method?: string; body?: unknown; key?: string } = {}
  ) {
    return api.request(path, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: {
        'Content-Type': 'application/json',
        ...(options.key ? { Authorization: `Bearer ${options.key}` } : {}),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    })
  }

  async function json(res: Response) {
    return (await res.json()) as { success: boolean; data?: any; error?: string }
  }

  async function sweepWith(complete: ChatCompletionFn, marketId: string) {
    overdue(marketId)
    await sweeper(complete).tick()
  }

  it('404s the suggestion endpoint until a suggestion exists', async () => {
    const market = makeMarket()
    expect((await req(`/markets/${market.id}/resolution-suggestion`)).status).toBe(404)
    expect((await req('/markets/mkt_missing/resolution-suggestion')).status).toBe(404)

    await sweepWith(responder(() => YES_HIGH), market.id)
    const res = await req(`/markets/${market.id}/resolution-suggestion`)
    expect(res.status).toBe(200)
    expect((await json(res)).data.suggestion.verdict).toBe('YES')
  })

  it('applies a confident suggestion and pays out the winner', async () => {
    const market = makeMarket()
    const trade = svc.buy(bob.id, market.id, 'YES', 50)
    await sweepWith(responder(() => YES_HIGH), market.id)

    const res = await req(`/markets/${market.id}/resolve-suggested`, {
      key: aliceKey,
      body: {},
    })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.data.market.status).toBe('RESOLVED')
    expect(body.data.market.outcome).toBe('YES')

    // Bob's YES shares each pay 1 credit.
    expect(svc.getAccount(bob.id).balance).toBeCloseTo(1000 - 50 + trade.shares, 4)
  })

  it('rejects a low-confidence suggestion with 409 unless forced', async () => {
    const market = makeMarket()
    await sweepWith(responder(() => NO_LOW), market.id)

    const gated = await req(`/markets/${market.id}/resolve-suggested`, {
      key: aliceKey,
      body: {},
    })
    expect(gated.status).toBe(409)
    const gatedBody = await json(gated)
    expect(gatedBody.data.suggestion.confidence).toBeCloseTo(0.4, 6)
    expect(svc.getMarket(market.id).status).toBe('CLOSED') // not resolved

    const forced = await req(`/markets/${market.id}/resolve-suggested`, {
      key: aliceKey,
      body: { force: true },
    })
    expect(forced.status).toBe(200)
    expect((await json(forced)).data.market.outcome).toBe('NO')
  })

  it('honors force even when the body is sent without a JSON content-type', async () => {
    const market = makeMarket()
    await sweepWith(responder(() => NO_LOW), market.id) // confidence 0.4, below gate

    // A client sends { force: true } but omits Content-Type: application/json.
    // The previous `c.req.json().catch(() => ({}))` swallowed this into {},
    // silently ignoring force and returning 409. It must now be honored.
    const res = await api.request(`/markets/${market.id}/resolve-suggested`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Authorization: `Bearer ${aliceKey}`,
      },
      body: JSON.stringify({ force: true }),
    })
    expect(res.status).toBe(200)
    expect((await json(res)).data.market.outcome).toBe('NO')
  })

  it('rejects a genuinely malformed body with 400', async () => {
    const market = makeMarket()
    await sweepWith(responder(() => YES_HIGH), market.id)

    const res = await api.request(`/markets/${market.id}/resolve-suggested`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceKey}` },
      body: '{ not json',
    })
    expect(res.status).toBe(400)
    expect(svc.getMarket(market.id).status).toBe('CLOSED') // not resolved
  })

  it('never auto-applies an UNCLEAR suggestion, even forced', async () => {
    const market = makeMarket()
    await sweepWith(
      responder(() =>
        JSON.stringify({
          verdict: 'UNCLEAR',
          confidence: 0.99,
          rationale: 'Cannot determine from available evidence.',
          citations: [],
        })
      ),
      market.id
    )

    for (const body of [{}, { force: true }]) {
      const res = await req(`/markets/${market.id}/resolve-suggested`, {
        key: aliceKey,
        body,
      })
      expect(res.status).toBe(409)
    }
    expect(svc.getMarket(market.id).status).toBe('CLOSED')
  })

  it('only the creator can apply, and auth is required', async () => {
    const market = makeMarket()
    await sweepWith(responder(() => YES_HIGH), market.id)

    expect(
      (await req(`/markets/${market.id}/resolve-suggested`, { body: {} })).status
    ).toBe(401)
    const foreign = await req(`/markets/${market.id}/resolve-suggested`, {
      key: bobKey,
      body: {},
    })
    expect(foreign.status).toBe(403)
    expect(svc.getMarket(market.id).status).toBe('CLOSED')
  })
})
