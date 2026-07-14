// MCP tool registrations for the Predikt Oracle ASP. Every capability of the
// prediction market — accounts, markets, trading, resolution, and the three
// AI assistants — is exposed as a typed MCP tool so any MCP client (Claude,
// Codex, OKX OnchainOS agents) can use the market natively.
//
// Auth model: stdio MCP has no HTTP headers, so authenticated tools take the
// caller's apiKey as an explicit input, mirroring the Bearer key used by the
// HTTP routes. Keys are hashed at rest and never echoed back.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  MarketService,
  ServiceError,
  type Account,
} from '../engine/service'
import {
  OpenRouterError,
  parseJsonObject,
  type ChatCompletionFn,
} from '../ai/openrouter'
import {
  buildDraftMessages,
  buildOddsMessages,
  buildResolutionMessages,
} from '../ai/prompts'
import {
  AI_OUTCOME_TYPES,
  draftMarketRequestSchema,
  draftMarketSchema,
  estimateOddsRequestSchema,
  normalizeCloseTime,
  oddsEstimateSchema,
  resolutionSuggestionSchema,
  suggestResolutionRequestSchema,
  type DraftMarket,
} from '../ai/schema'

export type PrediktToolDeps = {
  service: MarketService
  complete: ChatCompletionFn
}

// ---- tool result helpers ---------------------------------------------------

type TextContent = { type: 'text'; text: string }
type ToolResult = { content: TextContent[]; isError?: boolean }

function toolResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] }
}

function toolError(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

// Runs a tool body and maps every known failure mode to isError content so
// MCP clients always get a readable message instead of a protocol crash.
async function safely(fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ServiceError) return toolError(err.message)
    if (err instanceof OpenRouterError) return toolError(err.message)
    if (err instanceof z.ZodError) {
      return toolError(err.issues[0]?.message ?? 'Invalid input.')
    }
    console.error(
      'predikt MCP tool unexpected error:',
      err instanceof Error ? err.message : 'unknown error'
    )
    return toolError('Unexpected server error.')
  }
}

function requireAccount(service: MarketService, apiKey: string): Account {
  const account = service.getAccountByKey(apiKey)
  if (!account) {
    throw new ServiceError(401, 'Invalid API key. Create an account with predikt_create_account.')
  }
  return account
}

// ---- shared input fragments --------------------------------------------—--

const apiKeyInput = z
  .string()
  .min(8)
  .describe('Your Predikt API key (returned once by predikt_create_account).')

const marketIdInput = z.string().min(1).describe('Market id, e.g. mkt_...')

const sideInput = z.enum(['YES', 'NO']).describe('Which side of the market.')

// ---- AI tool flows (mirror the HTTP tool routes in app.ts) -----------------

// The model may return {drafts:[...]}, a bare array, or a single object.
function extractRawDrafts(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') {
    const maybe = (parsed as { drafts?: unknown }).drafts
    if (Array.isArray(maybe)) return maybe
    return [parsed]
  }
  return []
}

async function runDraftMarket(
  complete: ChatCompletionFn,
  request: unknown
): Promise<{ drafts: DraftMarket[] }> {
  const req = draftMarketRequestSchema.parse(request)
  const now = new Date()
  const raw = await complete({
    messages: buildDraftMessages(req, now.toISOString()),
    jsonMode: true,
    temperature: 0.5,
  })
  const parsed = parseJsonObject(raw)

  // Validate each draft; anything malformed is dropped, never repaired.
  const drafts: DraftMarket[] = []
  for (const candidate of extractRawDrafts(parsed)) {
    const result = draftMarketSchema.safeParse(candidate)
    if (result.success) drafts.push(normalizeCloseTime(result.data, now.getTime()))
  }
  if (drafts.length === 0) {
    throw new OpenRouterError('The AI did not return a usable market. Try rephrasing.', 502)
  }
  return { drafts }
}

async function runEstimateOdds(complete: ChatCompletionFn, request: unknown) {
  const req = estimateOddsRequestSchema.parse(request)
  const raw = await complete({
    messages: buildOddsMessages(req, new Date().toISOString()),
    jsonMode: true,
    temperature: 0.3,
  })
  const result = oddsEstimateSchema.safeParse(parseJsonObject(raw))
  if (!result.success) {
    throw new OpenRouterError('The AI returned an unusable estimate. Try again.', 502)
  }
  return { estimate: result.data }
}

async function runSuggestResolution(complete: ChatCompletionFn, request: unknown) {
  const req = suggestResolutionRequestSchema.parse(request)
  const raw = await complete({
    messages: buildResolutionMessages(req, new Date().toISOString()),
    jsonMode: true,
    temperature: 0.2,
  })
  const result = resolutionSuggestionSchema.safeParse(parseJsonObject(raw))
  if (!result.success) {
    throw new OpenRouterError('The AI returned an unusable suggestion. Try again.', 502)
  }
  return { suggestion: result.data }
}

// ---- registration -----------------------------------------------------------

export function registerPrediktTools(server: McpServer, deps: PrediktToolDeps): void {
  const { service, complete } = deps

  server.registerTool(
    'predikt_create_account',
    {
      title: 'Create Predikt account',
      description:
        'Create a trading account on the Predikt Oracle prediction market. ' +
        'Returns the account and an apiKey — shown ONCE, save it. New accounts ' +
        'start with a 1000 PRED play-money grant.',
      inputSchema: {
        name: z.string().trim().min(2).max(80).describe('Display name, 2-80 chars.'),
      },
    },
    async ({ name }) => safely(() => toolResult(service.createAccount(name)))
  )

  server.registerTool(
    'predikt_get_balance',
    {
      title: 'Get balance and positions',
      description:
        'Look up your account balance and all open positions using your apiKey.',
      inputSchema: { apiKey: apiKeyInput },
    },
    async ({ apiKey }) =>
      safely(() => {
        const account = requireAccount(service, apiKey)
        return toolResult({
          account: service.getAccount(account.id),
          positions: service.getPositions(account.id),
        })
      })
  )

  server.registerTool(
    'predikt_list_markets',
    {
      title: 'List markets',
      description:
        'Browse prediction markets, optionally filtered by status (OPEN, CLOSED, RESOLVED). Public — no apiKey needed.',
      inputSchema: {
        status: z.enum(['OPEN', 'CLOSED', 'RESOLVED']).optional().describe('Optional status filter.'),
      },
    },
    async ({ status }) => safely(() => toolResult({ markets: service.listMarkets(status) }))
  )

  server.registerTool(
    'predikt_get_market',
    {
      title: 'Get market',
      description:
        'Fetch one market by id, including its current YES probability, volume, status, and resolution criteria.',
      inputSchema: { marketId: marketIdInput },
    },
    async ({ marketId }) => safely(() => toolResult({ market: service.getMarket(marketId) }))
  )

  server.registerTool(
    'predikt_quote',
    {
      title: 'Quote a buy',
      description:
        'Price a hypothetical buy without executing it: how many shares a given spend would get, the fee, and the probability impact.',
      inputSchema: {
        marketId: marketIdInput,
        side: sideInput,
        amount: z.number().positive().max(1_000_000).describe('Spend in PRED credits.'),
      },
    },
    async ({ marketId, side, amount }) =>
      safely(() => toolResult({ quote: service.quote(marketId, side, amount) }))
  )

  server.registerTool(
    'predikt_create_market',
    {
      title: 'Create market',
      description:
        'Create a new binary prediction market. The subsidy (min 10 PRED) is debited from ' +
        'your balance to seed liquidity; you earn a 1% fee on every buy as the creator.',
      inputSchema: {
        apiKey: apiKeyInput,
        question: z.string().trim().min(8).max(240).describe('Clear yes/no question, 8-240 chars.'),
        criteria: z
          .string()
          .trim()
          .min(10)
          .max(2000)
          .describe('Exactly how and when the market resolves, and the authoritative source.'),
        closeTime: z
          .number()
          .int()
          .positive()
          .describe('Epoch milliseconds when trading closes. Must be in the future.'),
        initialProb: z
          .number()
          .min(0.02)
          .max(0.98)
          .optional()
          .describe('Starting YES probability (default 0.5).'),
        subsidy: z
          .number()
          .min(10)
          .max(100_000)
          .optional()
          .describe('Liquidity subsidy in PRED (default 10).'),
        category: z.string().trim().min(2).max(60).optional().describe('Topic, e.g. Technology.'),
        description: z.string().trim().max(4000).optional().describe('Neutral background context.'),
      },
    },
    async ({ apiKey, ...input }) =>
      safely(() => {
        const account = requireAccount(service, apiKey)
        return toolResult({ market: service.createMarket(account.id, input) })
      })
  )

  server.registerTool(
    'predikt_buy',
    {
      title: 'Buy shares',
      description:
        'Spend PRED credits to buy YES or NO shares in an open market. Each winning share pays 1 PRED at resolution. A 1% fee goes to the market creator.',
      inputSchema: {
        apiKey: apiKeyInput,
        marketId: marketIdInput,
        side: sideInput,
        amount: z.number().positive().max(1_000_000).describe('Spend in PRED credits.'),
      },
    },
    async ({ apiKey, marketId, side, amount }) =>
      safely(() => {
        const account = requireAccount(service, apiKey)
        return toolResult({ trade: service.buy(account.id, marketId, side, amount) })
      })
  )

  server.registerTool(
    'predikt_sell',
    {
      title: 'Sell shares',
      description:
        'Sell YES or NO shares you hold back to the market at the current price. No fee on sells.',
      inputSchema: {
        apiKey: apiKeyInput,
        marketId: marketIdInput,
        side: sideInput,
        shares: z.number().positive().max(10_000_000).describe('Number of shares to sell.'),
      },
    },
    async ({ apiKey, marketId, side, shares }) =>
      safely(() => {
        const account = requireAccount(service, apiKey)
        return toolResult({ trade: service.sell(account.id, marketId, side, shares) })
      })
  )

  server.registerTool(
    'predikt_resolve',
    {
      title: 'Resolve market',
      description:
        'Resolve a market you created: YES or NO pays 1 PRED per winning share; CANCEL refunds every trader their net cost. Creator only.',
      inputSchema: {
        apiKey: apiKeyInput,
        marketId: marketIdInput,
        outcome: z.enum(['YES', 'NO', 'CANCEL']).describe('Final outcome.'),
      },
    },
    async ({ apiKey, marketId, outcome }) =>
      safely(() => {
        const account = requireAccount(service, apiKey)
        return toolResult({ market: service.resolveMarket(account.id, marketId, outcome) })
      })
  )

  server.registerTool(
    'predikt_draft_market',
    {
      title: 'Draft markets with AI',
      description:
        'Turn a topic, news text, or URL into 1-5 well-specified prediction-market drafts (question, resolution criteria, close time). Provide at least one source.',
      inputSchema: {
        topic: z.string().trim().max(400).optional().describe('Free-form topic to draft from.'),
        newsText: z.string().trim().max(8000).optional().describe('Raw news text to draft from.'),
        url: z.string().trim().url().max(2000).optional().describe('Source URL (topic only, contents are not fetched).'),
        count: z.number().int().min(1).max(5).optional().describe('How many drafts (default 1).'),
      },
    },
    async (args) => safely(async () => toolResult(await runDraftMarket(complete, args)))
  )

  server.registerTool(
    'predikt_estimate_odds',
    {
      title: 'Estimate odds with AI',
      description:
        'Get a calibrated P(YES) estimate for a forecastable question: probability, confidence, base rate, key drivers, and update triggers.',
      inputSchema: {
        question: z.string().trim().min(8).max(400).describe('The forecastable question.'),
        resolutionCriteria: z.string().trim().max(2000).optional().describe('How the question resolves.'),
        deadline: z
          .string()
          .trim()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'deadline must be YYYY-MM-DD')
          .optional()
          .describe('ISO date the outcome should be known by (YYYY-MM-DD).'),
        context: z
          .array(z.string().trim().min(1).max(4000))
          .max(10)
          .optional()
          .describe('Context snippets the model may cite.'),
      },
    },
    async (args) => safely(async () => toolResult(await runEstimateOdds(complete, args)))
  )

  server.registerTool(
    'predikt_suggest_resolution',
    {
      title: 'Suggest resolution with AI',
      description:
        'Propose a resolution verdict (YES / NO / ANSWER / UNCLEAR) with rationale and citations for a human resolver to review. Never resolves anything itself.',
      inputSchema: {
        question: z.string().trim().min(4).max(400).describe('The market question.'),
        outcomeType: z.enum(AI_OUTCOME_TYPES).optional().describe('Market outcome type (default BINARY).'),
        resolutionCriteria: z.string().trim().max(2000).optional().describe('The market resolution criteria.'),
        answers: z
          .array(z.string().trim().min(1).max(200))
          .max(20)
          .optional()
          .describe('Possible answers for MULTIPLE_CHOICE markets.'),
        sources: z
          .array(z.string().trim().max(4000))
          .max(10)
          .optional()
          .describe('Evidence snippets or URLs to judge from.'),
      },
    },
    async (args) => safely(async () => toolResult(await runSuggestResolution(complete, args)))
  )
}
