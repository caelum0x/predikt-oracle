// Route tests. The AI completion function is injected as a fake, so nothing
// here touches the network. Each request uses a unique X-Forwarded-For so the
// per-IP rate limiter never interferes across tests.

import { describe, expect, it } from 'vitest'
import { createApp as createAppBase, type AppOptions } from '../src/app'
import { openDb } from '../src/engine/store'

// trustProxyHeader emulates a deployment behind a trusted proxy so each
// test's unique X-Forwarded-For keeps rate-limit buckets isolated.
const createApp = (options: AppOptions = {}) =>
  createAppBase({ db: openDb(':memory:'), trustProxyHeader: true, ...options })
import { OpenRouterError, type ChatCompletionFn } from '../src/ai/openrouter'

let ipCounter = 0

function post(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  ip?: string
) {
  ipCounter += 1
  return app.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip ?? `10.0.0.${ipCounter}`,
    },
    body: JSON.stringify(body),
  })
}

const FUTURE_MS = Date.now() + 90 * 24 * 60 * 60 * 1000

const draftJson = JSON.stringify({
  drafts: [
    {
      question: 'Will BTC close above $150k on Dec 31, 2026?',
      description: 'Daily close.',
      outcomeType: 'BINARY',
      closeTime: FUTURE_MS,
      category: 'Crypto',
      topicSlug: 'crypto',
      resolutionCriteria: 'Resolves YES on a CoinGecko daily close > $150,000.',
    },
    { question: 'malformed', outcomeType: 'BINARY' }, // dropped by validation
  ],
})

const oddsJson = JSON.stringify({
  probability: 0.62,
  confidence: 'medium',
  rationale: 'Base rate adjusted for current Fed guidance.',
  baseRate: 'Cuts followed 70% of comparable pauses.',
  keyDrivers: ['Inflation prints'],
  updateTriggers: ['Next FOMC'],
  citations: [],
})

const resolutionJson = JSON.stringify({
  verdict: 'YES',
  confidence: 0.9,
  rationale: 'Source [1] confirms the event occurred before the deadline.',
  citations: ['[1]'],
})

const fake =
  (response: string): ChatCompletionFn =>
  async () =>
    response

describe('GET / and /health', () => {
  it('serves the manifest with all three tools', async () => {
    const app = createApp({ complete: fake('{}') })
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.tools.map((t: { name: string }) => t.name)).toEqual([
      'draft-market',
      'estimate-odds',
      'suggest-resolution',
    ])
  })

  it('reports healthy', async () => {
    const app = createApp({ complete: fake('{}') })
    const res = await app.request('/health')
    expect(res.status).toBe(200)
  })
})

describe('POST /tools/draft-market', () => {
  it('returns validated drafts and drops malformed ones', async () => {
    const app = createApp({ complete: fake(draftJson) })
    const res = await post(app, '/tools/draft-market', { topic: 'bitcoin' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.drafts).toHaveLength(1)
    expect(body.data.drafts[0].outcomeType).toBe('BINARY')
  })

  it('rejects a request without any source', async () => {
    const app = createApp({ complete: fake(draftJson) })
    const res = await post(app, '/tools/draft-market', {})
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.success).toBe(false)
  })

  it('returns 502 when every draft is malformed', async () => {
    const app = createApp({
      complete: fake(JSON.stringify({ drafts: [{ question: 'bad' }] })),
    })
    const res = await post(app, '/tools/draft-market', { topic: 'bitcoin' })
    expect(res.status).toBe(502)
  })

  it('maps upstream OpenRouter failures to 502 without leaking internals', async () => {
    const app = createApp({
      complete: async () => {
        throw new OpenRouterError('provider exploded: secret detail', 403)
      },
    })
    const res = await post(app, '/tools/draft-market', { topic: 'bitcoin' })
    expect(res.status).toBe(502)
  })
})

describe('POST /tools/estimate-odds', () => {
  it('returns a validated estimate', async () => {
    const app = createApp({ complete: fake(oddsJson) })
    const res = await post(app, '/tools/estimate-odds', {
      question: 'Will the Fed cut rates before October 2026?',
      deadline: '2026-10-01',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.estimate.probability).toBeCloseTo(0.62)
    expect(body.data.estimate.confidence).toBe('medium')
  })

  it('rejects a too-short question', async () => {
    const app = createApp({ complete: fake(oddsJson) })
    const res = await post(app, '/tools/estimate-odds', { question: 'Fed?' })
    expect(res.status).toBe(400)
  })

  it('returns 502 on an out-of-range probability', async () => {
    const bad = JSON.parse(oddsJson)
    const app = createApp({
      complete: fake(JSON.stringify({ ...bad, probability: 1.5 })),
    })
    const res = await post(app, '/tools/estimate-odds', {
      question: 'Will the Fed cut rates before October 2026?',
    })
    expect(res.status).toBe(502)
  })
})

describe('POST /tools/suggest-resolution', () => {
  it('returns a validated suggestion', async () => {
    const app = createApp({ complete: fake(resolutionJson) })
    const res = await post(app, '/tools/suggest-resolution', {
      question: 'Did team X win the final?',
      sources: ['Official result page: team X won 3-1.'],
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.suggestion.verdict).toBe('YES')
  })

  it('returns 502 on an invalid verdict', async () => {
    const app = createApp({
      complete: fake(
        JSON.stringify({ verdict: 'MAYBE', confidence: 0.5, rationale: 'x'.repeat(20) })
      ),
    })
    const res = await post(app, '/tools/suggest-resolution', {
      question: 'Did team X win the final?',
    })
    expect(res.status).toBe(502)
  })
})

describe('rate limiting', () => {
  it('returns 429 with Retry-After once a single IP exhausts its bucket', async () => {
    const app = createApp({ complete: fake(oddsJson) })
    const ip = '192.0.2.99'
    let last: Response | undefined
    for (let i = 0; i < 11; i++) {
      last = await post(
        app,
        '/tools/estimate-odds',
        { question: 'Will the Fed cut rates before October 2026?' },
        ip
      )
    }
    expect(last?.status).toBe(429)
    expect(last?.headers.get('Retry-After')).toBeTruthy()
  })
})
