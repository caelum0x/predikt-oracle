// Shared helpers for the Predikt Oracle serverless AI endpoints.

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { OpenRouterError } from './openrouter'

export function methodGuard(
  req: VercelRequest,
  res: VercelResponse,
  method: 'POST' | 'GET'
): boolean {
  // CORS so agents (and browsers) can call the endpoints from anywhere.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return false
  }
  if (req.method !== method) {
    res.setHeader('Allow', method)
    res.status(405).json({ success: false, error: 'Method not allowed.' })
    return false
  }
  return true
}

// Vercel parses JSON bodies, but be defensive about string bodies too.
export function readBody(req: VercelRequest): unknown {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body)
    } catch {
      return null
    }
  }
  return req.body ?? null
}

export function sendAiError(res: VercelResponse, err: unknown): void {
  if (err instanceof OpenRouterError) {
    const status =
      err.status === 500 || err.status === 400
        ? err.status
        : err.status === 504
        ? 504
        : 502
    res.status(status).json({ success: false, error: err.message })
    return
  }
  res.status(500).json({ success: false, error: 'Unexpected server error.' })
}
