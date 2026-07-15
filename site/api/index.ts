// GET /api — agent-readable manifest of the Predikt Oracle A2MCP services
// hosted here (the stateless AI toolkit). The full stateful market/trading API
// lives in the repo and deploys separately.

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { methodGuard } from './_lib/handler'

const MANIFEST = {
  name: 'Predikt Oracle',
  category: 'Finance',
  mode: 'A2MCP',
  description:
    'Agent-native prediction-market toolkit: calibrated probability estimates for future events, market drafting from a topic or news, and cited resolution verdicts. Free endpoints that return the result directly.',
  services: [
    {
      name: 'estimate-odds',
      method: 'POST',
      endpoint: '/api/estimate-odds',
      summary:
        'Calibrated probability for a future event, with base rate, key drivers, update triggers, and cited rationale.',
      input: {
        question: 'string (8-400) — the forecastable question',
        resolutionCriteria: 'string? — how the outcome is judged',
        deadline: 'string? — YYYY-MM-DD the outcome should be known by',
        context: 'string[]? — up to 10 context snippets the model may cite',
      },
      output:
        '{ success, data: { estimate: { probability, confidence, rationale, baseRate, keyDrivers, updateTriggers, citations } } }',
    },
    {
      name: 'draft-market',
      method: 'POST',
      endpoint: '/api/draft-market',
      summary: 'Turn a topic, news text, or URL into 1-5 well-formed market drafts.',
      output: '{ success, data: { drafts: [...] } }',
    },
    {
      name: 'suggest-resolution',
      method: 'POST',
      endpoint: '/api/suggest-resolution',
      summary: 'Proposed verdict (YES/NO/ANSWER/UNCLEAR) with cited rationale for a closed question.',
      output: '{ success, data: { suggestion: {...} } }',
    },
  ],
  links: {
    site: 'https://predikt-oracle.vercel.app',
    repo: 'https://github.com/caelum0x/predikt-oracle',
  },
} as const

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (!methodGuard(req, res, 'GET')) return
  res.status(200).json({ success: true, data: MANIFEST })
}
