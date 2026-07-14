// x402 payment configuration. All values come from the environment so no
// secrets or addresses are hardcoded into deploys; sensible per-network
// defaults are provided for the USDT contract. Payments run in "paid mode"
// only when X402_PAY_TO (the receiving address) is configured.

export type X402Network = 'xlayer' | 'xlayer-testnet'

export type HexAddress = `0x${string}`

export type X402Config = {
  network: X402Network
  chainId: number
  /** ERC-20 (EIP-3009 capable) token contract used for deposits. */
  tokenAddress: HexAddress
  /** Receiving address for deposits. null => payments not configured (503). */
  payTo: HexAddress | null
  /** EIP-712 domain name of the token contract. */
  tokenName: string
  /** EIP-712 domain version of the token contract. */
  tokenVersion: string
  /** Optional x402 facilitator base URL; unset => verify-only launch mode. */
  facilitatorUrl: string | null
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

const NETWORK_DEFAULTS: Record<
  X402Network,
  { chainId: number; tokenAddress: HexAddress }
> = {
  // X Layer mainnet USDT.
  xlayer: {
    chainId: 196,
    tokenAddress: '0x1E4a5963aBFD975d8c9021ce480b42188849D41d',
  },
  // X Layer testnet USDT0.
  'xlayer-testnet': {
    chainId: 1952,
    tokenAddress: '0xcb8bf24c6ce16ad21d707c9505421a17f2bec79d',
  },
}

function isNetwork(value: string): value is X402Network {
  return value === 'xlayer' || value === 'xlayer-testnet'
}

function readAddress(
  raw: string | undefined,
  envName: string
): HexAddress | null {
  const trimmed = raw?.trim() ?? ''
  if (!trimmed) return null
  if (!ADDRESS_RE.test(trimmed)) {
    throw new Error(
      `${envName} must be a 0x-prefixed 20-byte hex address, got "${trimmed}".`
    )
  }
  return trimmed as HexAddress
}

function readFacilitatorUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? ''
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`X402_FACILITATOR_URL is not a valid URL: "${trimmed}".`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('X402_FACILITATOR_URL must use http or https.')
  }
  return trimmed.replace(/\/+$/, '')
}

/**
 * Build the x402 config from environment variables (injectable for tests).
 * Throws on malformed values so misconfiguration fails fast at startup;
 * a merely *absent* X402_PAY_TO yields payTo=null (deposits return 503).
 */
export function getX402Config(
  env: Record<string, string | undefined> = process.env
): X402Config {
  const rawNetwork = env.X402_NETWORK?.trim() || 'xlayer'
  if (!isNetwork(rawNetwork)) {
    throw new Error(
      `X402_NETWORK must be "xlayer" or "xlayer-testnet", got "${rawNetwork}".`
    )
  }
  const defaults = NETWORK_DEFAULTS[rawNetwork]
  return {
    network: rawNetwork,
    chainId: defaults.chainId,
    tokenAddress:
      readAddress(env.X402_TOKEN_ADDRESS, 'X402_TOKEN_ADDRESS') ??
      defaults.tokenAddress,
    payTo: readAddress(env.X402_PAY_TO, 'X402_PAY_TO'),
    tokenName: env.X402_TOKEN_NAME?.trim() || 'USDT',
    tokenVersion: env.X402_TOKEN_VERSION?.trim() || '1',
    facilitatorUrl: readFacilitatorUrl(env.X402_FACILITATOR_URL),
  }
}
