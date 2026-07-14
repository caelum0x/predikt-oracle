// End-to-end tests for the Predikt Oracle MCP server: a real SDK Client talks
// to the real McpServer over an in-memory transport pair. The database is
// ':memory:' and the AI completion function is a deterministic fake, so no
// network or filesystem is touched.

import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { ChatCompletionOptions } from '../src/ai/openrouter'
import { MarketService, SIGNUP_GRANT } from '../src/engine/service'
import { openDb } from '../src/engine/store'
import { createMcpServer } from '../src/mcp/server'

const EXPECTED_TOOLS = [
  'predikt_create_account',
  'predikt_get_balance',
  'predikt_list_markets',
  'predikt_get_market',
  'predikt_quote',
  'predikt_create_market',
  'predikt_buy',
  'predikt_sell',
  'predikt_resolve',
  'predikt_draft_market',
  'predikt_estimate_odds',
  'predikt_suggest_resolution',
]

// Deterministic fake OpenRouter: routes on the system prompt of each AI tool.
async function fakeComplete(options: ChatCompletionOptions): Promise<string> {
  const system = options.messages[0]?.content ?? ''
  if (system.includes('draft prediction-market questions')) {
    return JSON.stringify({
      drafts: [
        {
          question: 'Will BTC close above $100k on 2026-12-31?',
          description: 'Bitcoin price market drafted from the given topic.',
          outcomeType: 'BINARY',
          closeTime: Date.now() + 90 * 24 * 60 * 60 * 1000,
          category: 'Crypto',
          topicSlug: 'btc-100k',
          resolutionCriteria: 'Resolves YES if the Coinbase daily close is above $100,000.',
        },
      ],
    })
  }
  if (system.includes('calibrated superforecaster')) {
    return JSON.stringify({
      probability: 0.62,
      confidence: 'medium',
      rationale: 'Base rate plus current momentum suggests a modest edge for YES.',
      baseRate: 'Similar events resolved YES about 55% of the time historically.',
      keyDrivers: ['ETF inflows', 'macro rate path'],
      updateTriggers: ['a major exchange failure'],
      citations: [],
    })
  }
  if (system.includes('human resolver')) {
    return JSON.stringify({
      verdict: 'YES',
      confidence: 0.9,
      rationale: 'The provided source confirms the event happened before the deadline.',
      citations: ['[1]'],
    })
  }
  throw new Error(`fakeComplete: unrecognized system prompt: ${system.slice(0, 60)}`)
}

async function setup() {
  const service = new MarketService(openDb(':memory:'))
  const server = createMcpServer({ service, complete: fakeComplete })
  const client = new Client({ name: 'mcp-test-client', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  return { client, service }
}

type ToolCallResult = {
  isError?: boolean
  content: Array<{ type: string; text?: string }>
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  return (await client.callTool({ name, arguments: args })) as ToolCallResult
}

function dataOf<T>(result: ToolCallResult): T {
  expect(result.isError ?? false).toBe(false)
  const text = result.content[0]?.text
  expect(typeof text).toBe('string')
  return JSON.parse(text as string) as T
}

function errorTextOf(result: ToolCallResult): string {
  expect(result.isError).toBe(true)
  return result.content[0]?.text ?? ''
}

describe('MCP server: tool discovery', () => {
  it('lists all 12 predikt tools with descriptions and schemas', async () => {
    const { client } = await setup()
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([...EXPECTED_TOOLS].sort())
    for (const tool of tools) {
      expect(tool.description ?? '').not.toBe('')
      expect(tool.inputSchema.type).toBe('object')
    }
  })
})

describe('MCP server: full market lifecycle', () => {
  it('create account -> create market -> quote -> buy -> sell -> resolve -> payout', async () => {
    const { client } = await setup()

    // Creator account.
    const created = dataOf<{ account: { id: string; balance: number }; apiKey: string }>(
      await call(client, 'predikt_create_account', { name: 'alice' })
    )
    expect(created.account.balance).toBe(SIGNUP_GRANT)
    expect(created.apiKey).toMatch(/\w{8,}/)
    const aliceKey = created.apiKey

    // Trader account.
    const bob = dataOf<{ account: { id: string }; apiKey: string }>(
      await call(client, 'predikt_create_account', { name: 'bob' })
    )
    const bobKey = bob.apiKey

    // Alice creates a market (10 PRED subsidy debited).
    const closeTime = Date.now() + 24 * 60 * 60 * 1000
    const marketRes = dataOf<{ market: { id: string; probability: number; status: string } }>(
      await call(client, 'predikt_create_market', {
        apiKey: aliceKey,
        question: 'Will it rain in Istanbul tomorrow?',
        criteria: 'Resolves YES if any rain is recorded at IST airport tomorrow.',
        closeTime,
        category: 'Weather',
      })
    )
    const marketId = marketRes.market.id
    expect(marketRes.market.status).toBe('OPEN')
    expect(marketRes.market.probability).toBeCloseTo(0.5, 6)

    const aliceAfterCreate = dataOf<{ account: { balance: number } }>(
      await call(client, 'predikt_get_balance', { apiKey: aliceKey })
    )
    expect(aliceAfterCreate.account.balance).toBe(SIGNUP_GRANT - 10)

    // Market shows up in the OPEN listing.
    const listing = dataOf<{ markets: Array<{ id: string }> }>(
      await call(client, 'predikt_list_markets', { status: 'OPEN' })
    )
    expect(listing.markets.map((m) => m.id)).toContain(marketId)

    // Quote matches the trade that follows.
    const quoteRes = dataOf<{ quote: { shares: number; fee: number; probAfter: number } }>(
      await call(client, 'predikt_quote', { marketId, side: 'YES', amount: 100 })
    )
    expect(quoteRes.quote.shares).toBeGreaterThan(0)
    expect(quoteRes.quote.fee).toBeCloseTo(1, 6)

    // Bob buys YES for 100 PRED.
    const buyRes = dataOf<{ trade: { shares: number; balance: number; probAfter: number } }>(
      await call(client, 'predikt_buy', { apiKey: bobKey, marketId, side: 'YES', amount: 100 })
    )
    expect(buyRes.trade.shares).toBeCloseTo(quoteRes.quote.shares, 6)
    expect(buyRes.trade.balance).toBe(SIGNUP_GRANT - 100)
    expect(buyRes.trade.probAfter).toBeGreaterThan(0.5)

    // Bob sells a little back — fee-free, credits his balance.
    const sellRes = dataOf<{ trade: { amount: number; balance: number } }>(
      await call(client, 'predikt_sell', { apiKey: bobKey, marketId, side: 'YES', shares: 5 })
    )
    expect(sellRes.trade.amount).toBeGreaterThan(0)
    expect(sellRes.trade.balance).toBeGreaterThan(SIGNUP_GRANT - 100)

    // Bob holds a YES position.
    const bobPositions = dataOf<{ positions: Array<{ marketId: string; yesShares: number }> }>(
      await call(client, 'predikt_get_balance', { apiKey: bobKey })
    )
    const pos = bobPositions.positions.find((p) => p.marketId === marketId)
    expect(pos).toBeDefined()
    expect(pos?.yesShares).toBeCloseTo(buyRes.trade.shares - 5, 6)

    // Only the creator can resolve.
    const forbidden = await call(client, 'predikt_resolve', {
      apiKey: bobKey,
      marketId,
      outcome: 'YES',
    })
    expect(errorTextOf(forbidden)).toContain('creator')

    // Alice resolves YES.
    const resolved = dataOf<{ market: { status: string; outcome: string } }>(
      await call(client, 'predikt_resolve', { apiKey: aliceKey, marketId, outcome: 'YES' })
    )
    expect(resolved.market.status).toBe('RESOLVED')
    expect(resolved.market.outcome).toBe('YES')

    const marketAfter = dataOf<{ market: { status: string } }>(
      await call(client, 'predikt_get_market', { marketId })
    )
    expect(marketAfter.market.status).toBe('RESOLVED')

    // Bob's payout: each remaining YES share pays 1 PRED. He bought at ~50%
    // and YES resolved, so he ends up ahead of his starting grant.
    const bobFinal = dataOf<{ account: { balance: number } }>(
      await call(client, 'predikt_get_balance', { apiKey: bobKey })
    )
    const expectedFinal =
      sellRes.trade.balance + (buyRes.trade.shares - 5)
    expect(bobFinal.account.balance).toBeCloseTo(expectedFinal, 4)
    expect(bobFinal.account.balance).toBeGreaterThan(SIGNUP_GRANT)
  })
})

describe('MCP server: AI tools', () => {
  it('predikt_estimate_odds returns a validated estimate', async () => {
    const { client } = await setup()
    const res = dataOf<{
      estimate: { probability: number; confidence: string; keyDrivers: string[] }
    }>(
      await call(client, 'predikt_estimate_odds', {
        question: 'Will BTC close above $100k this year?',
        deadline: '2026-12-31',
      })
    )
    expect(res.estimate.probability).toBe(0.62)
    expect(res.estimate.confidence).toBe('medium')
    expect(res.estimate.keyDrivers.length).toBeGreaterThan(0)
  })

  it('predikt_draft_market returns normalized, validated drafts', async () => {
    const { client } = await setup()
    const res = dataOf<{
      drafts: Array<{ question: string; outcomeType: string; closeTime: number }>
    }>(await call(client, 'predikt_draft_market', { topic: 'bitcoin price' }))
    expect(res.drafts).toHaveLength(1)
    expect(res.drafts[0]?.outcomeType).toBe('BINARY')
    expect(res.drafts[0]?.closeTime).toBeGreaterThan(Date.now())
  })

  it('predikt_draft_market with no source is an isError result, not a crash', async () => {
    const { client } = await setup()
    const res = await call(client, 'predikt_draft_market', {})
    expect(errorTextOf(res)).toContain('topic')
  })

  it('predikt_suggest_resolution returns a validated suggestion', async () => {
    const { client } = await setup()
    const res = dataOf<{ suggestion: { verdict: string; confidence: number } }>(
      await call(client, 'predikt_suggest_resolution', {
        question: 'Did the launch happen before July?',
        sources: ['Launch confirmed on June 12 by the official blog.'],
      })
    )
    expect(res.suggestion.verdict).toBe('YES')
    expect(res.suggestion.confidence).toBeCloseTo(0.9, 6)
  })
})

describe('MCP server: errors', () => {
  it('bad apiKey yields isError with a helpful message', async () => {
    const { client } = await setup()
    const res = await call(client, 'predikt_get_balance', { apiKey: 'pk_not_a_real_key' })
    expect(errorTextOf(res)).toContain('Invalid API key')

    const buyRes = await call(client, 'predikt_buy', {
      apiKey: 'pk_not_a_real_key',
      marketId: 'mkt_whatever',
      side: 'YES',
      amount: 10,
    })
    expect(errorTextOf(buyRes)).toContain('Invalid API key')
  })

  it('unknown market yields isError, insufficient balance yields isError', async () => {
    const { client } = await setup()
    const acct = dataOf<{ apiKey: string }>(
      await call(client, 'predikt_create_account', { name: 'carol' })
    )
    const missing = await call(client, 'predikt_get_market', { marketId: 'mkt_missing' })
    expect(errorTextOf(missing)).toContain('not found')

    const market = dataOf<{ market: { id: string } }>(
      await call(client, 'predikt_create_market', {
        apiKey: acct.apiKey,
        question: 'Will carol overspend her balance?',
        criteria: 'Resolves YES if the buy below succeeds despite no funds.',
        closeTime: Date.now() + 60 * 60 * 1000,
      })
    )
    const broke = await call(client, 'predikt_buy', {
      apiKey: acct.apiKey,
      marketId: market.market.id,
      side: 'NO',
      amount: 999_999,
    })
    expect(errorTextOf(broke)).toContain('Insufficient balance')
  })

  it('invalid input is rejected by schema validation before the handler runs', async () => {
    const { client, service } = await setup()
    // side must be YES|NO — 'MAYBE' fails the zod input schema.
    const badSide = await call(client, 'predikt_buy', {
      apiKey: 'pk_x_12345678',
      marketId: 'mkt_x',
      side: 'MAYBE',
      amount: 10,
    })
    expect(errorTextOf(badSide)).toContain('Input validation error')
    // name too short for create_account — rejected before any account exists.
    const badName = await call(client, 'predikt_create_account', { name: 'a' })
    expect(errorTextOf(badName)).toContain('Input validation error')
    expect(service.listMarkets()).toHaveLength(0)
  })
})
