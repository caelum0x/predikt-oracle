// Webhook subscription routes. Follows the markets.ts conventions: {success,
// data?, error?} envelope, zod-validated bodies, Bearer auth via
// service.getAccountByKey.
//
// The signing secret is returned exactly once, in the POST response. It is
// stored in plaintext (not hashed) because the dispatcher must HMAC-sign
// every delivery body with it; all reads after creation return it masked.

import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { MarketService, ServiceError, type Account } from '../engine/service'
import type { Db } from '../engine/store'
import { consumeToken, type RateLimitConfig } from '../ai/rate-limit'
import {
  createWebhook,
  deleteWebhook,
  EVENT_TYPES,
  initEventsSchema,
  listWebhooks,
  maskSecret,
  toWebhook,
  type Webhook,
  type WebhookRow,
} from '../webhooks/events'
import { webhookUrlError } from '../webhooks/ssrf'

type ApiResponse<T> = { success: boolean; data?: T; error?: string }

type Env = { Variables: { account: Account } }

type WebhookView = Omit<Webhook, 'accountId'> & { secret: string }

// 10 webhook registrations per account per hour. This is a separate guard from
// the 5-active-webhook cap: it throttles rapid create/delete cycling that would
// otherwise let a caller sweep internal addresses one batch at a time.
const WEBHOOK_CREATE_LIMIT: RateLimitConfig = {
  capacity: 10,
  refillWindowMs: 3_600_000,
}

const createWebhookSchema = z.object({
  url: z
    .string()
    .trim()
    .url('url must be a valid http(s) URL.')
    .max(500)
    // Reject non-http(s) schemes AND destinations that resolve (by literal
    // host) to private/loopback/link-local/metadata addresses. See
    // ../webhooks/ssrf.ts for the exact rules and residual DNS-rebinding risk.
    .refine((u) => webhookUrlError(u) === null, (u) => ({
      message: webhookUrlError(u) ?? 'url is not an allowed webhook target.',
    })),
  events: z
    .array(z.enum(EVENT_TYPES))
    .min(1, 'events must contain at least one event type.')
    .max(EVENT_TYPES.length),
})

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
    'webhook route unexpected error:',
    err instanceof Error ? err.message : 'unknown error'
  )
  return c.json(
    { success: false, error: 'Unexpected server error.' } satisfies ApiResponse<never>,
    500
  )
}

async function parseBody<T>(
  c: Context,
  schema: z.ZodType<T>
): Promise<{ data: T } | { error: string }> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return { error: 'Request body must be JSON.' }
  }
  const result = schema.safeParse(body)
  if (!result.success) {
    return { error: result.error.issues[0]?.message ?? 'Invalid request.' }
  }
  return { data: result.data }
}

function maskedView(row: WebhookRow): WebhookView {
  const { accountId: _accountId, ...rest } = toWebhook(row)
  return { ...rest, secret: maskSecret(row.secret) }
}

export function createWebhookRoutes(deps: {
  service: MarketService
  db: Db
}): Hono<Env> {
  const { service, db } = deps
  // Ensure the events/webhooks tables and capture triggers exist even if no
  // dispatcher has been constructed yet (self-contained like the other routes).
  initEventsSchema(db)
  const app = new Hono<Env>()

  const auth: MiddlewareHandler<Env> = async (c, next) => {
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

  // Subscribe to market events. The secret in the response is shown ONCE.
  app.post('/webhooks', auth, async (c) => {
    const account = c.get('account')
    const limit = consumeToken(`webhook-create:${account.id}`, WEBHOOK_CREATE_LIMIT)
    if (!limit.allowed) {
      c.header('Retry-After', String(limit.retryAfterSeconds))
      return c.json(
        {
          success: false,
          error: 'Too many webhook registrations. Please wait and try again.',
        } satisfies ApiResponse<never>,
        429
      )
    }
    const parsed = await parseBody(c, createWebhookSchema)
    if ('error' in parsed) return failFrom(c, new ServiceError(400, parsed.error))
    try {
      const { webhook, secret } = createWebhook(db, account.id, parsed.data)
      const { accountId: _accountId, ...view } = webhook
      return ok(
        c,
        { webhook: { ...view, secret: maskSecret(secret) }, secret },
        201
      )
    } catch (err) {
      return failFrom(c, err)
    }
  })

  // The caller's own subscriptions, secrets masked.
  app.get('/webhooks', auth, (c) => {
    try {
      const webhooks = listWebhooks(db, c.get('account').id).map(maskedView)
      return ok(c, { webhooks })
    } catch (err) {
      return failFrom(c, err)
    }
  })

  // Remove one of the caller's subscriptions (and its delivery history).
  app.delete('/webhooks/:id', auth, (c) => {
    try {
      const webhook = deleteWebhook(db, c.get('account').id, c.req.param('id'))
      const { accountId: _accountId, ...view } = webhook
      return ok(c, { deleted: true, webhook: view })
    } catch (err) {
      return failFrom(c, err)
    }
  })

  return app
}
