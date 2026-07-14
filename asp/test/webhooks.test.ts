// Webhook subscriptions with signed, retried deliveries: trigger-based event
// capture (driven through real MarketService lifecycles), dispatcher fan-out
// with HMAC signatures, retry/backoff via the persisted next-attempt clock,
// auto-deactivation after consecutive failures, per-subscription event
// filtering, and the HTTP subscription API (auth, ownership, max-5 limit).

import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../src/engine/store'
import { MarketService, type Account } from '../src/engine/service'
import {
  createWebhook,
  EVENT_TYPES,
  initEventsSchema,
  type EventRow,
  type EventType,
  type WebhookRow,
} from '../src/webhooks/events'
import {
  DEACTIVATE_AFTER_CONSECUTIVE_FAILURES,
  WebhookDispatcher,
  type FetchLike,
} from '../src/webhooks/dispatcher'
import { createWebhookRoutes } from '../src/routes/webhooks'

const FUTURE = () => Date.now() + 7 * 24 * 60 * 60 * 1000

let db: Db
let svc: MarketService
let alice: Account
let aliceKey: string
let bob: Account
let bobKey: string

beforeEach(() => {
  db = openDb(':memory:')
  initEventsSchema(db)
  initEventsSchema(db) // idempotent: re-running must be a no-op
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

function eventsOf(type: EventType): (EventRow & { parsed: any })[] {
  const rows = db
    .prepare('SELECT * FROM events WHERE type = ? ORDER BY id ASC')
    .all(type) as EventRow[]
  return rows.map((row) => ({ ...row, parsed: JSON.parse(row.payload) }))
}

function webhookRow(id: string): WebhookRow {
  return db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookRow
}

type RecordedCall = { url: string; headers: Record<string, string>; body: string }

// A fetch recorder whose response behavior can be swapped mid-test.
function makeRecorder(initial: { ok: boolean; status: number } = { ok: true, status: 200 }) {
  const calls: RecordedCall[] = []
  const state = { response: initial, throwError: null as string | null }
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body })
    if (state.throwError) throw new Error(state.throwError)
    return state.response
  }
  return { calls, state, fetchFn }
}

function insertEvent(type: EventType, marketId: string, payload: unknown): void {
  db.prepare(
    'INSERT INTO events (type, market_id, payload, created_at) VALUES (?, ?, ?, ?)'
  ).run(type, marketId, JSON.stringify(payload), Date.now())
}

// ---- trigger capture ---------------------------------------------------------

describe('event capture via triggers', () => {
  it('captures market.created with question and outcomeType', () => {
    const market = makeMarket()
    const events = eventsOf('market.created')
    expect(events).toHaveLength(1)
    expect(events[0]!.market_id).toBe(market.id)
    expect(events[0]!.parsed).toEqual({
      marketId: market.id,
      question: market.question,
      outcomeType: 'BINARY',
    })
    expect(events[0]!.created_at).toBeGreaterThan(0)
  })

  it('captures trade.executed for buys and sells on a binary market', () => {
    const market = makeMarket()
    const buy = svc.buy(bob.id, market.id, 'YES', 50)
    svc.sell(bob.id, market.id, 'YES', 10)

    const events = eventsOf('trade.executed')
    expect(events).toHaveLength(2)
    const buyEvent = events[0]!.parsed
    expect(buyEvent.marketId).toBe(market.id)
    expect(buyEvent.tradeId).toBe(buy.tradeId)
    expect(buyEvent.kind).toBe('BUY')
    expect(buyEvent.side).toBe('YES')
    expect(buyEvent.amount).toBe(50)
    expect(buyEvent.probAfter).toBeCloseTo(buy.probAfter, 6)
    expect(buyEvent.answerId).toBeNull()
    expect(events[1]!.parsed.kind).toBe('SELL')
  })

  it('captures trade.executed with answerId on a MULTI market', () => {
    const market = makeMarket({
      outcomeType: 'MULTI',
      answers: ['Alpha', 'Beta', 'Gamma'],
    })
    const answerId = market.answers![0]!.id
    svc.buy(bob.id, market.id, 'YES', 25, answerId)

    const events = eventsOf('trade.executed')
    expect(events).toHaveLength(1)
    expect(events[0]!.parsed.answerId).toBe(answerId)
    expect(eventsOf('market.created')[0]!.parsed.outcomeType).toBe('MULTI')
  })

  it('captures market.resolved only when the market resolves', () => {
    const market = makeMarket()
    svc.closeMarket(alice.id, market.id) // CLOSED must NOT emit market.resolved
    expect(eventsOf('market.resolved')).toHaveLength(0)

    svc.resolveMarket(alice.id, market.id, 'YES')
    const events = eventsOf('market.resolved')
    expect(events).toHaveLength(1)
    expect(events[0]!.parsed).toEqual({ marketId: market.id, outcome: 'YES' })
  })

  it('records the winning answer id when a MULTI market resolves', () => {
    const market = makeMarket({ outcomeType: 'MULTI', answers: ['A1', 'A2'] })
    const winner = market.answers![1]!.id
    svc.resolveMarket(alice.id, market.id, winner)
    expect(eventsOf('market.resolved')[0]!.parsed.outcome).toBe(winner)
  })
})

// ---- dispatcher deliveries -----------------------------------------------------

describe('dispatcher tick delivery', () => {
  it('POSTs each matching event once with a valid HMAC signature', async () => {
    const { webhook, secret } = createWebhook(db, bob.id, {
      url: 'https://agent.example/hook',
      events: [...EVENT_TYPES],
    })
    const market = makeMarket()
    const buy = svc.buy(bob.id, market.id, 'NO', 40)

    const recorder = makeRecorder()
    const dispatcher = new WebhookDispatcher({ db, fetchFn: recorder.fetchFn })
    const stats = await dispatcher.tick()

    // market.created + trade.executed
    expect(stats.enqueued).toBe(2)
    expect(stats.delivered).toBe(2)
    expect(recorder.calls).toHaveLength(2)

    const call = recorder.calls[1]!
    expect(call.url).toBe('https://agent.example/hook')
    expect(call.headers['Content-Type']).toBe('application/json')
    expect(call.headers['X-Predikt-Event']).toBe('trade.executed')
    const expectedSig = createHmac('sha256', secret).update(call.body).digest('hex')
    expect(call.headers['X-Predikt-Signature']).toBe(expectedSig)

    const parsed = JSON.parse(call.body)
    expect(parsed).toMatchObject({
      type: 'trade.executed',
      marketId: market.id,
      payload: { tradeId: buy.tradeId, kind: 'BUY', side: 'NO', amount: 40 },
    })
    expect(typeof parsed.id).toBe('number')
    expect(typeof parsed.createdAt).toBe('number')

    // The high-water mark advanced: a second tick delivers nothing new.
    const again = await dispatcher.tick()
    expect(again.enqueued).toBe(0)
    expect(recorder.calls).toHaveLength(2)
    expect(webhookRow(webhook.id).failure_count).toBe(0)
  })

  it('filters events per subscription', async () => {
    createWebhook(db, bob.id, {
      url: 'https://resolved-only.example/hook',
      events: ['market.resolved'],
    })
    createWebhook(db, bob.id, {
      url: 'https://everything.example/hook',
      events: [...EVENT_TYPES],
    })

    const market = makeMarket()
    svc.buy(bob.id, market.id, 'YES', 20)
    svc.resolveMarket(alice.id, market.id, 'NO')

    const recorder = makeRecorder()
    await new WebhookDispatcher({ db, fetchFn: recorder.fetchFn }).tick()

    const resolvedOnly = recorder.calls.filter((c) =>
      c.url.startsWith('https://resolved-only')
    )
    const everything = recorder.calls.filter((c) =>
      c.url.startsWith('https://everything')
    )
    expect(resolvedOnly).toHaveLength(1)
    expect(resolvedOnly[0]!.headers['X-Predikt-Event']).toBe('market.resolved')
    expect(everything.map((c) => c.headers['X-Predikt-Event'])).toEqual([
      'market.created',
      'trade.executed',
      'market.resolved',
    ])
  })

  it('retries with exponential backoff, then succeeds', async () => {
    const { webhook } = createWebhook(db, bob.id, {
      url: 'https://flaky.example/hook',
      events: ['trade.executed'],
    })
    insertEvent('trade.executed', 'mkt_x', { marketId: 'mkt_x' })

    const recorder = makeRecorder({ ok: false, status: 500 })
    const dispatcher = new WebhookDispatcher({
      db,
      fetchFn: recorder.fetchFn,
      maxAttempts: 5,
    })
    const now = 1_000_000

    // Attempt 1 fails -> retry scheduled at now + 1s.
    let stats = await dispatcher.tick(now)
    expect(stats).toMatchObject({ enqueued: 1, delivered: 0, retried: 1 })
    expect(recorder.calls).toHaveLength(1)
    expect(webhookRow(webhook.id).failure_count).toBe(1)

    // Not due yet: same clock and just-before-backoff make no attempt.
    await dispatcher.tick(now)
    await dispatcher.tick(now + 999)
    expect(recorder.calls).toHaveLength(1)

    // Attempt 2 at +1s fails -> next retry at +1s+2s.
    await dispatcher.tick(now + 1000)
    expect(recorder.calls).toHaveLength(2)
    await dispatcher.tick(now + 2999)
    expect(recorder.calls).toHaveLength(2)

    // Endpoint recovers: attempt 3 at +3s succeeds and resets failure_count.
    recorder.state.response = { ok: true, status: 200 }
    stats = await dispatcher.tick(now + 3000)
    expect(stats.delivered).toBe(1)
    expect(recorder.calls).toHaveLength(3)

    const delivery = db
      .prepare('SELECT * FROM deliveries WHERE webhook_id = ?')
      .get(webhook.id) as {
      status: string
      attempts: number
      last_error: string | null
      delivered_at: number | null
    }
    expect(delivery.status).toBe('ok')
    expect(delivery.attempts).toBe(3)
    expect(delivery.last_error).toBeNull()
    expect(delivery.delivered_at).toBe(now + 3000)
    expect(webhookRow(webhook.id).failure_count).toBe(0)
  })

  it('marks a delivery failed after maxAttempts (network errors included)', async () => {
    const { webhook } = createWebhook(db, bob.id, {
      url: 'https://down.example/hook',
      events: ['trade.executed'],
    })
    insertEvent('trade.executed', 'mkt_x', { marketId: 'mkt_x' })

    const recorder = makeRecorder()
    recorder.state.throwError = 'ECONNREFUSED'
    const dispatcher = new WebhookDispatcher({
      db,
      fetchFn: recorder.fetchFn,
      maxAttempts: 2,
    })
    const now = 2_000_000

    await dispatcher.tick(now)
    const stats = await dispatcher.tick(now + 1000)
    expect(stats.failed).toBe(1)
    expect(recorder.calls).toHaveLength(2)

    const delivery = db
      .prepare('SELECT * FROM deliveries WHERE webhook_id = ?')
      .get(webhook.id) as { status: string; attempts: number; last_error: string }
    expect(delivery.status).toBe('failed')
    expect(delivery.attempts).toBe(2)
    expect(delivery.last_error).toContain('ECONNREFUSED')

    // Terminal: later ticks never retry a failed delivery.
    await dispatcher.tick(now + 60_000)
    expect(recorder.calls).toHaveLength(2)
  })

  it('never delivers events that predate the subscription', async () => {
    // Events 1 and 2 exist BEFORE the webhook subscribes.
    const market = makeMarket()
    svc.buy(bob.id, market.id, 'YES', 20)
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
    ).toBe(2)

    const { webhook } = createWebhook(db, bob.id, {
      url: 'https://late.example/hook',
      events: [...EVENT_TYPES],
    })
    // The subscription pinned its start cursor to the current end of the log.
    expect(webhookRow(webhook.id).start_event_id).toBe(2)

    const recorder = makeRecorder()
    const dispatcher = new WebhookDispatcher({ db, fetchFn: recorder.fetchFn })

    // First tick: the two historical events are NOT delivered to the new hook.
    const first = await dispatcher.tick()
    expect(first.enqueued).toBe(0)
    expect(recorder.calls).toHaveLength(0)

    // A fresh event AFTER subscription is delivered.
    svc.buy(bob.id, market.id, 'NO', 15)
    const second = await dispatcher.tick()
    expect(second.enqueued).toBe(1)
    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0]!.headers['X-Predikt-Event']).toBe('trade.executed')
  })

  it('auto-deactivates a webhook after 20 consecutive failures', async () => {
    const { webhook } = createWebhook(db, bob.id, {
      url: 'https://dead.example/hook',
      events: ['trade.executed'],
    })
    for (let i = 0; i < DEACTIVATE_AFTER_CONSECUTIVE_FAILURES; i += 1) {
      insertEvent('trade.executed', `mkt_${i}`, { marketId: `mkt_${i}` })
    }

    const recorder = makeRecorder({ ok: false, status: 503 })
    const dispatcher = new WebhookDispatcher({
      db,
      fetchFn: recorder.fetchFn,
      maxAttempts: 1, // every failed attempt is terminal for its delivery
    })
    await dispatcher.tick(5_000_000)

    const row = webhookRow(webhook.id)
    expect(row.failure_count).toBe(DEACTIVATE_AFTER_CONSECUTIVE_FAILURES)
    expect(row.is_active).toBe(0)

    // A deactivated webhook receives no further deliveries.
    insertEvent('trade.executed', 'mkt_after', { marketId: 'mkt_after' })
    const stats = await dispatcher.tick(5_100_000)
    expect(stats.enqueued).toBe(0)
    expect(recorder.calls).toHaveLength(DEACTIVATE_AFTER_CONSECUTIVE_FAILURES)
  })
})

// ---- HTTP routes ----------------------------------------------------------------

describe('webhook routes', () => {
  type Api = ReturnType<typeof createWebhookRoutes>
  let api: Api

  beforeEach(() => {
    api = createWebhookRoutes({ service: svc, db })
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
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
  }

  async function json(res: Response) {
    return (await res.json()) as { success: boolean; data?: any; error?: string }
  }

  const validBody = {
    url: 'https://agent.example/hook',
    events: ['trade.executed', 'market.resolved'],
  }

  it('requires Bearer auth on every endpoint', async () => {
    expect((await req('/webhooks', { body: validBody })).status).toBe(401)
    expect((await req('/webhooks')).status).toBe(401)
    expect((await req('/webhooks/wh_x', { method: 'DELETE' })).status).toBe(401)
    expect(
      (await req('/webhooks', { key: 'pk_bogus', body: validBody })).status
    ).toBe(401)
  })

  it('creates a subscription, returning the secret exactly once', async () => {
    const res = await req('/webhooks', { key: bobKey, body: validBody })
    expect(res.status).toBe(201)
    const body = await json(res)
    expect(body.success).toBe(true)
    expect(body.data.secret).toMatch(/^whsec_[0-9a-f]{48}$/)
    expect(body.data.webhook.url).toBe(validBody.url)
    expect(body.data.webhook.events).toEqual(validBody.events)
    expect(body.data.webhook.isActive).toBe(true)
    expect(body.data.webhook.secret).not.toBe(body.data.secret)
    expect(body.data.webhook.accountId).toBeUndefined()

    // GET masks the secret but the DB keeps plaintext for signing.
    const list = await json(await req('/webhooks', { key: bobKey }))
    expect(list.data.webhooks).toHaveLength(1)
    expect(list.data.webhooks[0].secret).toContain('…')
    expect(list.data.webhooks[0].secret).not.toBe(body.data.secret)
    expect(webhookRow(body.data.webhook.id).secret).toBe(body.data.secret)
  })

  it('validates url scheme and event types', async () => {
    const bad = [
      { url: 'ftp://agent.example/hook', events: ['trade.executed'] },
      { url: 'not a url', events: ['trade.executed'] },
      { url: 'https://agent.example/hook', events: [] },
      { url: 'https://agent.example/hook', events: ['market.deleted'] },
      { url: 'https://agent.example/hook' },
    ]
    for (const body of bad) {
      const res = await req('/webhooks', { key: bobKey, body })
      expect(res.status).toBe(400)
      expect((await json(res)).success).toBe(false)
    }
  })

  it('rejects webhook URLs targeting private, loopback, or metadata hosts (SSRF)', async () => {
    const blocked = [
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:8080/hook',
      'http://127.0.0.1/hook',
      'https://10.0.0.5/hook',
      'https://192.168.1.10/hook',
      'https://172.16.0.9/hook',
      'https://172.31.255.1/hook',
      'http://[::1]/hook',
      'http://metadata.google.internal/computeMetadata/v1/',
    ]
    for (const url of blocked) {
      const res = await req('/webhooks', {
        key: bobKey,
        body: { url, events: ['market.created'] },
      })
      expect(res.status, `expected ${url} to be rejected`).toBe(400)
      expect((await json(res)).success).toBe(false)
      // Nothing was persisted for a blocked target.
      const list = await json(await req('/webhooks', { key: bobKey }))
      expect(list.data.webhooks).toHaveLength(0)
    }

    // A public host in a non-blocked range is still accepted.
    const okRes = await req('/webhooks', {
      key: bobKey,
      body: { url: 'https://172.32.0.1/hook', events: ['market.created'] },
    })
    expect(okRes.status).toBe(201)
  })

  it('rate limits rapid webhook creation per account', async () => {
    // The per-account create limit is 10/hour; the 11th create in a burst is
    // throttled with 429 even though active webhooks are deleted in between.
    let throttled = 0
    for (let i = 0; i < 12; i += 1) {
      const res = await req('/webhooks', {
        key: bobKey,
        body: { url: `https://agent.example/hook/${i}`, events: ['trade.executed'] },
      })
      if (res.status === 429) {
        throttled += 1
        expect(res.headers.get('Retry-After')).toBeTruthy()
      } else {
        // Keep active count low so the 5-active cap never trips first.
        const created = await json(res)
        await req(`/webhooks/${created.data.webhook.id}`, {
          method: 'DELETE',
          key: bobKey,
        })
      }
    }
    expect(throttled).toBeGreaterThan(0)
  })

  it('lists only the caller’s webhooks', async () => {
    await req('/webhooks', { key: bobKey, body: validBody })
    await req('/webhooks', {
      key: aliceKey,
      body: { url: 'https://alice.example/hook', events: ['market.created'] },
    })
    const bobList = await json(await req('/webhooks', { key: bobKey }))
    const aliceList = await json(await req('/webhooks', { key: aliceKey }))
    expect(bobList.data.webhooks).toHaveLength(1)
    expect(bobList.data.webhooks[0].url).toBe(validBody.url)
    expect(aliceList.data.webhooks).toHaveLength(1)
    expect(aliceList.data.webhooks[0].url).toBe('https://alice.example/hook')
  })

  it('deletes only for the owner', async () => {
    const created = await json(await req('/webhooks', { key: bobKey, body: validBody }))
    const id = created.data.webhook.id as string

    // A stranger cannot delete (404: existence is not leaked).
    const foreign = await req(`/webhooks/${id}`, { method: 'DELETE', key: aliceKey })
    expect(foreign.status).toBe(404)

    const res = await req(`/webhooks/${id}`, { method: 'DELETE', key: bobKey })
    expect(res.status).toBe(200)
    expect((await json(res)).data.deleted).toBe(true)
    const list = await json(await req('/webhooks', { key: bobKey }))
    expect(list.data.webhooks).toHaveLength(0)

    expect(
      (await req(`/webhooks/${id}`, { method: 'DELETE', key: bobKey })).status
    ).toBe(404)
  })

  it('enforces at most 5 active webhooks per account', async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await req('/webhooks', {
        key: bobKey,
        body: { url: `https://agent.example/hook/${i}`, events: ['trade.executed'] },
      })
      expect(res.status).toBe(201)
    }
    const sixth = await req('/webhooks', { key: bobKey, body: validBody })
    expect(sixth.status).toBe(409)
    expect((await json(sixth)).error).toContain('5')

    // Deleting one frees a slot.
    const list = await json(await req('/webhooks', { key: bobKey }))
    const id = list.data.webhooks[0].id as string
    await req(`/webhooks/${id}`, { method: 'DELETE', key: bobKey })
    expect((await req('/webhooks', { key: bobKey, body: validBody })).status).toBe(201)
  })
})
