// Constant-product market maker (CPMM) for binary markets. Pure math — no I/O,
// no mutation: every function returns a new pool.
//
// Invariant: k = yes^p * no^(1-p), where p is fixed at market creation so
// that equal starting pools (yes = no = subsidy) price YES at the creator's
// initial probability.

export type Pool = {
  // Share reserves held by the AMM.
  yes: number
  no: number
  // The fixed weight chosen at creation (= initial probability).
  p: number
  // The preserved invariant value.
  k: number
}

export type Side = 'YES' | 'NO'

export class CpmmError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CpmmError'
  }
}

// Money and shares are rounded to 6dp to keep values stable across storage.
export function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6
}

function invariant(yes: number, no: number, p: number): number {
  return Math.pow(yes, p) * Math.pow(no, 1 - p)
}

/** Creates a pool funded with `subsidy`, priced at `initialProb`. */
export function initPool(subsidy: number, initialProb: number): Pool {
  if (!Number.isFinite(subsidy) || subsidy <= 0) {
    throw new CpmmError('Subsidy must be a positive amount.')
  }
  if (!Number.isFinite(initialProb) || initialProb <= 0.01 || initialProb >= 0.99) {
    throw new CpmmError('Initial probability must be between 0.01 and 0.99.')
  }
  const yes = subsidy
  const no = subsidy
  const p = initialProb
  return { yes, no, p, k: invariant(yes, no, p) }
}

/** Current price of YES in [0, 1]. */
export function getProb(pool: Pool): number {
  const { yes, no, p } = pool
  return (p * no) / (p * no + (1 - p) * yes)
}

export type BuyResult = {
  // Shares of `side` the buyer receives. Each pays out 1 if `side` wins.
  shares: number
  newPool: Pool
  probAfter: number
}

/**
 * Buys `side` shares with `amount` of currency: the amount enters both
 * reserves, then shares of `side` are removed to restore the invariant.
 */
export function calcBuy(pool: Pool, side: Side, amount: number): BuyResult {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new CpmmError('Trade amount must be positive.')
  }
  const { yes, no, p, k } = pool
  const y = yes + amount
  const n = no + amount

  let newYes: number
  let newNo: number
  let shares: number
  if (side === 'YES') {
    newYes = Math.pow(k / Math.pow(n, 1 - p), 1 / p)
    newNo = n
    shares = y - newYes
  } else {
    newNo = Math.pow(k / Math.pow(y, p), 1 / (1 - p))
    newYes = y
    shares = n - newNo
  }

  if (!Number.isFinite(shares) || shares <= 0) {
    throw new CpmmError('Trade is too small to price.')
  }
  const newPool: Pool = { yes: newYes, no: newNo, p, k }
  return { shares: round6(shares), newPool, probAfter: getProb(newPool) }
}

export type SellResult = {
  // Currency returned to the seller.
  amount: number
  newPool: Pool
  probAfter: number
}

/**
 * Sells `shares` of `side` back to the pool for currency: the shares enter
 * the pool and an amount `m` leaves both reserves such that the invariant
 * holds: (yes + s - m)^p * (no - m)^(1-p) = k for YES (symmetric for NO).
 * Solved by bisection — the residual is strictly decreasing in m.
 */
export function calcSell(pool: Pool, side: Side, shares: number): SellResult {
  if (!Number.isFinite(shares) || shares <= 0) {
    throw new CpmmError('Share amount must be positive.')
  }
  const { yes, no, p, k } = pool
  const yesIn = side === 'YES' ? yes + shares : yes
  const noIn = side === 'NO' ? no + shares : no

  const upper = Math.min(yesIn, noIn)
  const residual = (m: number) => invariant(yesIn - m, noIn - m, p) - k

  let lo = 0
  let hi = upper
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (residual(mid) > 0) lo = mid
    else hi = mid
  }
  const amount = lo

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new CpmmError('Sale is too small to price.')
  }
  const newPool: Pool = { yes: yesIn - amount, no: noIn - amount, p, k }
  return { amount: round6(amount), newPool, probAfter: getProb(newPool) }
}
