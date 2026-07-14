// Security regression tests for the rate limiting layer:
//  - clientIpKey must not trust client-controlled X-Forwarded-For unless the
//    deployment explicitly opts in (behind a proxy it controls), and in
//    trusted mode must use the proxy-written (last) entry, never the
//    client-written (first) one.
//  - POST /accounts and the /stats/* routes carry per-IP token buckets so
//    unauthenticated callers cannot hammer SQLite-heavy endpoints.

import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { openDb } from '../src/engine/store'
import { clientIpKey, consumeToken } from '../src/ai/rate-limit'

const oddsJson = JSON.stringify({
  probability: 0.62,
  confidence: 'medium',
  rationale: 'Base rate adjusted for current Fed guidance.',
  baseRate: 'Cuts followed 70% of comparable pauses.',
  keyDrivers: ['Inflation prints'],
  updateTriggers: ['Next FOMC'],
  citations: [],
})

function makeApp(trustProxyHeader?: boolean) {
  return createApp({
    db: openDb(':memory:'),
    complete: async () => oddsJson,
    ...(trustProxyHeader === undefined ? {} : { trustProxyHeader }),
  })
}

function headerGetter(headers: Record<string, string>) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  )
  return (name: string) => lower[name.toLowerCase()]
}

describe('clientIpKey', () => {
  it('ignores X-Forwarded-For entirely when the proxy header is untrusted', () => {
    const key = clientIpKey(headerGetter({ 'X-Forwarded-For': '1.2.3.4' }), {
      trustProxyHeader: false,
      socketAddress: '10.0.0.9',
    })
    expect(key).toBe('ip:10.0.0.9')
  })

  it('defaults to untrusted and falls back to "unknown" without a socket', () => {
    expect(clientIpKey(headerGetter({ 'X-Forwarded-For': '1.2.3.4' }))).toBe(
      'ip:unknown'
    )
  })

  it('trusted mode uses the LAST X-Forwarded-For entry (proxy-written)', () => {
    // The first entry is client-controlled; the proxy appends the real peer.
    const key = clientIpKey(
      headerGetter({ 'X-Forwarded-For': 'spoofed.example, 203.0.113.7' }),
      { trustProxyHeader: true }
    )
    expect(key).toBe('ip:203.0.113.7')
  })

  it('trusted mode prefers the authoritative Fly-Client-IP header', () => {
    const key = clientIpKey(
      headerGetter({
        'Fly-Client-IP': '198.51.100.4',
        'X-Forwarded-For': 'spoofed.example, 203.0.113.7',
      }),
      { trustProxyHeader: true }
    )
    expect(key).toBe('ip:198.51.100.4')
  })
})

describe('consumeToken with per-route configs', () => {
  it('honors a custom capacity fixed at bucket creation', () => {
    const key = `cfg-test-${Date.now()}-${Math.random()}`
    const config = { capacity: 3, refillWindowMs: 60_000 }
    for (let i = 0; i < 3; i++) {
      expect(consumeToken(key, config).allowed).toBe(true)
    }
    const denied = consumeToken(key, config)
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1)
  })
})

describe('X-Forwarded-For spoofing cannot evade the AI tool rate limit', () => {
  it('rotating the header per request still exhausts one shared bucket', async () => {
    // Default (untrusted) app: the header must be ignored, so 11 requests
    // with 11 different spoofed IPs land in the same bucket and the 11th
    // is rejected. Before the fix each request got a fresh 10-token bucket.
    const app = makeApp(false)
    let last: Response | undefined
    for (let i = 0; i < 11; i++) {
      last = await app.request('/tools/estimate-odds', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': `198.51.100.${i}`,
        },
        body: JSON.stringify({
          question: 'Will the Fed cut rates before October 2026?',
        }),
      })
    }
    expect(last?.status).toBe(429)
    expect(last?.headers.get('Retry-After')).toBeTruthy()
  })

  it('trusted mode keys on the proxy-written (last) entry, not the spoofable first', async () => {
    const app = makeApp(true)
    let last: Response | undefined
    for (let i = 0; i < 11; i++) {
      last = await app.request('/tools/estimate-odds', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Client rotates its self-reported hop; the proxy-appended peer
          // address stays the same, so the bucket is shared.
          'X-Forwarded-For': `10.9.9.${i}, 192.0.2.200`,
        },
        body: JSON.stringify({
          question: 'Will the Fed cut rates before October 2026?',
        }),
      })
    }
    expect(last?.status).toBe(429)
  })
})

describe('account creation rate limit', () => {
  it('rejects a burst of unauthenticated POST /accounts with 429', async () => {
    const app = makeApp(false)
    let created = 0
    let limited: Response | null = null
    for (let i = 0; i < 40 && !limited; i++) {
      const res = await app.request('/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `burst-agent-${i}` }),
      })
      if (res.status === 429) limited = res
      else if (res.status === 201) created += 1
    }
    expect(limited).not.toBeNull()
    expect(limited!.headers.get('Retry-After')).toBeTruthy()
    // The bucket allows a healthy burst before clamping down.
    expect(created).toBeGreaterThanOrEqual(20)
    const body = (await limited!.json()) as { success: boolean }
    expect(body.success).toBe(false)
  })

  it('does not throttle authenticated GET /accounts/me traffic', async () => {
    // Trusted mode + a unique client IP keeps this test's account-creation
    // bucket separate from the burst test above (buckets are module-level).
    const app = makeApp(true)
    const res = await app.request('/accounts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.99',
      },
      body: JSON.stringify({ name: 'me-agent' }),
    })
    const { data } = (await res.json()) as { data: { apiKey: string } }
    for (let i = 0; i < 40; i++) {
      const me = await app.request('/accounts/me', {
        headers: { Authorization: `Bearer ${data.apiKey}` },
      })
      expect(me.status).toBe(200)
    }
  })
})

describe('stats rate limit', () => {
  it('rejects a leaderboard hammer loop with 429', async () => {
    const app = makeApp(false)
    let limited: Response | null = null
    let served = 0
    for (let i = 0; i < 70 && !limited; i++) {
      const res = await app.request('/stats/leaderboard')
      if (res.status === 429) limited = res
      else if (res.status === 200) served += 1
    }
    expect(limited).not.toBeNull()
    expect(served).toBeGreaterThanOrEqual(50)
    expect(limited!.headers.get('Retry-After')).toBeTruthy()
  })
})
