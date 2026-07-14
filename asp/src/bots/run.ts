// CLI entry for the trader bot: npx tsx src/bots/run.ts
//
// Env:
//   BOT_BASE_URL     ASP base URL (default http://localhost:8787)
//   BOT_API_KEY      required — the bot account's API key (POST /accounts)
//   BOT_INTERVAL_MS  cycle interval in ms (default 60000, min 1000)
//   BOT_ONCE         set to 1 to run a single cycle and exit

import { TraderBot } from './trader'

const DEFAULT_BASE_URL = 'http://localhost:8787'
const DEFAULT_INTERVAL_MS = 60_000
const MIN_INTERVAL_MS = 1_000

function main(): void {
  const apiKey = process.env.BOT_API_KEY
  if (!apiKey) {
    console.error(
      'BOT_API_KEY is required. Create an account with ' +
        `POST ${process.env.BOT_BASE_URL || DEFAULT_BASE_URL}/accounts ` +
        'and set BOT_API_KEY to the returned apiKey (pk_...).'
    )
    process.exit(1)
  }

  const baseUrl = process.env.BOT_BASE_URL || DEFAULT_BASE_URL
  const rawInterval = process.env.BOT_INTERVAL_MS
  const intervalMs = rawInterval ? Number(rawInterval) : DEFAULT_INTERVAL_MS
  if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS) {
    console.error(
      `BOT_INTERVAL_MS must be a number >= ${MIN_INTERVAL_MS}, got "${rawInterval}".`
    )
    process.exit(1)
  }

  const bot = new TraderBot({ baseUrl, apiKey })

  if (process.env.BOT_ONCE === '1') {
    bot
      .runOnce()
      .then((report) => {
        console.error(JSON.stringify(report, null, 2))
      })
      .catch((err: unknown) => {
        console.error(
          'trader cycle failed:',
          err instanceof Error ? err.message : String(err)
        )
        process.exit(1)
      })
    return
  }

  console.error(
    `trader bot started: ${baseUrl}, every ${intervalMs}ms (Ctrl-C to stop)`
  )
  bot.runForever({ intervalMs })

  const shutdown = (): void => {
    bot.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main()
