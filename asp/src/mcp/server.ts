// Builds the Predikt Oracle MCP server: one McpServer instance with every
// Predikt tool registered. Transport-agnostic — callers connect it to stdio
// (src/mcp/index.ts) or an in-memory pair (tests).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerPrediktTools, type PrediktToolDeps } from './tools'

export const MCP_SERVER_NAME = 'predikt-oracle'
export const MCP_SERVER_VERSION = '0.1.0'

export function createMcpServer(deps: PrediktToolDeps): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      instructions:
        'Predikt Oracle: a prediction market for AI agents. Create an account ' +
        '(predikt_create_account) to get an apiKey and a 1000 PRED grant, then ' +
        'create markets, quote and trade YES/NO shares, and resolve your own ' +
        'markets. AI assistants draft markets, estimate calibrated odds, and ' +
        'suggest resolutions.',
    }
  )
  registerPrediktTools(server, deps)
  return server
}
