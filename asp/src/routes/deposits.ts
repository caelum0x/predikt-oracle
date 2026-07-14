// USDT deposit route via the x402 payment protocol (v1, scheme "exact").
// Agents call POST /deposits; without an X-PAYMENT header they receive an
// HTTP 402 challenge whose "accepts" entry tells x402-aware SDKs exactly how
// to pay (EIP-3009 authorization to our payTo address). Retrying with a valid
// X-PAYMENT header credits the account 1:1 (1 credit = 1 USDT, 6 decimals).

import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import { z } from 'zod'
import {
  MarketService,
  ServiceError,
  type Account,
} from '../engine/service'
import type { Db } from '../engine/store'
import { getX402Config, type X402Config } from '../payments/config'
import {
  buildPaymentRequirements,
  buildPaymentResponseHeader,
  decodePaymentHeader,
  initX402Schema,
  recordDeposit,
  settlePayment,
  verifyPayment,
  X402Error,
  X402_VERSION,
  type PaymentRequirements,
} from '../payments/x402'

type ApiResponse<T> = { success: boolean; data?: T; error?: string }

type Env = { Variables: { account: Account } }

export type DepositRouteOptions = {
  /** Injected config for tests; defaults to environment-derived config. */
  config?: X402Config
  /** Injected fetch for facilitator settlement in tests. */
  fetchFn?: typeof fetch
}

const USDT_DECIMALS_FACTOR = 1_000_000
const MIN_DEPOSIT = 1
const MAX_DEPOSIT = 100_000

const depositSchema = z.object({
  amount: z
    .number()
    .finite()
    .min(MIN_DEPOSIT, `Deposit must be at least ${MIN_DEPOSIT} credit.`)
    .max(MAX_DEPOSIT, `Deposit cannot exceed ${MAX_DEPOSIT} credits.`),
})

function ok<T>(c: Context, data: T, status: 200 | 201 = 200) {
  return c.json({ success: true, data } satisfies ApiResponse<T>, status)
}

function fail(c: Context, status: 400 | 401 | 402 | 503, error: string) {
  return c.json({ success: false, error } satisfies ApiResponse<never>, status)
}

function failFrom(c: Context, err: unknown) {
  if (err instanceof X402Error || err instanceof ServiceError) {
    return fail(c, err.status as 400 | 401 | 402 | 503, err.message)
  }
  console.error(
    'deposit route unexpected error:',
    err instanceof Error ? err.message : 'unknown error'
  )
  return c.json(
    { success: false, error: 'Unexpected server error.' } satisfies ApiResponse<never>,
    500
  )
}

/** x402 challenge: the exact shape agent payment SDKs expect on HTTP 402. */
function paymentChallenge(c: Context, requirements: PaymentRequirements) {
  return c.json(
    { x402Version: X402_VERSION, error: 'payment required', accepts: [requirements] },
    402
  )
}

export function createDepositRoutes(
  service: MarketService,
  db: Db,
  options: DepositRouteOptions = {}
): Hono<Env> {
  initX402Schema(db)
  const config = options.config ?? getX402Config()
  const fetchFn = options.fetchFn ?? fetch
  const app = new Hono<Env>()

  const auth: MiddlewareHandler<Env> = async (c, next) => {
    const header = c.req.header('Authorization') ?? ''
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const account = key ? service.getAccountByKey(key) : null
    if (!account) {
      return fail(c, 401, 'Provide a valid API key: Authorization: Bearer pk_...')
    }
    c.set('account', account)
    await next()
  }

  app.post('/deposits', auth, async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return fail(c, 400, 'Request body must be JSON.')
    }
    const parsed = depositSchema.safeParse(body)
    if (!parsed.success) {
      return fail(c, 400, parsed.error.issues[0]?.message ?? 'Invalid request.')
    }

    if (!config.payTo) {
      return fail(
        c,
        503,
        'Payments are not configured: X402_PAY_TO is unset on this server.'
      )
    }

    const account = c.get('account')
    const amount = parsed.data.amount
    const amountBaseUnits = BigInt(Math.round(amount * USDT_DECIMALS_FACTOR))

    let requirements: PaymentRequirements
    try {
      requirements = buildPaymentRequirements({
        amountBaseUnits,
        resource: c.req.url,
        description: `Deposit ${amount} USDT for ${amount} Predikt Oracle credits (account ${account.id}).`,
        config,
      })
    } catch (err) {
      return failFrom(c, err)
    }

    const paymentHeader = c.req.header('X-PAYMENT')
    if (!paymentHeader) {
      return paymentChallenge(c, requirements)
    }

    try {
      const payment = decodePaymentHeader(paymentHeader)
      const verified = await verifyPayment(db, payment, requirements, config)
      const settlement = await settlePayment(payment, requirements, config, fetchFn)
      const deposit = recordDeposit(db, {
        accountId: account.id,
        amount,
        txNonce: verified.nonce,
        network: payment.network,
      })
      c.header('X-PAYMENT-RESPONSE', buildPaymentResponseHeader(settlement))
      return ok(c, {
        deposit,
        balance: service.getAccount(account.id).balance,
      })
    } catch (err) {
      return failFrom(c, err)
    }
  })

  return app
}
