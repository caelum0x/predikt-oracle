// POST /api/estimate-odds — a calibrated probability estimate for a future
// event. Stateless: validates input, prompts OpenRouter, validates the model
// output, and returns { success, data: { estimate } }. This is the Predikt
// Oracle A2MCP service endpoint listed on OKX.AI (a free endpoint that returns
// the result directly).

import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  chatCompletion,
  parseJsonObject,
} from './_lib/openrouter'
import { buildOddsMessages } from './_lib/prompts'
import { estimateOddsRequestSchema, oddsEstimateSchema } from './_lib/schema'
import { methodGuard, readBody, sendAiError } from './_lib/handler'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!methodGuard(req, res, 'POST')) return

  const parsed = estimateOddsRequestSchema.safeParse(readBody(req))
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid request.',
    })
    return
  }

  let raw: string
  try {
    const messages = buildOddsMessages(parsed.data, new Date().toISOString())
    raw = await chatCompletion({ messages, jsonMode: true, temperature: 0.3 })
  } catch (err) {
    return sendAiError(res, err)
  }

  let parsedJson: unknown
  try {
    parsedJson = parseJsonObject(raw)
  } catch (err) {
    return sendAiError(res, err)
  }

  const result = oddsEstimateSchema.safeParse(parsedJson)
  if (!result.success) {
    res.status(502).json({
      success: false,
      error: 'The AI returned an unusable estimate. Try again.',
    })
    return
  }

  res.status(200).json({ success: true, data: { estimate: result.data } })
}
