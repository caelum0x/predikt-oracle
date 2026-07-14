// Reputation, calibration, and leaderboard analytics computed from real
// trade/market data. Read-only over the existing tables — no schema changes.
//
// Calibration uses a trade-weighted Brier score: every BUY trade is treated
// as a forecast (the post-trade market probability) weighted by the amount
// staked. Lower is better; 0.25 is the score of always saying 50%.

import type { Db } from './store'
import { round6 } from './cpmm'
import type { Outcome } from './service'

// Accounts need at least this much BUY volume in resolved markets before they
// appear on the Brier leaderboard — tiny samples are pure noise.
export const BRIER_MIN_VOLUME = 50

export type BrierTrade = {
  kind: 'BUY' | 'SELL'
  amount: number
  probAfter: number
}

export type AccountStats = {
  accountId: string
  name: string
  marketsTraded: number
  marketsResolvedTraded: number
  volume: number
  realizedProfit: number
  brierScore: number | null
  marketsCreated: number
  feesEarned: number
}

export type LeaderboardSort = 'profit' | 'brier' | 'volume'

export type LeaderboardEntry = AccountStats & { rank: number }

export type PlatformStats = {
  accounts: number
  markets: number
  openMarkets: number
  resolvedMarkets: number
  totalVolume: number
  totalTrades: number
}

/**
 * Trade-weighted Brier score for one resolved binary market. Each BUY trade's
 * implied forecast of YES is its post-trade probability; weight is the amount
 * staked. SELL trades and CANCEL markets are ignored. Returns null when there
 * is nothing to score.
 */
export function computeBrier(
  trades: readonly BrierTrade[],
  outcome: Outcome
): number | null {
  if (outcome === 'CANCEL') return null
  const o = outcome === 'YES' ? 1 : 0
  let weightedError = 0
  let totalWeight = 0
  for (const trade of trades) {
    if (trade.kind !== 'BUY' || !(trade.amount > 0)) continue
    weightedError += trade.amount * (trade.probAfter - o) ** 2
    totalWeight += trade.amount
  }
  return totalWeight > 0 ? weightedError / totalWeight : null
}

/** Full reputation snapshot for one account, or null if it does not exist. */
export function accountStats(db: Db, accountId: string): AccountStats | null {
  const account = db
    .prepare('SELECT id, name FROM accounts WHERE id = ?')
    .get(accountId) as { id: string; name: string } | undefined
  if (!account) return null

  return {
    accountId: account.id,
    name: account.name,
    marketsTraded: countOf(
      db,
      'SELECT COUNT(DISTINCT market_id) AS n FROM trades WHERE account_id = ?',
      accountId
    ),
    marketsResolvedTraded: countOf(
      db,
      `SELECT COUNT(DISTINCT t.market_id) AS n
         FROM trades t JOIN markets m ON m.id = t.market_id
        WHERE t.account_id = ? AND m.status = 'RESOLVED'`,
      accountId
    ),
    volume: sumOf(
      db,
      "SELECT COALESCE(SUM(amount), 0) AS s FROM trades WHERE account_id = ? AND kind = 'BUY'",
      accountId
    ),
    realizedProfit: realizedProfit(db, accountId),
    brierScore: accountBrier(db, accountId),
    marketsCreated: countOf(
      db,
      'SELECT COUNT(*) AS n FROM markets WHERE creator_id = ?',
      accountId
    ),
    feesEarned: sumOf(
      db,
      `SELECT COALESCE(SUM(t.fee), 0) AS s
         FROM trades t JOIN markets m ON m.id = t.market_id
        WHERE m.creator_id = ?`,
      accountId
    ),
  }
}

/**
 * Ranked accounts. 'profit' and 'volume' sort descending; 'brier' sorts
 * ascending (lower is better) and requires volume >= BRIER_MIN_VOLUME.
 */
export function leaderboard(
  db: Db,
  opts: { by: LeaderboardSort; limit: number }
): LeaderboardEntry[] {
  const limit = clampLimit(opts.limit)
  const ids = db
    .prepare('SELECT id FROM accounts ORDER BY created_at ASC')
    .all() as { id: string }[]

  const stats: AccountStats[] = []
  for (const row of ids) {
    const s = accountStats(db, row.id)
    if (s) stats.push(s)
  }
  return rankStats(stats, opts.by)
    .slice(0, limit)
    .map((s, i) => ({ ...s, rank: i + 1 }))
}

/** Platform-wide totals for the public stats endpoint. */
export function platformStats(db: Db): PlatformStats {
  return {
    accounts: countOf(db, 'SELECT COUNT(*) AS n FROM accounts'),
    markets: countOf(db, 'SELECT COUNT(*) AS n FROM markets'),
    openMarkets: countOf(
      db,
      "SELECT COUNT(*) AS n FROM markets WHERE status = 'OPEN'"
    ),
    resolvedMarkets: countOf(
      db,
      "SELECT COUNT(*) AS n FROM markets WHERE status = 'RESOLVED'"
    ),
    totalVolume: sumOf(db, 'SELECT COALESCE(SUM(volume), 0) AS s FROM markets'),
    totalTrades: countOf(db, 'SELECT COUNT(*) AS n FROM trades'),
  }
}

// ---- internals -------------------------------------------------------------

type ResolvedPositionRow = {
  yes_shares: number
  no_shares: number
  invested: number
  outcome: Outcome
}

// Payout received at resolution — mirrors the engine's settlement rule:
// winning shares pay 1 each; CANCEL refunds the positive net cost basis.
// Positions are not zeroed on resolve, so they reflect final holdings.
function settlementPayout(row: ResolvedPositionRow): number {
  if (row.outcome === 'YES') return row.yes_shares
  if (row.outcome === 'NO') return row.no_shares
  return Math.max(0, row.invested)
}

function realizedProfit(db: Db, accountId: string): number {
  const rows = db
    .prepare(
      `SELECT p.yes_shares, p.no_shares, p.invested, m.outcome
         FROM positions p JOIN markets m ON m.id = p.market_id
        WHERE p.account_id = ? AND m.status = 'RESOLVED'`
    )
    .all(accountId) as ResolvedPositionRow[]

  let profit = 0
  for (const row of rows) profit += settlementPayout(row) - row.invested
  return round6(profit)
}

function accountBrier(db: Db, accountId: string): number | null {
  const rows = db
    .prepare(
      `SELECT t.amount, t.prob_after, m.outcome
         FROM trades t JOIN markets m ON m.id = t.market_id
        WHERE t.account_id = ? AND t.kind = 'BUY'
          AND m.status = 'RESOLVED' AND m.outcome IN ('YES', 'NO')`
    )
    .all(accountId) as { amount: number; prob_after: number; outcome: 'YES' | 'NO' }[]

  let weightedError = 0
  let totalWeight = 0
  for (const row of rows) {
    if (!(row.amount > 0)) continue
    const o = row.outcome === 'YES' ? 1 : 0
    weightedError += row.amount * (row.prob_after - o) ** 2
    totalWeight += row.amount
  }
  return totalWeight > 0 ? round6(weightedError / totalWeight) : null
}

function rankStats(
  stats: readonly AccountStats[],
  by: LeaderboardSort
): AccountStats[] {
  if (by === 'brier') {
    return stats
      .filter((s) => s.brierScore !== null && s.volume >= BRIER_MIN_VOLUME)
      .sort((a, b) => (a.brierScore ?? 0) - (b.brierScore ?? 0))
  }
  if (by === 'volume') {
    return [...stats].sort((a, b) => b.volume - a.volume)
  }
  return [...stats].sort((a, b) => b.realizedProfit - a.realizedProfit)
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 20
  return Math.max(1, Math.min(100, Math.floor(limit)))
}

function countOf(db: Db, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { n: number } | undefined
  return row?.n ?? 0
}

function sumOf(db: Db, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { s: number } | undefined
  return round6(row?.s ?? 0)
}
