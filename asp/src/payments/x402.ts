// x402 protocol v1, scheme "exact", EVM/EIP-3009 (TransferWithAuthorization).
// A client signs a typed-data authorization to transfer USDT to our payTo
// address and sends it base64-encoded in the X-PAYMENT header. We verify the
// signature off-chain with viem, burn the nonce to prevent replay, and either
// settle through a facilitator or accept in explicit verify-only launch mode.

import { verifyTypedData } from 'viem'
import { z } from 'zod'
import type { Db } from '../engine/store'
import { newId } from '../engine/ids'
import type { HexAddress, X402Config, X402Network } from './config'

export const X402_VERSION = 1
export const MAX_TIMEOUT_SECONDS = 600

export class X402Error extends Error {
  readonly status: 400 | 402 | 503
  constructor(status: 400 | 402 | 503, message: string) {
    super(message)
    this.name = 'X402Error'
    this.status = status
  }
}

// ---- schema (nonce replay + deposit ledger) --------------------------------

const X402_SCHEMA = `
CREATE TABLE IF NOT EXISTS x402_nonces (
  nonce      TEXT PRIMARY KEY,
  from_addr  TEXT NOT NULL,
  used_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deposits (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  amount      REAL NOT NULL,
  tx_nonce    TEXT NOT NULL,
  network     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deposits_account ON deposits(account_id);
`

export function initX402Schema(db: Db): void {
  db.exec(X402_SCHEMA)
}

// ---- payment requirements ("accepts" entry) --------------------------------

export type PaymentRequirements = {
  scheme: 'exact'
  network: X402Network
  maxAmountRequired: string
  resource: string
  description: string
  mimeType: 'application/json'
  payTo: HexAddress
  maxTimeoutSeconds: number
  asset: HexAddress
  extra: { name: string; version: string }
}

export function buildPaymentRequirements(input: {
  amountBaseUnits: bigint
  resource: string
  description: string
  config: X402Config
}): PaymentRequirements {
  const { amountBaseUnits, resource, description, config } = input
  if (!config.payTo) {
    throw new X402Error(
      503,
      'Payments are not configured: X402_PAY_TO is unset.'
    )
  }
  if (amountBaseUnits <= 0n) {
    throw new X402Error(400, 'Payment amount must be positive.')
  }
  return {
    scheme: 'exact',
    network: config.network,
    maxAmountRequired: amountBaseUnits.toString(),
    resource,
    description,
    mimeType: 'application/json',
    payTo: config.payTo,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    asset: config.tokenAddress,
    extra: { name: config.tokenName, version: config.tokenVersion },
  }
}

// ---- X-PAYMENT header decoding ----------------------------------------------

const hexAddressSchema = z.custom<HexAddress>(
  (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v),
  'Expected a 0x-prefixed 20-byte hex address.'
)

const hex32Schema = z.custom<`0x${string}`>(
  (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v),
  'Expected a 0x-prefixed 32-byte hex value.'
)

const signatureSchema = z.custom<`0x${string}`>(
  (v) => typeof v === 'string' && /^0x([0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(v),
  'Expected a 0x-prefixed 64/65-byte hex signature.'
)

const uintStringSchema = z
  .string()
  .regex(/^\d+$/, 'Expected an unsigned integer string.')

const paymentPayloadSchema = z
  .object({
    x402Version: z.literal(X402_VERSION),
    scheme: z.literal('exact'),
    network: z.enum(['xlayer', 'xlayer-testnet']),
    payload: z
      .object({
        signature: signatureSchema,
        authorization: z
          .object({
            from: hexAddressSchema,
            to: hexAddressSchema,
            value: uintStringSchema,
            validAfter: uintStringSchema,
            validBefore: uintStringSchema,
            nonce: hex32Schema,
          })
          .strict(),
      })
      .strict(),
  })
  .strict()

export type PaymentPayload = z.infer<typeof paymentPayloadSchema>

export function decodePaymentHeader(headerValue: string): PaymentPayload {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'))
  } catch {
    throw new X402Error(
      400,
      'Malformed X-PAYMENT header: expected base64-encoded JSON.'
    )
  }
  const result = paymentPayloadSchema.safeParse(parsedJson)
  if (!result.success) {
    const issue = result.error.issues[0]
    const at = issue?.path.length ? ` at ${issue.path.join('.')}` : ''
    throw new X402Error(
      400,
      `Malformed X-PAYMENT header${at}: ${issue?.message ?? 'invalid payload.'}`
    )
  }
  return result.data
}

// ---- verification (EIP-3009 typed-data signature + replay protection) ------

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

export type VerifiedPayment = {
  payer: HexAddress
  nonce: string
  value: string
}

export async function verifyPayment(
  db: Db,
  payment: PaymentPayload,
  requirements: PaymentRequirements,
  config: X402Config,
  nowMs: number = Date.now()
): Promise<VerifiedPayment> {
  const auth = payment.payload.authorization

  if (payment.network !== requirements.network) {
    throw new X402Error(
      402,
      `Payment network "${payment.network}" does not match required network "${requirements.network}".`
    )
  }
  if (auth.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
    throw new X402Error(
      402,
      `Payment recipient ${auth.to} does not match required payTo ${requirements.payTo}.`
    )
  }
  if (BigInt(auth.value) < BigInt(requirements.maxAmountRequired)) {
    throw new X402Error(
      402,
      `Payment value ${auth.value} is below the required ${requirements.maxAmountRequired} base units.`
    )
  }

  const nowSec = Math.floor(nowMs / 1000)
  if (nowSec <= Number(BigInt(auth.validAfter))) {
    throw new X402Error(402, 'Payment authorization is not yet valid.')
  }
  if (nowSec >= Number(BigInt(auth.validBefore))) {
    throw new X402Error(402, 'Payment authorization has expired.')
  }

  const used = db
    .prepare('SELECT nonce FROM x402_nonces WHERE nonce = ?')
    .get(auth.nonce.toLowerCase())
  if (used) {
    throw new X402Error(402, 'Payment authorization nonce was already used.')
  }

  let valid = false
  try {
    valid = await verifyTypedData({
      address: auth.from,
      domain: {
        name: config.tokenName,
        version: config.tokenVersion,
        chainId: config.chainId,
        verifyingContract: config.tokenAddress,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
      signature: payment.payload.signature,
    })
  } catch {
    valid = false
  }
  if (!valid) {
    throw new X402Error(
      402,
      'Payment signature is invalid: recovered signer does not match "from".'
    )
  }

  // Burn the nonce. The PRIMARY KEY makes this race-safe: a concurrent
  // duplicate insert fails and is reported as a replay.
  try {
    db.prepare(
      'INSERT INTO x402_nonces (nonce, from_addr, used_at) VALUES (?, ?, ?)'
    ).run(auth.nonce.toLowerCase(), auth.from.toLowerCase(), nowMs)
  } catch {
    throw new X402Error(402, 'Payment authorization nonce was already used.')
  }

  return { payer: auth.from, nonce: auth.nonce.toLowerCase(), value: auth.value }
}

// ---- settlement -------------------------------------------------------------

export type SettlementResult = {
  mode: 'verify-only' | 'facilitator'
  success: true
  network: X402Network
  payer: HexAddress
  nonce: string
  transaction: string | null
}

/**
 * Settle a verified payment. With a facilitator configured we POST to its
 * /settle endpoint and require success. Without one, the deposit is accepted
 * on signature verification alone — the explicit "verify-only" launch mode.
 */
export async function settlePayment(
  payment: PaymentPayload,
  requirements: PaymentRequirements,
  config: X402Config,
  fetchFn: typeof fetch = fetch
): Promise<SettlementResult> {
  const auth = payment.payload.authorization
  const base = {
    network: payment.network,
    payer: auth.from,
    nonce: auth.nonce.toLowerCase(),
  }

  if (!config.facilitatorUrl) {
    return { mode: 'verify-only', success: true, transaction: null, ...base }
  }

  let response: Response
  try {
    response = await fetchFn(`${config.facilitatorUrl}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        x402Version: X402_VERSION,
        paymentPayload: payment,
        paymentRequirements: requirements,
      }),
    })
  } catch (err) {
    console.error(
      'x402 facilitator unreachable:',
      err instanceof Error ? err.message : 'unknown error'
    )
    throw new X402Error(402, 'Payment settlement failed: facilitator unreachable.')
  }

  if (!response.ok) {
    throw new X402Error(
      402,
      `Payment settlement failed: facilitator returned HTTP ${response.status}.`
    )
  }

  let body: { success?: boolean; errorReason?: string; transaction?: string }
  try {
    body = (await response.json()) as typeof body
  } catch {
    throw new X402Error(402, 'Payment settlement failed: invalid facilitator response.')
  }
  if (body.success !== true) {
    throw new X402Error(
      402,
      `Payment settlement failed: ${body.errorReason ?? 'facilitator rejected the payment.'}`
    )
  }

  return {
    mode: 'facilitator',
    success: true,
    transaction: typeof body.transaction === 'string' ? body.transaction : null,
    ...base,
  }
}

export function buildPaymentResponseHeader(result: SettlementResult): string {
  return Buffer.from(JSON.stringify(result), 'utf8').toString('base64')
}

// ---- deposit ledger ----------------------------------------------------------

export type DepositRecord = {
  id: string
  accountId: string
  amount: number
  txNonce: string
  network: X402Network
  createdAt: number
}

/**
 * Credit a verified + settled deposit: bumps the account balance and records
 * the deposit row atomically.
 */
export function recordDeposit(
  db: Db,
  input: {
    accountId: string
    amount: number
    txNonce: string
    network: X402Network
  }
): DepositRecord {
  const run = db.transaction((): DepositRecord => {
    const id = newId('dep')
    const now = Date.now()
    const updated = db
      .prepare('UPDATE accounts SET balance = ROUND(balance + ?, 6) WHERE id = ?')
      .run(input.amount, input.accountId)
    if (updated.changes !== 1) {
      throw new X402Error(400, 'Deposit account not found.')
    }
    db.prepare(
      `INSERT INTO deposits (id, account_id, amount, tx_nonce, network, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, input.accountId, input.amount, input.txNonce, input.network, now)
    return {
      id,
      accountId: input.accountId,
      amount: input.amount,
      txNonce: input.txNonce,
      network: input.network,
      createdAt: now,
    }
  })
  return run()
}
