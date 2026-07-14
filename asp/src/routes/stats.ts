// Public analytics routes: platform totals, ranked leaderboards, and
// per-account reputation stats. No auth — everything here is derived,
// aggregate, and safe to expose.

import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { Db } from '../engine/store'
import { accountStats, leaderboard, platformStats } from '../engine/reputation'

type ApiResponse<T> = { success: boolean; data?: T; error?: string }

const leaderboardQuerySchema = z.object({
  by: z.enum(['profit', 'brier', 'volume']).default('profit'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

function ok<T>(c: Context, data: T) {
  return c.json({ success: true, data } satisfies ApiResponse<T>)
}

function fail(c: Context, status: 400 | 404, error: string) {
  return c.json({ success: false, error } satisfies ApiResponse<never>, status)
}

export function createStatsRoutes(db: Db): Hono {
  const app = new Hono()

  app.get('/stats/platform', (c) => ok(c, { platform: platformStats(db) }))

  app.get('/stats/leaderboard', (c) => {
    const parsed = leaderboardQuerySchema.safeParse({
      by: c.req.query('by') || undefined,
      limit: c.req.query('limit') || undefined,
    })
    if (!parsed.success) {
      return fail(
        c,
        400,
        parsed.error.issues[0]?.message ?? 'Invalid leaderboard query.'
      )
    }
    return ok(c, {
      by: parsed.data.by,
      leaderboard: leaderboard(db, parsed.data),
    })
  })

  app.get('/stats/accounts/:id', (c) => {
    const stats = accountStats(db, c.req.param('id'))
    if (!stats) return fail(c, 404, 'Account not found.')
    return ok(c, { stats })
  })

  return app
}
