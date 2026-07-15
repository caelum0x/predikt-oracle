// POST /api/draft-market — turn a topic, news text, or URL into 1-5 well-formed
// prediction-market drafts. Stateless OpenRouter call; model output validated.

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { chatCompletion, parseJsonObject } from './_lib/openrouter'
import { buildDraftMessages } from './_lib/prompts'
import {
  draftMarketRequestSchema,
  draftMarketSchema,
  normalizeCloseTime,
  type DraftMarket,
} from './_lib/schema'
import { methodGuard, readBody, sendAiError } from './_lib/handler'

function extractRawDrafts(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') {
    const maybe = (parsed as { drafts?: unknown }).drafts
    if (Array.isArray(maybe)) return maybe
    return [parsed]
  }
  return []
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!methodGuard(req, res, 'POST')) return

  const parsedReq = draftMarketRequestSchema.safeParse(readBody(req))
  if (!parsedReq.success) {
    res.status(400).json({
      success: false,
      error: parsedReq.error.issues[0]?.message ?? 'Invalid request. Add a source.',
    })
    return
  }

  const now = new Date()
  let raw: string
  try {
    const messages = buildDraftMessages(parsedReq.data, now.toISOString())
    raw = await chatCompletion({ messages, jsonMode: true, temperature: 0.5 })
  } catch (err) {
    return sendAiError(res, err)
  }

  let parsedJson: unknown
  try {
    parsedJson = parseJsonObject(raw)
  } catch (err) {
    return sendAiError(res, err)
  }

  const drafts: DraftMarket[] = []
  for (const candidate of extractRawDrafts(parsedJson)) {
    const result = draftMarketSchema.safeParse(candidate)
    if (result.success) drafts.push(normalizeCloseTime(result.data, now.getTime()))
  }

  if (drafts.length === 0) {
    res.status(502).json({
      success: false,
      error: 'The AI did not return a usable market. Try rephrasing.',
    })
    return
  }

  res.status(200).json({ success: true, data: { drafts } })
}
