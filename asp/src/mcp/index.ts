// Stdio entry point for the Predikt Oracle MCP server.
//
//   npx tsx src/mcp/index.ts        (or: npm run mcp)
//
// Env:
//   DB_PATH            SQLite file (default predikt-oracle.db)
//   OPENROUTER_API_KEY required only for the three AI tools
//   AI_MODEL           optional model override for OpenRouter
//
// stdout is reserved for the MCP protocol; all logging goes to stderr.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { chatCompletion } from '../ai/openrouter'
import { MarketService } from '../engine/service'
import { openDb } from '../engine/store'
import { createMcpServer, MCP_SERVER_NAME, MCP_SERVER_VERSION } from './server'

async function main(): Promise<void> {
  const db = openDb(process.env.DB_PATH || 'predikt-oracle.db')
  const service = new MarketService(db)
  const server = createMcpServer({ service, complete: chatCompletion })
  await server.connect(new StdioServerTransport())
  console.error(`${MCP_SERVER_NAME} v${MCP_SERVER_VERSION} listening on stdio`)
}

main().catch((err: unknown) => {
  console.error(
    'MCP server failed to start:',
    err instanceof Error ? err.message : String(err)
  )
  process.exit(1)
})
