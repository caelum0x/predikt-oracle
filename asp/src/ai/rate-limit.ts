// Best-effort in-memory rate limiter for abusable public routes (SERVER-ONLY).
//
// A small token-bucket keyed by client IP. Per-instance and reset on restart,
// so NOT a hard global guarantee — but enough to stop a single client from
// hammering the routes and burning OpenRouter credits.
//
// Ported from predikt (oracle/web/lib/ai/rate-limit.ts), made framework-free.

// Default bucket capacity and refill: 10 requests per 60s, refilling
// continuously so a caller regains ~1 token every 6s. Routes can override
// per-key via RateLimitConfig (the config is fixed per key; the first call
// for a key decides its bucket size).
const DEFAULT_CAPACITY = 10
const DEFAULT_REFILL_WINDOW_MS = 60_000

export type RateLimitConfig = {
  capacity: number
  refillWindowMs: number
}

type Bucket = {
  tokens: number
  updatedAt: number
  capacity: number
  refillPerMs: number
}

// Module-level map persists across requests within a single process.
const buckets = new Map<string, Bucket>()

// Occasionally prune idle buckets so the map can't grow unbounded.
const IDLE_TTL_MS = 5 * DEFAULT_REFILL_WINDOW_MS
let lastSweep = 0

function sweep(now: number): void {
  if (now - lastSweep < IDLE_TTL_MS) return
  lastSweep = now
  for (const [key, bucket] of buckets) {
    if (now - bucket.updatedAt > IDLE_TTL_MS) buckets.delete(key)
  }
}

export type RateLimitResult = {
  allowed: boolean
  // Seconds until at least one token is available again (when not allowed).
  retryAfterSeconds: number
}

// Consume one token for `key`. Returns whether the request is allowed.
export function consumeToken(
  key: string,
  config?: RateLimitConfig
): RateLimitResult {
  const now = Date.now()
  sweep(now)

  const capacity = config?.capacity ?? DEFAULT_CAPACITY
  const refillPerMs =
    capacity / (config?.refillWindowMs ?? DEFAULT_REFILL_WINDOW_MS)

  const existing = buckets.get(key)
  const bucket: Bucket =
    existing ?? { tokens: capacity, updatedAt: now, capacity, refillPerMs }

  // Refill based on elapsed time since last update, capped at capacity.
  const elapsed = now - bucket.updatedAt
  const refilled = Math.min(
    bucket.capacity,
    bucket.tokens + elapsed * bucket.refillPerMs
  )

  if (refilled >= 1) {
    buckets.set(key, { ...bucket, tokens: refilled - 1, updatedAt: now })
    return { allowed: true, retryAfterSeconds: 0 }
  }

  // Not enough tokens — keep the (refilled) balance and report wait time.
  buckets.set(key, { ...bucket, tokens: refilled, updatedAt: now })
  const needed = 1 - refilled
  const retryAfterSeconds = Math.ceil(needed / bucket.refillPerMs / 1000)
  return { allowed: false, retryAfterSeconds: Math.max(1, retryAfterSeconds) }
}

export type ClientIpOptions = {
  // Trust proxy-supplied forwarding headers. Enable ONLY when the server sits
  // behind a reverse proxy that overwrites/appends these headers (e.g. Fly.io,
  // nginx). When false (the default), the headers are ignored entirely —
  // otherwise any client could pick its own rate-limit bucket by sending a
  // fresh X-Forwarded-For value on every request.
  trustProxyHeader?: boolean
  // The transport-level peer address (e.g. socket.remoteAddress), if known.
  socketAddress?: string | undefined
}

// Derive a best-effort client key. `getHeader` abstracts the framework
// (Hono: (name) => c.req.header(name)).
export function clientIpKey(
  getHeader: (name: string) => string | undefined,
  options: ClientIpOptions = {}
): string {
  if (options.trustProxyHeader) {
    // Prefer the proxy's authoritative header; otherwise take the LAST entry
    // of X-Forwarded-For — proxies append the verified peer address, so the
    // last entry is the one written by our own edge (earlier entries are
    // client-controlled and spoofable).
    const authoritative = getHeader('fly-client-ip')?.trim()
    if (authoritative) return `ip:${authoritative}`
    const forwarded = getHeader('x-forwarded-for')
    const entries = forwarded?.split(',').map((s) => s.trim()).filter(Boolean)
    const last = entries?.[entries.length - 1]
    if (last) return `ip:${last}`
  }
  return `ip:${options.socketAddress?.trim() || 'unknown'}`
}
