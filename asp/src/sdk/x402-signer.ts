// Client-side x402 payment signing (protocol v1, scheme "exact", EIP-3009
// TransferWithAuthorization). Given the payment requirements from a 402
// challenge and a viem account, this builds and signs the typed-data
// authorization and returns the base64 X-PAYMENT header the deposit endpoint
// expects. It is the exact counterpart of the server's verifyPayment: the
// EIP-712 domain, types, and message here must match it field for field.
//
// Runtime deps: viem (typed-data signing) and Web Crypto for the nonce, so it
// works in Node and the browser alike.

import type { LocalAccount } from 'viem'
import type { HexAddress, PaymentRequirements } from './client'

// x402 network -> EVM chain id. Must match the server's NETWORK_DEFAULTS.
export const NETWORK_CHAIN_IDS: Record<string, number> = {
  xlayer: 196,
  'xlayer-testnet': 1952,
}

// EIP-3009 TransferWithAuthorization typed-data struct (matches the server).
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

/** A random 32-byte EIP-3009 nonce as a 0x-prefixed hex string. */
export function randomNonce(): `0x${string}` {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  let hex = '0x'
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex as `0x${string}`
}

function chainIdFor(network: string): number {
  const chainId = NETWORK_CHAIN_IDS[network]
  if (chainId === undefined) {
    throw new Error(
      `Unknown x402 network "${network}"; expected one of ${Object.keys(
        NETWORK_CHAIN_IDS
      ).join(', ')}.`
    )
  }
  return chainId
}

export interface BuildPaymentHeaderInput {
  /** A viem account that can sign typed data (e.g. privateKeyToAccount). */
  account: LocalAccount
  /** The "accepts" entry from the server's 402 challenge. */
  requirements: PaymentRequirements
  /** Payer address; defaults to account.address. */
  from?: HexAddress
  /** Current time in ms (injectable for tests); defaults to Date.now(). */
  now?: number
  /** Authorization lifetime in seconds; defaults to requirements.maxTimeoutSeconds. */
  validForSeconds?: number
  /** Override the amount signed (base units); defaults to the required amount. */
  value?: bigint
  /** Override the nonce (injectable for tests); defaults to a random one. */
  nonce?: `0x${string}`
}

/**
 * Builds and signs the EIP-3009 authorization for a deposit and returns the
 * base64-encoded X-PAYMENT header string. Pass the returned string to
 * `PrediktClient.deposit(amount, header)`.
 */
export async function buildPaymentHeader(
  input: BuildPaymentHeaderInput
): Promise<string> {
  const { account, requirements } = input
  const from = (input.from ?? account.address) as HexAddress
  const nowMs = input.now ?? Date.now()
  const nowSec = Math.floor(nowMs / 1000)

  // validAfter must be strictly before now and validBefore strictly after it
  // (the server rejects the boundaries). Backdate validAfter for clock skew.
  const validAfter = BigInt(Math.max(0, nowSec - 600))
  const lifetime = input.validForSeconds ?? requirements.maxTimeoutSeconds
  const validBefore = BigInt(nowSec + Math.max(1, Math.floor(lifetime)))
  const value = input.value ?? BigInt(requirements.maxAmountRequired)
  const nonce = input.nonce ?? randomNonce()

  const signature = await account.signTypedData({
    domain: {
      name: requirements.extra.name,
      version: requirements.extra.version,
      chainId: chainIdFor(requirements.network),
      verifyingContract: requirements.asset,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from,
      to: requirements.payTo,
      value,
      validAfter,
      validBefore,
      nonce,
    },
  })

  const payment = {
    x402Version: 1,
    scheme: 'exact' as const,
    network: requirements.network,
    payload: {
      signature,
      authorization: {
        from,
        to: requirements.payTo,
        value: value.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  }

  // Base64 in a way that works in Node and the browser.
  const json = JSON.stringify(payment)
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(json, 'utf8').toString('base64')
  }
  // Standards-compliant browser/Workers path: encode UTF-8 bytes explicitly
  // rather than relying on the deprecated `unescape` global.
  return btoa(String.fromCharCode(...new TextEncoder().encode(json)))
}
