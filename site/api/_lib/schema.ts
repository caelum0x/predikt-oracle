// Zod schemas and types for the Predikt Oracle tools. Model output is never
// trusted raw — every response is validated here before it reaches a caller.
//
// draft-market and suggest-resolution ported from predikt
// (oracle/web/lib/ai/schema.ts); estimate-odds is new for the ASP.

import { z } from 'zod'

// Outcome types a draft may use:
//   BINARY          — yes/no.
//   MULTIPLE_CHOICE — 2..12 mutually-exclusive text answers.
//   PSEUDO_NUMERIC  — a single numeric estimate in a [min, max] range.
//   MULTI_NUMERIC   — a numeric range (min < max) with a unit.
//   DATE            — a date range (dateMin < dateMax, ISO YYYY-MM-DD).
export const AI_OUTCOME_TYPES = [
  'BINARY',
  'MULTIPLE_CHOICE',
  'PSEUDO_NUMERIC',
  'MULTI_NUMERIC',
  'DATE',
] as const

export type AiOutcomeType = (typeof AI_OUTCOME_TYPES)[number]

// ISO calendar date (YYYY-MM-DD) used for DATE-range drafts.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// The maximum future close time we accept from the model (roughly 5 years).
const MAX_CLOSE_HORIZON_MS = 5 * 365 * 24 * 60 * 60 * 1000

export const draftMarketSchema = z
  .object({
    question: z.string().trim().min(8).max(240),
    description: z.string().trim().max(4000).default(''),
    outcomeType: z.enum(AI_OUTCOME_TYPES),
    // Present for MULTIPLE_CHOICE. Deduped/validated in refine below.
    answers: z.array(z.string().trim().min(1).max(120)).max(12).optional(),
    // Epoch millis. Must be in the future; clamped/normalized after parse.
    closeTime: z.number().finite(),
    category: z.string().trim().min(2).max(60),
    topicSlug: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]+$/)
      .min(2)
      .max(60),
    resolutionCriteria: z.string().trim().min(10).max(2000),
    // Numeric range — meaningful for PSEUDO_NUMERIC and MULTI_NUMERIC.
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    // Unit of the numeric range (e.g. "$", "%", "seats") — for MULTI_NUMERIC.
    unit: z.string().trim().min(1).max(20).optional(),
    // Date range as ISO calendar dates (YYYY-MM-DD) — for DATE.
    dateMin: z.string().trim().regex(ISO_DATE_RE).optional(),
    dateMax: z.string().trim().regex(ISO_DATE_RE).optional(),
  })
  .superRefine((draft, ctx) => {
    if (draft.outcomeType === 'MULTIPLE_CHOICE') {
      const answers = (draft.answers ?? []).filter((a) => a.length > 0)
      const unique = new Set(answers.map((a) => a.toLowerCase()))
      if (answers.length < 2 || unique.size < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['answers'],
          message:
            'MULTIPLE_CHOICE markets need at least two distinct answers.',
        })
      }
    }
    if (
      draft.outcomeType === 'PSEUDO_NUMERIC' ||
      draft.outcomeType === 'MULTI_NUMERIC'
    ) {
      if (
        typeof draft.min !== 'number' ||
        typeof draft.max !== 'number' ||
        draft.min >= draft.max
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['max'],
          message: `${draft.outcomeType} markets need a numeric min and max with min < max.`,
        })
      }
    }
    if (draft.outcomeType === 'MULTI_NUMERIC') {
      if (!draft.unit || draft.unit.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['unit'],
          message: 'MULTI_NUMERIC markets need a unit for the numeric range.',
        })
      }
    }
    if (draft.outcomeType === 'DATE') {
      const min = draft.dateMin ? Date.parse(draft.dateMin) : NaN
      const max = draft.dateMax ? Date.parse(draft.dateMax) : NaN
      if (Number.isNaN(min) || Number.isNaN(max) || min >= max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dateMax'],
          message:
            'DATE markets need dateMin and dateMax as YYYY-MM-DD with dateMin < dateMax.',
        })
      }
    }
  })

export type DraftMarket = z.infer<typeof draftMarketSchema>

// Request body for the draft-market tool. At least one source is required.
export const draftMarketRequestSchema = z
  .object({
    topic: z.string().trim().max(400).optional(),
    newsText: z.string().trim().max(8000).optional(),
    url: z.string().trim().url().max(2000).optional(),
    count: z.number().int().min(1).max(5).optional(),
  })
  .refine((body) => !!(body.topic || body.newsText || body.url), {
    message: 'Provide a topic, some news text, or a URL.',
  })

export type DraftMarketRequest = z.infer<typeof draftMarketRequestSchema>

/**
 * Normalizes a validated draft's closeTime into a sensible future epoch-ms
 * value. Immutable: returns a new object, never mutates the input.
 */
export function normalizeCloseTime(
  draft: DraftMarket,
  now = Date.now()
): DraftMarket {
  const min = now + 60 * 60 * 1000 // at least an hour out
  const max = now + MAX_CLOSE_HORIZON_MS
  const fallback = now + 30 * 24 * 60 * 60 * 1000 // 30 days default
  let closeTime = draft.closeTime
  if (!Number.isFinite(closeTime) || closeTime < min) closeTime = fallback
  if (closeTime > max) closeTime = max
  return { ...draft, closeTime }
}

// ---- Resolution suggestion (assistant for the resolver) ------------------

export const RESOLUTION_VERDICTS = ['YES', 'NO', 'ANSWER', 'UNCLEAR'] as const
export type ResolutionVerdict = (typeof RESOLUTION_VERDICTS)[number]

export const suggestResolutionRequestSchema = z.object({
  question: z.string().trim().min(4).max(400),
  description: z.string().trim().max(4000).optional(),
  outcomeType: z.enum(AI_OUTCOME_TYPES).default('BINARY'),
  answers: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  resolutionCriteria: z.string().trim().max(2000).optional(),
  sources: z.array(z.string().trim().max(4000)).max(10).optional(),
})

export type SuggestResolutionRequest = z.infer<
  typeof suggestResolutionRequestSchema
>

export const resolutionSuggestionSchema = z.object({
  verdict: z.enum(RESOLUTION_VERDICTS),
  // Present when verdict === 'ANSWER' (multiple choice).
  answer: z.string().trim().max(200).optional(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().trim().min(10).max(2000),
  citations: z.array(z.string().trim().max(500)).max(10).default([]),
})

export type ResolutionSuggestion = z.infer<typeof resolutionSuggestionSchema>

// ---- Odds estimation (new for the ASP) ------------------------------------

// Request: a forecastable question, optionally with resolution criteria,
// a deadline, and caller-provided context snippets the model may cite.
export const estimateOddsRequestSchema = z.object({
  question: z.string().trim().min(8).max(400),
  resolutionCriteria: z.string().trim().max(2000).optional(),
  // ISO calendar date the outcome should be known by.
  deadline: z
    .string()
    .trim()
    .regex(ISO_DATE_RE, 'deadline must be YYYY-MM-DD')
    .optional(),
  context: z.array(z.string().trim().min(1).max(4000)).max(10).optional(),
})

export type EstimateOddsRequest = z.infer<typeof estimateOddsRequestSchema>

export const ODDS_CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const
export type OddsConfidence = (typeof ODDS_CONFIDENCE_LEVELS)[number]

export const oddsEstimateSchema = z.object({
  // P(YES) in [0.01, 0.99] — a calibrated forecaster never says 0 or 1.
  probability: z.number().min(0.01).max(0.99),
  confidence: z.enum(ODDS_CONFIDENCE_LEVELS),
  rationale: z.string().trim().min(10).max(2000),
  // The outside-view starting point the estimate anchors on.
  baseRate: z.string().trim().min(4).max(500),
  // Factors that most move the estimate up or down.
  keyDrivers: z.array(z.string().trim().min(2).max(300)).min(1).max(8),
  // Future events that should trigger a re-estimate.
  updateTriggers: z.array(z.string().trim().min(2).max(300)).max(8).default([]),
  // Citations into the caller-provided context, when used.
  citations: z.array(z.string().trim().max(500)).max(10).default([]),
})

export type OddsEstimate = z.infer<typeof oddsEstimateSchema>
