// Prompt construction for the Predikt Oracle tools. Server-side only.
//
// draft-market and suggest-resolution ported from predikt
// (oracle/web/lib/ai/prompts.ts); estimate-odds is new for the ASP.

import type { ChatMessage } from './openrouter'
import type {
  DraftMarketRequest,
  EstimateOddsRequest,
  SuggestResolutionRequest,
} from './schema'

const DRAFT_SYSTEM_PROMPT = `You draft prediction-market questions for a forecasting platform.
A good market is objective, has an unambiguous resolution, a clear future close date, and no leading bias.

Return ONLY a JSON object of this exact shape (no prose, no markdown):
{
  "drafts": [
    {
      "question": "A clear yes/no or forecastable question (8-240 chars)",
      "description": "1-3 sentences of neutral context",
      "outcomeType": "BINARY" | "MULTIPLE_CHOICE" | "PSEUDO_NUMERIC" | "MULTI_NUMERIC" | "DATE",
      "answers": ["only for MULTIPLE_CHOICE, 2-8 mutually-exclusive options"],
      "min": 0, "max": 100,          // only for PSEUDO_NUMERIC and MULTI_NUMERIC (min < max)
      "unit": "$",                    // only for MULTI_NUMERIC: the unit of the range (e.g. "$", "%", "seats")
      "dateMin": "2026-01-01",        // only for DATE: earliest date, YYYY-MM-DD
      "dateMax": "2026-12-31",        // only for DATE: latest date, YYYY-MM-DD (dateMin < dateMax)
      "closeTime": 0,                 // epoch MILLISECONDS, a sensible FUTURE date after which the outcome is known
      "category": "Human-readable topic, e.g. Technology",
      "topicSlug": "lowercase-hyphenated-slug",
      "resolutionCriteria": "Exactly how and when this resolves, and the authoritative source"
    }
  ]
}

Choosing outcomeType:
- BINARY: a single yes/no outcome. Prefer this unless the question is naturally multi-outcome or numeric.
- MULTIPLE_CHOICE: a fixed set of 2-8 mutually-exclusive named options (e.g. "Which party wins?").
- PSEUDO_NUMERIC: a single number to estimate within a range (min < max), e.g. a price or count.
- MULTI_NUMERIC: an outcome that is a numeric value falling into a range; give min, max (min < max) and a "unit". The platform builds the numeric buckets — do NOT list answers.
- DATE: an outcome that is a calendar date within a window; give dateMin and dateMax as YYYY-MM-DD (dateMin < dateMax). The platform builds the date buckets — do NOT list answers.

Rules:
- closeTime must be in the future and after the event's outcome is knowable.
- For MULTI_NUMERIC/DATE, omit "answers" — the platform generates the ranges from min/max (or dateMin/dateMax).
- Never invent facts. If a source is vague, make the question about a verifiable future event.
- Questions must be neutral and not assume an outcome.`

export function buildDraftMessages(
  req: DraftMarketRequest,
  nowIso: string
): ChatMessage[] {
  const count = req.count ?? 1
  const parts: string[] = [
    `The current date/time is ${nowIso}. All closeTime values must be after this.`,
    `Produce ${count} distinct, high-quality market draft${
      count > 1 ? 's' : ''
    }.`,
  ]
  if (req.topic) parts.push(`Topic: ${req.topic}`)
  if (req.newsText) parts.push(`Source news text:\n"""${req.newsText}"""`)
  if (req.url)
    parts.push(
      `Source URL (use only the topic implied by it, do not fabricate its contents): ${req.url}`
    )

  return [
    { role: 'system', content: DRAFT_SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n\n') },
  ]
}

const RESOLUTION_SYSTEM_PROMPT = `You assist a human resolver of a prediction market.
You do NOT resolve anything yourself — you propose a verdict with a cited rationale that a human (or an on-chain oracle) will review.

Return ONLY a JSON object of this exact shape (no prose, no markdown):
{
  "verdict": "YES" | "NO" | "ANSWER" | "UNCLEAR",
  "answer": "only when verdict is ANSWER: the winning option text",
  "confidence": 0.0,          // 0..1
  "rationale": "why, referencing the resolution criteria and the provided sources",
  "citations": ["short source references or URLs you relied on"]
}

Rules:
- Use "UNCLEAR" when the provided information is insufficient. Do not guess.
- Only cite sources that were actually provided to you.
- Be concise and objective.`

export function buildResolutionMessages(
  req: SuggestResolutionRequest,
  nowIso: string
): ChatMessage[] {
  const parts: string[] = [
    `The current date/time is ${nowIso}.`,
    `Market question: ${req.question}`,
    `Outcome type: ${req.outcomeType}`,
  ]
  if (req.description) parts.push(`Description: ${req.description}`)
  if (req.resolutionCriteria)
    parts.push(`Resolution criteria: ${req.resolutionCriteria}`)
  if (req.answers && req.answers.length > 0)
    parts.push(`Possible answers: ${req.answers.join(' | ')}`)
  if (req.sources && req.sources.length > 0)
    parts.push(
      `Provided sources:\n${req.sources
        .map((s, i) => `[${i + 1}] ${s}`)
        .join('\n')}`
    )
  else parts.push('No external sources were provided.')

  return [
    { role: 'system', content: RESOLUTION_SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n\n') },
  ]
}

const ODDS_SYSTEM_PROMPT = `You are a calibrated superforecaster estimating the probability of a future event.
Work like a forecaster, not a pundit: start from the OUTSIDE VIEW (a reference class and its base rate), then adjust with the INSIDE VIEW (specifics of this case), and state what would change your mind.

Return ONLY a JSON object of this exact shape (no prose, no markdown):
{
  "probability": 0.5,          // P(YES) in [0.01, 0.99] — never 0 or 1
  "confidence": "low" | "medium" | "high",   // how much evidence supports this estimate
  "rationale": "2-5 sentences: base rate, key adjustments, and the net judgment",
  "baseRate": "the reference class and its historical rate you anchored on",
  "keyDrivers": ["1-8 factors that most move the estimate up or down"],
  "updateTriggers": ["future events that should trigger a re-estimate"],
  "citations": ["only references to context snippets actually provided, e.g. [1]"]
}

Rules:
- "confidence" reflects evidence quality, NOT how extreme the probability is. Thin or conflicting evidence → "low".
- If the question is ambiguous or not objectively resolvable, still answer, but say so in the rationale and use "low" confidence.
- Never invent facts or citations. If no context was provided, reason from general knowledge and leave citations empty.
- Beware of overconfidence: extreme probabilities (<0.05 or >0.95) require strong, specific evidence.`

export function buildOddsMessages(
  req: EstimateOddsRequest,
  nowIso: string
): ChatMessage[] {
  const parts: string[] = [
    `The current date/time is ${nowIso}.`,
    `Question: ${req.question}`,
  ]
  if (req.resolutionCriteria)
    parts.push(`Resolution criteria: ${req.resolutionCriteria}`)
  if (req.deadline)
    parts.push(`The outcome should be known by: ${req.deadline}`)
  if (req.context && req.context.length > 0)
    parts.push(
      `Provided context:\n${req.context
        .map((s, i) => `[${i + 1}] ${s}`)
        .join('\n')}`
    )
  else parts.push('No external context was provided.')

  return [
    { role: 'system', content: ODDS_SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n\n') },
  ]
}
