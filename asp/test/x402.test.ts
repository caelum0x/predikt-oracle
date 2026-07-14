// x402 deposit flow tests with REAL cryptography: genuine EIP-3009
// TransferWithAuthorization typed-data signatures produced by viem accounts,
// verified end-to-end through the deposit route. In-memory DB, no network.

import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { privateKeyToAccount } from 'viem/accounts'
import { openDb, type Db } from '../src/engine/store'
import { MarketService, SIGNUP_GRANT } from '../src/engine/service'
import { createDepositRoutes } from '../src/routes/deposits'
import { getX402Config, type X402Config } from '../src/payments/config'
import {
  buildPaymentRequirements,
  decodePaymentHeader,
  recordDeposit,
  settlePayment,
  X402Error,
  type PaymentPayload,
} from '../src/payments/x402'

// Well-known anvil test keys — never used on real networks.
const payer = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
)
const stranger = privateKeyToAccount(
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'
)
const PAY_TO = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const

const CONFIG: X402Config = {
  network: 'xlayer',
  chainId: 196,
  tokenAddress: '0x1E4a5963aBFD975d8c9021ce480b42188849D41d',
  payTo: PAY_TO,
  tokenName: 'USDT',
  tokenVersion: '1',
  facilitatorUrl: null,
}

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

type Authorization = {
  from: `0x${string}`
  to: `0x${string}`
  value: string
  validAfter: string
  validBefore: string
  nonce: `0x${string}`
}

function randomNonce(): `0x${string}` {
  return `0x${randomBytes(32).toString('hex')}` as `0x${string}`
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

async function signPayment(
  overrides: Partial<Authorization> = {},
  opts: { signer?: typeof payer; config?: X402Config } = {}
): Promise<string> {
  const config = opts.config ?? CONFIG
  const signer = opts.signer ?? payer
  const authorization: Authorization = {
    from: payer.address,
    to: PAY_TO,
    value: '25000000', // 25 USDT in base units
    validAfter: '0',
    validBefore: String(nowSec() + 3600),
    nonce: randomNonce(),
    ...overrides,
  }
  const signature = await signer.signTypedData({
    domain: {
      name: config.tokenName,
      version: config.tokenVersion,
      chainId: config.chainId,
      verifyingContract: config.tokenAddress,
    },
    types: TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  })
  const payload: PaymentPayload = {
    x402Version: 1,
    scheme: 'exact',
    network: config.network,
    payload: { signature, authorization },
  }
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

let db: Db
let service: MarketService
let app: Hono
let apiKey: string
let accountId: string

function buildApp(config: X402Config): Hono {
  const a = new Hono()
  a.route('/', createDepositRoutes(service, db, { config }))
  return a
}

function deposit(options: {
  amount?: unknown
  key?: string
  payment?: string
} = {}) {
  return app.request('/deposits', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.key ? { Authorization: `Bearer ${options.key}` } : {}),
      ...(options.payment ? { 'X-PAYMENT': options.payment } : {}),
    },
    body: JSON.stringify({ amount: options.amount ?? 25 }),
  })
}

async function json(res: Response) {
  return (await res.json()) as any
}

beforeEach(() => {
  db = openDb(':memory:')
  service = new MarketService(db)
  const created = service.createAccount('depositor-agent')
  apiKey = created.apiKey
  accountId = created.account.id
  app = buildApp(CONFIG)
})

describe('authentication and configuration', () => {
  it('rejects unauthenticated deposit requests with 401', async () => {
    expect((await deposit()).status).toBe(401)
    expect((await deposit({ key: 'pk_bogus' })).status).toBe(401)
  })

  it('returns 503 when X402_PAY_TO is not configured', async () => {
    app = buildApp({ ...CONFIG, payTo: null })
    const res = await deposit({ key: apiKey })
    expect(res.status).toBe(503)
    const body = await json(res)
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/not configured/i)
  })

  it('validates the amount body', async () => {
    expect((await deposit({ key: apiKey, amount: 0 })).status).toBe(400)
    expect((await deposit({ key: apiKey, amount: 200_000 })).status).toBe(400)
    expect((await deposit({ key: apiKey, amount: 'ten' })).status).toBe(400)
  })
})

describe('402 challenge', () => {
  it('returns the x402 v1 challenge with an exact-scheme accepts entry', async () => {
    const res = await deposit({ key: apiKey, amount: 25 })
    expect(res.status).toBe(402)
    const body = await json(res)
    expect(body.x402Version).toBe(1)
    expect(body.error).toBe('payment required')
    expect(body.accepts).toHaveLength(1)
    const req = body.accepts[0]
    expect(req.scheme).toBe('exact')
    expect(req.network).toBe('xlayer')
    expect(req.maxAmountRequired).toBe('25000000')
    expect(req.payTo).toBe(PAY_TO)
    expect(req.asset).toBe(CONFIG.tokenAddress)
    expect(req.mimeType).toBe('application/json')
    expect(req.maxTimeoutSeconds).toBeGreaterThan(0)
    expect(req.resource).toContain('/deposits')
    expect(req.description).toContain(accountId)
    expect(req.extra).toEqual({ name: 'USDT', version: '1' })
  })
})

describe('deposit with a real EIP-3009 signature', () => {
  it('credits the account 1:1 and returns X-PAYMENT-RESPONSE', async () => {
    // Lowercased recipient exercises the case-insensitive payTo comparison.
    const payment = await signPayment({
      to: PAY_TO.toLowerCase() as `0x${string}`,
    })
    const res = await deposit({ key: apiKey, payment })
    expect(res.status).toBe(200)

    const body = await json(res)
    expect(body.success).toBe(true)
    expect(body.data.balance).toBeCloseTo(SIGNUP_GRANT + 25, 6)
    expect(body.data.deposit.accountId).toBe(accountId)
    expect(body.data.deposit.amount).toBe(25)
    expect(body.data.deposit.network).toBe('xlayer')
    expect(body.data.deposit.txNonce).toMatch(/^0x[0-9a-f]{64}$/)

    const responseHeader = res.headers.get('X-PAYMENT-RESPONSE')
    expect(responseHeader).toBeTruthy()
    const settlement = JSON.parse(
      Buffer.from(responseHeader as string, 'base64').toString('utf8')
    )
    expect(settlement.mode).toBe('verify-only')
    expect(settlement.success).toBe(true)
    expect(settlement.payer).toBe(payer.address)

    // Persisted in the deposits ledger.
    const rows = db
      .prepare('SELECT * FROM deposits WHERE account_id = ?')
      .all(accountId) as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0].amount).toBe(25)
  })

  it('rejects a replayed nonce and does not double-credit', async () => {
    const payment = await signPayment()
    expect((await deposit({ key: apiKey, payment })).status).toBe(200)

    const replay = await deposit({ key: apiKey, payment })
    expect(replay.status).toBe(402)
    expect((await json(replay)).error).toMatch(/already used/i)
    expect(service.getAccount(accountId).balance).toBeCloseTo(
      SIGNUP_GRANT + 25,
      6
    )
  })

  it('rejects an expired authorization', async () => {
    const payment = await signPayment({ validBefore: String(nowSec() - 60) })
    const res = await deposit({ key: apiKey, payment })
    expect(res.status).toBe(402)
    expect((await json(res)).error).toMatch(/expired/i)
  })

  it('rejects a not-yet-valid authorization', async () => {
    const payment = await signPayment({ validAfter: String(nowSec() + 3600) })
    const res = await deposit({ key: apiKey, payment })
    expect(res.status).toBe(402)
    expect((await json(res)).error).toMatch(/not yet valid/i)
  })

  it('rejects a payment addressed to the wrong recipient', async () => {
    // Validly signed, but pays someone other than our payTo address.
    const payment = await signPayment({ to: stranger.address })
    const res = await deposit({ key: apiKey, payment })
    expect(res.status).toBe(402)
    expect((await json(res)).error).toMatch(/recipient/i)
  })

  it('rejects a value below the required amount', async () => {
    const payment = await signPayment({ value: '1000000' }) // 1 USDT for 25 credits
    const res = await deposit({ key: apiKey, payment })
    expect(res.status).toBe(402)
    expect((await json(res)).error).toMatch(/below the required/i)
  })

  it('rejects a signature from the wrong signer', async () => {
    // "from" claims payer, but the stranger signed it.
    const payment = await signPayment({}, { signer: stranger })
    const res = await deposit({ key: apiKey, payment })
    expect(res.status).toBe(402)
    expect((await json(res)).error).toMatch(/signature/i)
  })

  it('rejects a signature over a different EIP-712 domain', async () => {
    // Signed for the testnet chain, presented on mainnet config.
    const payment = await signPayment(
      { nonce: randomNonce() },
      { config: { ...CONFIG, chainId: 1952 } }
    )
    const res = await deposit({ key: apiKey, payment })
    expect(res.status).toBe(402)
  })

  it('rejects malformed X-PAYMENT headers with 400', async () => {
    const notB64Json = await deposit({ key: apiKey, payment: '!!!not-a-payment!!!' })
    expect(notB64Json.status).toBe(400)

    const wrongShape = Buffer.from(
      JSON.stringify({ x402Version: 1, scheme: 'exact' })
    ).toString('base64')
    const res = await deposit({ key: apiKey, payment: wrongShape })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toMatch(/malformed x-payment/i)

    const badNonce = Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: 'exact',
        network: 'xlayer',
        payload: {
          signature: `0x${'ab'.repeat(65)}`,
          authorization: {
            from: payer.address,
            to: PAY_TO,
            value: '25000000',
            validAfter: '0',
            validBefore: String(nowSec() + 3600),
            nonce: 'not-hex',
          },
        },
      })
    ).toString('base64')
    expect((await deposit({ key: apiKey, payment: badNonce })).status).toBe(400)
  })
})

describe('nonce lifecycle across failed settlement', () => {
  function nonceCount(): number {
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM x402_nonces')
      .get() as { n: number }
    return row.n
  }

  it('a failed facilitator settlement leaves the nonce reusable; the retry succeeds', async () => {
    // Regression: the nonce used to be burned during verification, BEFORE
    // settlement — a facilitator outage then permanently consumed the
    // client's EIP-3009 authorization without crediting anything.
    let facilitatorUp = false
    const flakyFetch = (async () => {
      if (!facilitatorUp) throw new Error('connect ECONNREFUSED')
      return new Response(
        JSON.stringify({ success: true, transaction: '0xfacade' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }) as typeof fetch

    const facApp = new Hono()
    facApp.route(
      '/',
      createDepositRoutes(service, db, {
        config: { ...CONFIG, facilitatorUrl: 'https://facilitator.example' },
        fetchFn: flakyFetch,
      })
    )
    const send = (payment: string) =>
      facApp.request('/deposits', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'X-PAYMENT': payment,
        },
        body: JSON.stringify({ amount: 25 }),
      })

    const payment = await signPayment()

    // Attempt 1: signature verifies, settlement fails -> 402, NO burn.
    const failed = await send(payment)
    expect(failed.status).toBe(402)
    expect((await json(failed)).error).toMatch(/unreachable/i)
    expect(nonceCount()).toBe(0)
    expect(service.getAccount(accountId).balance).toBeCloseTo(SIGNUP_GRANT, 6)

    // Attempt 2 with the SAME signed payload: facilitator recovered.
    facilitatorUp = true
    const retried = await send(payment)
    expect(retried.status).toBe(200)
    expect((await json(retried)).data.balance).toBeCloseTo(
      SIGNUP_GRANT + 25,
      6
    )
    expect(nonceCount()).toBe(1)

    // Attempt 3: now the nonce really is burned — replay rejected, no credit.
    const replay = await send(payment)
    expect(replay.status).toBe(402)
    expect((await json(replay)).error).toMatch(/already used/i)
    expect(service.getAccount(accountId).balance).toBeCloseTo(
      SIGNUP_GRANT + 25,
      6
    )
  })

  it('burns the nonce atomically with the credit in verify-only mode', async () => {
    const payment = await signPayment()
    expect(nonceCount()).toBe(0)
    expect((await deposit({ key: apiKey, payment })).status).toBe(200)
    expect(nonceCount()).toBe(1)
  })

  it('recordDeposit rolls back the credit when the nonce is already used', async () => {
    const payment = await signPayment()
    expect((await deposit({ key: apiKey, payment })).status).toBe(200)

    // Simulate the race where a concurrent request slipped past the
    // verify-time check: calling recordDeposit directly with the used nonce
    // must throw and must NOT credit the account or write a deposit row.
    const decoded = decodePaymentHeader(payment)
    const auth = decoded.payload.authorization
    expect(() =>
      recordDeposit(db, {
        accountId,
        amount: 25,
        txNonce: auth.nonce.toLowerCase(),
        payer: auth.from,
        network: decoded.network,
      })
    ).toThrowError(/already used/i)
    expect(service.getAccount(accountId).balance).toBeCloseTo(
      SIGNUP_GRANT + 25,
      6
    )
    const deposits = db
      .prepare('SELECT COUNT(*) AS n FROM deposits WHERE account_id = ?')
      .get(accountId) as { n: number }
    expect(deposits.n).toBe(1)
  })
})

describe('settlePayment', () => {
  async function decodedPayment(): Promise<PaymentPayload> {
    return decodePaymentHeader(await signPayment())
  }

  const requirements = () =>
    buildPaymentRequirements({
      amountBaseUnits: 25_000_000n,
      resource: 'http://localhost/deposits',
      description: 'test',
      config: CONFIG,
    })

  it('is explicit about verify-only mode when no facilitator is set', async () => {
    const result = await settlePayment(await decodedPayment(), requirements(), CONFIG)
    expect(result.mode).toBe('verify-only')
    expect(result.success).toBe(true)
    expect(result.transaction).toBeNull()
  })

  it('POSTs to the facilitator /settle endpoint and returns its transaction', async () => {
    const calls: Array<{ url: string; body: any }> = []
    const fakeFetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) })
      return new Response(
        JSON.stringify({ success: true, transaction: '0xdeadbeef' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }) as typeof fetch

    const config: X402Config = {
      ...CONFIG,
      facilitatorUrl: 'https://facilitator.example',
    }
    const payment = await decodedPayment()
    const result = await settlePayment(payment, requirements(), config, fakeFetch)

    expect(result.mode).toBe('facilitator')
    expect(result.transaction).toBe('0xdeadbeef')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://facilitator.example/settle')
    expect(calls[0]!.body.x402Version).toBe(1)
    expect(calls[0]!.body.paymentPayload).toEqual(payment)
    expect(calls[0]!.body.paymentRequirements.maxAmountRequired).toBe('25000000')
  })

  it('fails when the facilitator rejects or is unreachable', async () => {
    const config: X402Config = {
      ...CONFIG,
      facilitatorUrl: 'https://facilitator.example',
    }
    const rejecting = (async () =>
      new Response(JSON.stringify({ success: false, errorReason: 'no funds' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch
    await expect(
      settlePayment(await decodedPayment(), requirements(), config, rejecting)
    ).rejects.toThrowError(X402Error)

    const down = (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as typeof fetch
    await expect(
      settlePayment(await decodedPayment(), requirements(), config, down)
    ).rejects.toThrowError(/unreachable/)
  })
})

describe('getX402Config', () => {
  it('applies mainnet defaults', () => {
    const cfg = getX402Config({})
    expect(cfg.network).toBe('xlayer')
    expect(cfg.chainId).toBe(196)
    expect(cfg.tokenAddress).toBe('0x1E4a5963aBFD975d8c9021ce480b42188849D41d')
    expect(cfg.payTo).toBeNull()
    expect(cfg.tokenName).toBe('USDT')
    expect(cfg.tokenVersion).toBe('1')
    expect(cfg.facilitatorUrl).toBeNull()
  })

  it('supports the testnet network and env overrides', () => {
    const cfg = getX402Config({
      X402_NETWORK: 'xlayer-testnet',
      X402_PAY_TO: PAY_TO,
      X402_TOKEN_NAME: 'USDT0',
      X402_TOKEN_VERSION: '2',
      X402_FACILITATOR_URL: 'https://facilitator.example/',
    })
    expect(cfg.network).toBe('xlayer-testnet')
    expect(cfg.chainId).toBe(1952)
    expect(cfg.payTo).toBe(PAY_TO)
    expect(cfg.tokenName).toBe('USDT0')
    expect(cfg.tokenVersion).toBe('2')
    expect(cfg.facilitatorUrl).toBe('https://facilitator.example')
  })

  it('fails fast on malformed values', () => {
    expect(() => getX402Config({ X402_NETWORK: 'mainnet' })).toThrow(/X402_NETWORK/)
    expect(() => getX402Config({ X402_PAY_TO: 'nope' })).toThrow(/X402_PAY_TO/)
    expect(() =>
      getX402Config({ X402_FACILITATOR_URL: 'ftp://bad' })
    ).toThrow(/http/)
  })
})
