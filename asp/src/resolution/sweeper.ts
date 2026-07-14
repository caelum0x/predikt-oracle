// Auto-resolution pipeline for markets past their close time.
//
// ResolutionSweeper.tick():
//   1. marks overdue OPEN markets CLOSED (closing at close_time is
//      lifecycle-correct regardless of any AI outcome),
//   2. picks up to MARKETS_PER_TICK closed markets with no stored suggestion
//      and fewer than MAX_ATTEMPTS failed AI attempts,
//   3. asks the injected completion fn for a resolution suggestion via the
//      shared prompt builder, validates the model output with the shared zod
//      schema, maps the verdict onto this market's shape (BINARY verdicts
//      as-is; MULTI 'ANSWER' text matched case-insensitively to an answer id,
//      unmatched -> UNCLEAR), and stores it.
//
// The sweeper never resolves a market itself — the creator applies the stored
// suggestion via POST /markets/:id/resolve-suggested (src/routes/resolution.ts).

import { z } from 'zod'
import type { Db } from '../engine/store'
import type { Market, MarketService } from '../engine/service'
import { parseJsonObject, type ChatCompletionFn } from '../ai/openrouter'
import { buildResolutionMessages } from '../ai/prompts'
import {
  resolutionSuggestionSchema,
  suggestResolutionRequestSchema,
  type ResolutionSuggestion,
  type ResolutionVerdict,
  type SuggestResolutionRequest,
} from '../ai/schema'

export const MARKETS_PER_TICK = 10
export const MAX_ATTEMPTS = 3
export const DEFAULT_INTERVAL_MS = 60_000

// Prompt-side input caps of suggestResolutionRequestSchema; longer market
// fields are truncated rather than failing the whole suggestion.
const MAX_CRITERIA_LEN = 2000
const MAX_DESCRIPTION_LEN = 4000

const SCHEMA = `
CREATE TABLE IF NOT EXISTS resolution_suggestions (
  market_id   TEXT PRIMARY KEY REFERENCES markets(id),
  verdict     TEXT NOT NULL,              -- YES | NO | ANSWER | UNCLEAR
  answer_id   TEXT,                       -- winning answer id for MULTI 'ANSWER' verdicts
  confidence  REAL NOT NULL,              -- 0..1, as reported by the model
  rationale   TEXT NOT NULL,
  citations   TEXT NOT NULL,              -- JSON array of strings
  model_raw   TEXT NOT NULL,              -- JSON: the validated model output, pre-mapping
  created_at  INTEGER NOT NULL
);

-- Per-market AI failure tracking. A failed market is retried on later ticks
-- until its attempts column reaches the cap; success clears the row.
CREATE TABLE IF NOT EXISTS resolution_attempts (
  market_id   TEXT PRIMARY KEY REFERENCES markets(id),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  updated_at  INTEGER NOT NULL
);
`

/** Idempotently creates the sweeper's tables. Safe to call on every boot. */
export function initResolutionSchema(db: Db): void {
  db.exec(SCHEMA)
}

export type StoredSuggestion = {
  marketId: string
  verdict: ResolutionVerdict
  // The matched winning answer id — only for MULTI 'ANSWER' verdicts.
  answerId: string | null
  confidence: number
  rationale: string
  citations: string[]
  createdAt: number
}

type SuggestionRow = {
  market_id: string
  verdict: ResolutionVerdict
  answer_id: string | null
  confidence: number
  rationale: string
  citations: string
  model_raw: string
  created_at: number
}

const citationsSchema = z.array(z.string())

function parseCitations(json: string): string[] {
  try {
    const result = citationsSchema.safeParse(JSON.parse(json))
    return result.success ? result.data : []
  } catch {
    return []
  }
}

function toStoredSuggestion(row: SuggestionRow): StoredSuggestion {
  return {
    marketId: row.market_id,
    verdict: row.verdict,
    answerId: row.answer_id,
    confidence: row.confidence,
    rationale: row.rationale,
    citations: parseCitations(row.citations),
    createdAt: row.created_at,
  }
}

/** The stored suggestion for a market, or null if none exists yet. */
export function getSuggestion(db: Db, marketId: string): StoredSuggestion | null {
  const row = db
    .prepare('SELECT * FROM resolution_suggestions WHERE market_id = ?')
    .get(marketId) as SuggestionRow | undefined
  return row ? toStoredSuggestion(row) : null
}

/** How many failed AI attempts a market has accumulated (0 if none). */
export function getAttemptCount(db: Db, marketId: string): number {
  const row = db
    .prepare('SELECT attempts FROM resolution_attempts WHERE market_id = ?')
    .get(marketId) as { attempts: number } | undefined
  return row?.attempts ?? 0
}

// The verdict after mapping the model's output onto the market's shape.
type MappedVerdict = {
  verdict: ResolutionVerdict
  answerId: string | null
  rationale: string
}

function unclearWithNote(s: ResolutionSuggestion, note: string): MappedVerdict {
  return {
    verdict: 'UNCLEAR',
    answerId: null,
    rationale: `${s.rationale} [auto-resolution note: ${note}; manual resolution required.]`,
  }
}

/**
 * Maps a validated model suggestion onto this market's outcome space.
 * BINARY: YES/NO/UNCLEAR pass through. MULTI: 'ANSWER' is matched to an
 * answer id by case-insensitive exact text (after trimming); anything that
 * cannot resolve the market becomes UNCLEAR with an explanatory note.
 */
export function mapVerdict(market: Market, s: ResolutionSuggestion): MappedVerdict {
  if (market.outcomeType === 'MULTI') {
    if (s.verdict === 'UNCLEAR') {
      return { verdict: 'UNCLEAR', answerId: null, rationale: s.rationale }
    }
    if (s.verdict !== 'ANSWER') {
      return unclearWithNote(
        s,
        `verdict ${s.verdict} is not valid for a multiple-choice market`
      )
    }
    const wanted = (s.answer ?? '').trim().toLowerCase()
    const match =
      wanted.length > 0
        ? (market.answers ?? []).find(
            (answer) => answer.text.trim().toLowerCase() === wanted
          )
        : undefined
    if (!match) {
      return unclearWithNote(
        s,
        `suggested answer ${JSON.stringify(s.answer ?? '')} did not match any market answer`
      )
    }
    return { verdict: 'ANSWER', answerId: match.id, rationale: s.rationale }
  }
  if (s.verdict === 'YES' || s.verdict === 'NO' || s.verdict === 'UNCLEAR') {
    return { verdict: s.verdict, answerId: null, rationale: s.rationale }
  }
  return unclearWithNote(s, `verdict ${s.verdict} is not valid for a binary market`)
}

// The suggest-resolution request for a market, validated at the boundary.
function toSuggestRequest(market: Market): SuggestResolutionRequest {
  return suggestResolutionRequestSchema.parse({
    question: market.question,
    description:
      market.description.length > 0
        ? market.description.slice(0, MAX_DESCRIPTION_LEN)
        : undefined,
    resolutionCriteria: market.criteria.slice(0, MAX_CRITERIA_LEN),
    outcomeType: market.outcomeType === 'MULTI' ? 'MULTIPLE_CHOICE' : 'BINARY',
    answers:
      market.outcomeType === 'MULTI'
        ? (market.answers ?? []).map((answer) => answer.text)
        : undefined,
  })
}

export type TickResult = {
  // Overdue OPEN markets moved to CLOSED this tick.
  closed: number
  // Suggestions stored this tick.
  suggested: number
  // Markets whose AI attempt failed this tick (retried until MAX_ATTEMPTS).
  failed: number
}

export type ResolutionSweeperOptions = {
  db: Db
  service: MarketService
  complete: ChatCompletionFn
  intervalMs?: number
}

export class ResolutionSweeper {
  private readonly db: Db
  private readonly service: MarketService
  private readonly complete: ChatCompletionFn
  private readonly intervalMs: number
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(options: ResolutionSweeperOptions) {
    this.db = options.db
    this.service = options.service
    this.complete = options.complete
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
    initResolutionSchema(this.db)
  }

  /** Starts the periodic sweep. Idempotent; the timer never blocks exit. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        console.error(
          'resolution sweeper tick failed:',
          err instanceof Error ? err.message : 'unknown error'
        )
      })
    }, this.intervalMs)
    this.timer.unref?.()
  }

  /** Stops the periodic sweep. Idempotent. */
  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** One sweep pass. Exposed for tests and manual triggering. */
  async tick(): Promise<TickResult> {
    // Guard against overlapping passes: with a slow AI provider a tick can
    // outlive the polling interval, and a second concurrent tick would read the
    // same candidates (their suggestions are not yet committed), duplicate AI
    // calls, and double-increment the per-market failure counter.
    if (this.running) return { closed: 0, suggested: 0, failed: 0 }
    this.running = true
    try {
      const now = Date.now()

      // Lifecycle: a market past close_time may no longer be OPEN, whether or
      // not the AI produces anything for it.
      const closed = this.db
        .prepare(
          "UPDATE markets SET status = 'CLOSED' WHERE status = 'OPEN' AND close_time <= ?"
        )
        .run(now).changes

      const candidates = this.db
        .prepare(
          `SELECT m.id FROM markets m
            WHERE m.status = 'CLOSED'
              AND m.close_time <= ?
              AND NOT EXISTS (
                SELECT 1 FROM resolution_suggestions s WHERE s.market_id = m.id
              )
              AND COALESCE(
                (SELECT a.attempts FROM resolution_attempts a WHERE a.market_id = m.id),
                0
              ) < ?
            ORDER BY m.close_time ASC
            LIMIT ?`
        )
        .all(now, MAX_ATTEMPTS, MARKETS_PER_TICK) as { id: string }[]

      let suggested = 0
      let failed = 0
      for (const candidate of candidates) {
        const stored = await this.suggestFor(candidate.id)
        if (stored) suggested += 1
        else failed += 1
      }
      return { closed, suggested, failed }
    } finally {
      this.running = false
    }
  }

  // Generates, validates, maps, and stores one market's suggestion. Any
  // failure (AI error, malformed JSON, schema rejection) is recorded so the
  // market is retried on later ticks up to MAX_ATTEMPTS.
  private async suggestFor(marketId: string): Promise<boolean> {
    try {
      const market = this.service.getMarket(marketId)
      const messages = buildResolutionMessages(
        toSuggestRequest(market),
        new Date().toISOString()
      )
      const raw = await this.complete({
        messages,
        jsonMode: true,
        temperature: 0.2,
      })
      const suggestion = resolutionSuggestionSchema.parse(parseJsonObject(raw))
      const mapped = mapVerdict(market, suggestion)
      this.storeSuggestion(marketId, mapped, suggestion)
      this.db
        .prepare('DELETE FROM resolution_attempts WHERE market_id = ?')
        .run(marketId)
      return true
    } catch (err) {
      this.recordFailure(
        marketId,
        err instanceof Error ? err.message : 'unknown error'
      )
      return false
    }
  }

  private storeSuggestion(
    marketId: string,
    mapped: MappedVerdict,
    modelOutput: ResolutionSuggestion
  ): void {
    this.db
      .prepare(
        `INSERT INTO resolution_suggestions
           (market_id, verdict, answer_id, confidence, rationale, citations,
            model_raw, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(market_id) DO NOTHING`
      )
      .run(
        marketId,
        mapped.verdict,
        mapped.answerId,
        modelOutput.confidence,
        mapped.rationale,
        JSON.stringify(modelOutput.citations),
        JSON.stringify(modelOutput),
        Date.now()
      )
  }

  private recordFailure(marketId: string, message: string): void {
    this.db
      .prepare(
        `INSERT INTO resolution_attempts (market_id, attempts, last_error, updated_at)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(market_id) DO UPDATE SET
           attempts = attempts + 1,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`
      )
      .run(marketId, message.slice(0, 500), Date.now())
  }
}
