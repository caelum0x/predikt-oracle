// Auto-resolution routes. The sweeper (src/resolution/sweeper.ts) stores AI
// resolution suggestions for markets past their close time; these routes let
// anyone read a suggestion and let the market creator apply a confident one in
// a single call. The routes never resolve a market on their own initiative —
// they only apply a stored suggestion, and only when it is decisive.

import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { Db } from '../engine/store'
import { MarketService, ServiceError, type Account } from '../engine/service'
import {
  getSuggestion,
  initResolutionSchema,
  type StoredSuggestion,
} from '../resolution/sweeper'

// A suggestion is only auto-applicable at or above this model confidence,
// unless the creator passes { force: true }.
export const AUTO_RESOLVE_MIN_CONFIDENCE = 0.75

type ApiResponse<T> = { success: boolean; data?: T; error?: string }
type Env = { Variables: { account: Account } }

const applyBodySchema = z
  .object({ force: z.boolean().optional() })
  .optional()
  .default({})

function ok<T>(c: Context, data: T, status: 200 | 201 = 200) {
  return c.json({ success: true, data } satisfies ApiResponse<T>, status)
}

function failFrom(c: Context, err: unknown) {
  if (err instanceof ServiceError) {
    return c.json(
      { success: false, error: err.message } satisfies ApiResponse<never>,
      err.status
    )
  }
  console.error(
    'resolution route unexpected error:',
    err instanceof Error ? err.message : 'unknown error'
  )
  return c.json(
    { success: false, error: 'Unexpected server error.' } satisfies ApiResponse<never>,
    500
  )
}

// Public view of a stored suggestion (model_raw stays server-side).
function publicSuggestion(s: StoredSuggestion) {
  return {
    marketId: s.marketId,
    verdict: s.verdict,
    answerId: s.answerId,
    confidence: s.confidence,
    rationale: s.rationale,
    citations: s.citations,
    createdAt: s.createdAt,
  }
}

// Turns a stored suggestion into the outcome argument resolveMarket expects,
// or null when the suggestion is not decisive enough to auto-apply.
function decisiveOutcome(s: StoredSuggestion): string | null {
  if (s.verdict === 'YES' || s.verdict === 'NO') return s.verdict
  if (s.verdict === 'ANSWER' && s.answerId) return s.answerId
  // UNCLEAR (or an ANSWER that never matched an answer id) is never auto-applied.
  return null
}

export function createResolutionRoutes(deps: {
  service: MarketService
  db: Db
}): Hono<Env> {
  const { service, db } = deps
  // The routes read resolution_suggestions directly, so ensure the schema
  // exists even if the sweeper has not been constructed yet.
  initResolutionSchema(db)
  const app = new Hono<Env>()

  // Public: read the stored AI suggestion for a market.
  app.get('/markets/:id/resolution-suggestion', (c) => {
    const marketId = c.req.param('id') ?? ''
    try {
      service.getMarket(marketId) // 404 if the market does not exist
    } catch (err) {
      return failFrom(c, err)
    }
    const suggestion = getSuggestion(db, marketId)
    if (!suggestion) {
      return failFrom(
        c,
        new ServiceError(404, 'No resolution suggestion yet for this market.')
      )
    }
    return ok(c, { suggestion: publicSuggestion(suggestion) })
  })

  // Bearer auth for the apply endpoint.
  const auth = async (c: Context<Env>, next: () => Promise<void>) => {
    const header = c.req.header('Authorization') ?? ''
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const account = key ? service.getAccountByKey(key) : null
    if (!account) {
      return failFrom(
        c,
        new ServiceError(401, 'Provide a valid API key: Authorization: Bearer pk_...')
      )
    }
    c.set('account', account)
    await next()
  }

  // Creator: apply the stored suggestion. Requires a decisive verdict and
  // (unless force) confidence >= AUTO_RESOLVE_MIN_CONFIDENCE.
  app.post('/markets/:id/resolve-suggested', auth, async (c) => {
    const marketId = c.req.param('id') ?? ''
    const account = c.get('account')

    let market
    try {
      market = service.getMarket(marketId)
    } catch (err) {
      return failFrom(c, err)
    }
    if (market.creatorId !== account.id) {
      return failFrom(
        c,
        new ServiceError(403, 'Only the market creator can resolve it.')
      )
    }

    // Parse the body from raw text so a missing Content-Type does not silently
    // drop a { "force": true } the caller actually sent. An absent/empty body
    // is treated as {}; a present-but-malformed body is a 400 rather than being
    // swallowed into an empty object.
    let body: { force?: boolean }
    const rawText = await c.req.text()
    if (rawText.trim() === '') {
      body = {}
    } else {
      let raw: unknown
      try {
        raw = JSON.parse(rawText)
      } catch {
        return failFrom(c, new ServiceError(400, 'Request body must be JSON.'))
      }
      const result = applyBodySchema.safeParse(raw)
      if (!result.success) {
        return failFrom(
          c,
          new ServiceError(400, result.error.issues[0]?.message ?? 'Invalid request body.')
        )
      }
      body = result.data
    }
    const force = body.force ?? false

    const suggestion = getSuggestion(db, marketId)
    if (!suggestion) {
      return failFrom(
        c,
        new ServiceError(404, 'No resolution suggestion yet for this market.')
      )
    }

    const outcome = decisiveOutcome(suggestion)
    if (outcome === null) {
      return c.json(
        {
          success: false,
          error:
            'The suggestion is UNCLEAR and cannot be auto-applied; resolve this market manually.',
          data: { suggestion: publicSuggestion(suggestion) },
        },
        409
      )
    }
    if (!force && suggestion.confidence < AUTO_RESOLVE_MIN_CONFIDENCE) {
      return c.json(
        {
          success: false,
          error: `Suggestion confidence ${suggestion.confidence} is below the ${AUTO_RESOLVE_MIN_CONFIDENCE} auto-resolve threshold; pass { "force": true } to apply it anyway or resolve manually.`,
          data: { suggestion: publicSuggestion(suggestion) },
        },
        409
      )
    }

    try {
      const resolved = service.resolveMarket(account.id, marketId, outcome)
      return ok(c, {
        market: resolved,
        appliedSuggestion: publicSuggestion(suggestion),
      })
    } catch (err) {
      return failFrom(c, err)
    }
  })

  return app
}
