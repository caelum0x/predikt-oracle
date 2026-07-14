// The Predikt Oracle HTTP app. Three A2MCP tool routes plus a manifest and a
// health check. The AI completion function is injected so tests never touch
// the network.

import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import {
  chatCompletion,
  OpenRouterError,
  parseJsonObject,
  type ChatCompletionFn,
} from './ai/openrouter'
import {
  buildDraftMessages,
  buildOddsMessages,
  buildResolutionMessages,
} from './ai/prompts'
import {
  draftMarketRequestSchema,
  draftMarketSchema,
  estimateOddsRequestSchema,
  normalizeCloseTime,
  oddsEstimateSchema,
  resolutionSuggestionSchema,
  suggestResolutionRequestSchema,
  type DraftMarket,
} from './ai/schema'
import { clientIpKey, consumeToken } from './ai/rate-limit'
import { SERVICE_MANIFEST } from './manifest'
import { MarketService } from './engine/service'
import { openDb, type Db } from './engine/store'
import { createMarketRoutes } from './routes/markets'
import { createDepositRoutes } from './routes/deposits'
import { createStatsRoutes } from './routes/stats'
import { createActivityRoutes } from './routes/activity'
import { createDashboardRoutes } from './routes/dashboard'

// Consistent envelope for every response.
type ApiResponse<T> = {
  success: boolean
  data?: T
  error?: string
}

function ok<T>(c: Context, data: T) {
  return c.json({ success: true, data } satisfies ApiResponse<T>)
}

function fail(c: Context, status: 400 | 429 | 500 | 502 | 504, error: string) {
  return c.json({ success: false, error } satisfies ApiResponse<never>, status)
}

// Map an upstream AI failure to a client-safe response. Upstream 4xx becomes
// a generic 502 so provider internals don't leak, except our own config (500)
// and bad-prompt (400) errors.
function failFromAiError(c: Context, err: unknown, route: string) {
  if (err instanceof OpenRouterError) {
    const status =
      err.status === 500 || err.status === 400
        ? err.status
        : err.status === 504
        ? 504
        : 502
    return fail(c, status, err.message)
  }
  console.error(
    `${route} unexpected error:`,
    err instanceof Error ? err.message : 'unknown error'
  )
  return fail(c, 500, 'Unexpected server error.')
}

// Rate-limit by client IP; returns a response when the caller must wait.
function checkRateLimit(c: Context, route: string) {
  const key = `${route}:${clientIpKey((name) => c.req.header(name))}`
  const limit = consumeToken(key)
  if (limit.allowed) return null
  c.header('Retry-After', String(limit.retryAfterSeconds))
  return fail(c, 429, 'Too many requests. Please wait a moment and try again.')
}

async function readJsonBody(c: Context): Promise<unknown | null> {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

function firstIssue(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback
}

export type AppOptions = {
  complete?: ChatCompletionFn
  // Injected in tests (':memory:'); defaults to a file DB for the server.
  db?: Db
}

export function createApp(options: AppOptions = {}): Hono {
  const complete = options.complete ?? chatCompletion
  const db = options.db ?? openDb(process.env.DB_PATH || 'predikt-oracle.db')
  const service = new MarketService(db)
  const app = new Hono()

  app.get('/', (c) => ok(c, SERVICE_MANIFEST))
  app.get('/health', (c) => ok(c, { status: 'ok' }))

  // Accounts + market lifecycle + trading.
  app.route('/', createMarketRoutes(service))
  // USDT deposits via the x402 payment protocol (verify-only until a
  // facilitator is configured).
  app.route('/', createDepositRoutes(service, db))
  // Public reputation, leaderboard, and platform analytics.
  app.route('/', createStatsRoutes(db))
  // Trade history, portfolios, and the global activity feed.
  app.route('/', createActivityRoutes(service, db))
  // Human-facing dashboard at /app.
  app.route('/', createDashboardRoutes())

  // POST /tools/draft-market — topic/news/url → validated market drafts.
  app.post('/tools/draft-market', async (c) => {
    const limited = checkRateLimit(c, 'draft-market')
    if (limited) return limited

    const body = await readJsonBody(c)
    const parsedReq = draftMarketRequestSchema.safeParse(body)
    if (!parsedReq.success) {
      return fail(
        c,
        400,
        firstIssue(parsedReq.error, 'Invalid request. Add a source.')
      )
    }

    const now = new Date()
    const messages = buildDraftMessages(parsedReq.data, now.toISOString())

    let raw: string
    try {
      raw = await complete({ messages, jsonMode: true, temperature: 0.5 })
    } catch (err) {
      return failFromAiError(c, err, 'draft-market')
    }

    let parsedJson: unknown
    try {
      parsedJson = parseJsonObject(raw)
    } catch (err) {
      return failFromAiError(c, err, 'draft-market')
    }

    // Validate each draft; anything malformed is dropped, never repaired.
    const drafts: DraftMarket[] = []
    for (const candidate of extractRawDrafts(parsedJson)) {
      const result = draftMarketSchema.safeParse(candidate)
      if (result.success) {
        drafts.push(normalizeCloseTime(result.data, now.getTime()))
      }
    }

    if (drafts.length === 0) {
      return fail(
        c,
        502,
        'The AI did not return a usable market. Try rephrasing.'
      )
    }
    return ok(c, { drafts })
  })

  // POST /tools/estimate-odds — question → calibrated probability estimate.
  app.post('/tools/estimate-odds', async (c) => {
    const limited = checkRateLimit(c, 'estimate-odds')
    if (limited) return limited

    const body = await readJsonBody(c)
    const parsedReq = estimateOddsRequestSchema.safeParse(body)
    if (!parsedReq.success) {
      return fail(c, 400, firstIssue(parsedReq.error, 'Invalid request.'))
    }

    const messages = buildOddsMessages(
      parsedReq.data,
      new Date().toISOString()
    )

    let raw: string
    try {
      raw = await complete({ messages, jsonMode: true, temperature: 0.3 })
    } catch (err) {
      return failFromAiError(c, err, 'estimate-odds')
    }

    let parsedJson: unknown
    try {
      parsedJson = parseJsonObject(raw)
    } catch (err) {
      return failFromAiError(c, err, 'estimate-odds')
    }

    const result = oddsEstimateSchema.safeParse(parsedJson)
    if (!result.success) {
      return fail(c, 502, 'The AI returned an unusable estimate. Try again.')
    }
    return ok(c, { estimate: result.data })
  })

  // POST /tools/suggest-resolution — question + evidence → proposed verdict.
  app.post('/tools/suggest-resolution', async (c) => {
    const limited = checkRateLimit(c, 'suggest-resolution')
    if (limited) return limited

    const body = await readJsonBody(c)
    const parsedReq = suggestResolutionRequestSchema.safeParse(body)
    if (!parsedReq.success) {
      return fail(c, 400, firstIssue(parsedReq.error, 'Invalid request.'))
    }

    const messages = buildResolutionMessages(
      parsedReq.data,
      new Date().toISOString()
    )

    let raw: string
    try {
      raw = await complete({ messages, jsonMode: true, temperature: 0.2 })
    } catch (err) {
      return failFromAiError(c, err, 'suggest-resolution')
    }

    let parsedJson: unknown
    try {
      parsedJson = parseJsonObject(raw)
    } catch (err) {
      return failFromAiError(c, err, 'suggest-resolution')
    }

    const result = resolutionSuggestionSchema.safeParse(parsedJson)
    if (!result.success) {
      return fail(c, 502, 'The AI returned an unusable suggestion. Try again.')
    }
    return ok(c, { suggestion: result.data })
  })

  return app
}

// The model may return {drafts:[...]}, a bare array, or a single object.
function extractRawDrafts(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') {
    const maybe = (parsed as { drafts?: unknown }).drafts
    if (Array.isArray(maybe)) return maybe
    return [parsed]
  }
  return []
}
