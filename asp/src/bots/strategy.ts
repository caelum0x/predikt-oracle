// Pure, deterministic trading strategy for the liquidity/honesty bot.
// No I/O here: given a market price, a forecast, and a bankroll, decide
// whether (and how much) to trade. Fully unit-tested in test/bot.test.ts.

import { round6 } from '../engine/cpmm'
import type { Position } from '../engine/service'
import type { OddsConfidence } from '../ai/schema'

export type TradeSide = 'YES' | 'NO'

// Kelly-flavoured sizing knobs. Edge is fully "saturated" at 25 points of
// mispricing — beyond that we do not bet more (forecasts are fallible).
const EDGE_SATURATION = 0.25
const DEFAULT_MIN_EDGE = 0.05
const DEFAULT_MAX_STAKE_FRACTION = 0.05
const MIN_STAKE = 1
const MIN_BALANCE = 1
// A held side must gain at least 30% over its average cost to take profit.
const TAKE_PROFIT_GAIN = 0.3
// Shares below this are dust left over from 6dp rounding, not a position.
const DUST_SHARES = 1e-9

const CONFIDENCE_WEIGHTS: Record<OddsConfidence, number> = {
  low: 0.25,
  medium: 0.5,
  high: 1,
}

export type DecideTradeInput = {
  // Current market probability of YES, in (0, 1).
  marketProb: number
  // The forecaster's estimated probability of YES, in (0, 1).
  estimatedProb: number
  confidence: OddsConfidence
  // Spendable balance in PRED credits.
  balance: number
  // Minimum |estimate - market| gap worth acting on.
  minEdge?: number
  // Largest fraction of the balance a single trade may stake.
  maxStakeFraction?: number
}

export type TradeDecision =
  | { action: 'skip'; reason: string }
  | { action: 'buy'; side: TradeSide; amount: number; edge: number }

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Decide whether to buy into a market given a forecast. Deterministic:
 * same inputs always produce the same decision.
 */
export function decideTrade(input: DecideTradeInput): TradeDecision {
  const minEdge = input.minEdge ?? DEFAULT_MIN_EDGE
  const maxStakeFraction = input.maxStakeFraction ?? DEFAULT_MAX_STAKE_FRACTION
  const edge = input.estimatedProb - input.marketProb

  if (Math.abs(edge) < minEdge) {
    return {
      action: 'skip',
      reason: `edge ${edge.toFixed(4)} below minimum ${minEdge}`,
    }
  }
  if (input.balance < MIN_BALANCE) {
    return {
      action: 'skip',
      reason: `balance ${input.balance} below minimum ${MIN_BALANCE}`,
    }
  }

  const side: TradeSide = edge > 0 ? 'YES' : 'NO'
  const weight = CONFIDENCE_WEIGHTS[input.confidence]
  const edgeScale = Math.min(1, Math.abs(edge) / EDGE_SATURATION)
  const stake = round2(input.balance * maxStakeFraction * weight * edgeScale)

  if (stake < MIN_STAKE) {
    return {
      action: 'skip',
      reason: `stake ${stake} below minimum ${MIN_STAKE}`,
    }
  }
  return { action: 'buy', side, amount: stake, edge }
}

export type TakeProfitInput = {
  position: Pick<Position, 'yesShares' | 'noShares' | 'invested'>
  // Current market probability of YES, in (0, 1).
  marketProb: number
}

export type TakeProfitDecision = {
  action: 'sell'
  side: TradeSide
  shares: number
}

/**
 * If a held side's implied per-share value has gained >= 30% versus its
 * average cost (invested / shares), sell half the position (6dp-rounded).
 * Returns null when no side qualifies. YES is evaluated before NO.
 */
export function shouldTakeProfit(
  input: TakeProfitInput
): TakeProfitDecision | null {
  const { position, marketProb } = input
  const sides: { side: TradeSide; shares: number; value: number }[] = [
    { side: 'YES', shares: position.yesShares, value: marketProb },
    { side: 'NO', shares: position.noShares, value: 1 - marketProb },
  ]

  for (const { side, shares, value } of sides) {
    if (shares <= DUST_SHARES) continue
    const avgCost = position.invested / shares
    // A non-positive cost basis means the stake was already recouped by
    // earlier sells — any positive value is pure profit.
    const gained =
      avgCost > 0 ? value / avgCost >= 1 + TAKE_PROFIT_GAIN : value > 0
    if (gained) {
      return { action: 'sell', side, shares: round6(shares / 2) }
    }
  }
  return null
}
