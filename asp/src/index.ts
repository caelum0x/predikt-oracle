// Server entry point. Fails fast when required configuration is missing, then
// starts the HTTP app plus the two background workers (webhook dispatcher and
// resolution sweeper) on the same database handle.

import { serve } from '@hono/node-server'
import { createApp } from './app'
import { openDb } from './engine/store'
import { MarketService } from './engine/service'
import { chatCompletion } from './ai/openrouter'
import { WebhookDispatcher } from './webhooks/dispatcher'
import { ResolutionSweeper } from './resolution/sweeper'

if (!process.env.OPENROUTER_API_KEY?.trim()) {
  // Non-fatal: the market, trading, x402, and MCP layers work without it —
  // only the /tools/* AI endpoints need it, and they report the missing key
  // per-request. Keeping the server up matters for a listed ASP endpoint.
  console.error(
    'WARNING: OPENROUTER_API_KEY is not set — the AI tool endpoints (/tools/*) ' +
      'will return an error until it is configured; everything else works.'
  )
}

const port = Number(process.env.PORT) || 8787
const db = openDb(process.env.DB_PATH || 'predikt-oracle.db')
const app = createApp({ db })

// Background workers share the same db handle as the HTTP app. Both use
// unref'd timers, so they never keep the process alive on their own.
const dispatcher = new WebhookDispatcher({ db })
dispatcher.start()
const sweeper = new ResolutionSweeper({
  db,
  service: new MarketService(db),
  complete: chatCompletion,
})
sweeper.start()

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.error(`Predikt Oracle ASP listening on http://localhost:${info.port}`)
})

function shutdown(signal: string): void {
  console.error(`Received ${signal}, shutting down.`)
  dispatcher.stop()
  sweeper.stop()
  server.close(() => {
    db.close()
    process.exit(0)
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
