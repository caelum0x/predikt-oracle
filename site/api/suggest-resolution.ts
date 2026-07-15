// POST /api/suggest-resolution — proposed verdict (YES/NO/ANSWER/UNCLEAR) with
// a cited rationale for a closed prediction-market question. Advisory only;
// stateless OpenRouter call with validated output.

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { chatCompletion, parseJsonObject } from './_lib/openrouter'
import { buildResolutionMessages } from './_lib/prompts'
import {
  resolutionSuggestionSchema,
  suggestResolutionRequestSchema,
} from './_lib/schema'
import { methodGuard, readBody, sendAiError } from './_lib/handler'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!methodGuard(req, res, 'POST')) return

  const parsedReq = suggestResolutionRequestSchema.safeParse(readBody(req))
  if (!parsedReq.success) {
    res.status(400).json({
      success: false,
      error: parsedReq.error.issues[0]?.message ?? 'Invalid request.',
    })
    return
  }

  let raw: string
  try {
    const messages = buildResolutionMessages(parsedReq.data, new Date().toISOString())
    raw = await chatCompletion({ messages, jsonMode: true, temperature: 0.2 })
  } catch (err) {
    return sendAiError(res, err)
  }

  let parsedJson: unknown
  try {
    parsedJson = parseJsonObject(raw)
  } catch (err) {
    return sendAiError(res, err)
  }

  const result = resolutionSuggestionSchema.safeParse(parsedJson)
  if (!result.success) {
    res.status(502).json({
      success: false,
      error: 'The AI returned an unusable suggestion. Try again.',
    })
    return
  }

  res.status(200).json({ success: true, data: { suggestion: result.data } })
}
