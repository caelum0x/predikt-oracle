// Signed, retried webhook deliveries.
//
// The dispatcher polls the events table past a persisted high-water mark
// (dispatcher_state), fans each new event out into delivery rows for every
// matching active subscription, then works the due deliveries: one signed
// HTTP POST per delivery, exponential backoff on failure via a persisted
// next_attempt_at column (1s, 2s, 4s, ... — no unbounded in-process timers),
// permanent failure after maxAttempts, and auto-deactivation of a
// subscription after 20 consecutive failed attempts.
//
// tick() is the unit-testable single pass; start() only adds a timer.

import { createHmac } from 'node:crypto'
import type { Db } from '../engine/store'
import { newId } from '../engine/ids'
import { initEventsSchema, type EventRow, type EventType } from './events'

export const BASE_BACKOFF_MS = 1_000
export const DEACTIVATE_AFTER_CONSECUTIVE_FAILURES = 20
export const MAX_DELIVERIES_PER_TICK = 200

// The subset of fetch the dispatcher needs; the global fetch satisfies it,
// and tests inject a recorder.
export type FetchLike = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
  }
) => Promise<{ ok: boolean; status: number }>

export type DispatcherOptions = {
  db: Db
  fetchFn?: FetchLike
  intervalMs?: number
  maxAttempts?: number
}

export type TickStats = {
  enqueued: number
  delivered: number
  retried: number
  failed: number
}

type DueDeliveryRow = {
  id: string
  webhook_id: string
  event_id: number
  attempts: number
  url: string
  secret: string
  is_active: number
  failure_count: number
  type: string
  market_id: string
  payload: string
  created_at: number
}

/** The exact body string a delivery POSTs; the HMAC signs this string. */
export function buildDeliveryBody(event: {
  id: number
  type: string
  marketId: string
  payload: string
  createdAt: number
}): string {
  return JSON.stringify({
    id: event.id,
    type: event.type,
    marketId: event.marketId,
    payload: JSON.parse(event.payload) as Record<string, unknown>,
    createdAt: event.createdAt,
  })
}

export function signBody(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

export class WebhookDispatcher {
  private readonly db: Db
  private readonly fetchFn: FetchLike
  private readonly intervalMs: number
  private readonly maxAttempts: number
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(options: DispatcherOptions) {
    this.db = options.db
    this.fetchFn = options.fetchFn ?? globalThis.fetch
    this.intervalMs = options.intervalMs ?? 2_000
    this.maxAttempts = options.maxAttempts ?? 5
    initEventsSchema(this.db)
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        console.error(
          'webhook dispatcher tick failed:',
          err instanceof Error ? err.message : 'unknown error'
        )
      })
    }, this.intervalMs)
    // Never keep the process alive just for webhook polling.
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * One full pass: fan new events out into delivery rows, then attempt every
   * due delivery. `now` is injectable so tests can drive the backoff clock.
   */
  async tick(now: number = Date.now()): Promise<TickStats> {
    // Guard against overlapping passes when a slow endpoint outlives the
    // polling interval.
    if (this.running) return { enqueued: 0, delivered: 0, retried: 0, failed: 0 }
    this.running = true
    try {
      const enqueued = this.enqueueNewEvents(now)
      const stats = await this.processDueDeliveries(now)
      return { enqueued, ...stats }
    } finally {
      this.running = false
    }
  }

  // ---- fan-out ----------------------------------------------------------------

  private enqueueNewEvents(now: number): number {
    const run = this.db.transaction((): number => {
      const state = this.db
        .prepare('SELECT last_event_id FROM dispatcher_state WHERE id = 1')
        .get() as { last_event_id: number }
      const events = this.db
        .prepare('SELECT * FROM events WHERE id > ? ORDER BY id ASC')
        .all(state.last_event_id) as EventRow[]
      if (events.length === 0) return 0

      const matching = this.db.prepare(
        `SELECT id FROM webhooks
          WHERE is_active = 1
            AND start_event_id < ?
            AND EXISTS (SELECT 1 FROM json_each(webhooks.events) WHERE value = ?)`
      )
      const insert = this.db.prepare(
        `INSERT INTO deliveries (id, webhook_id, event_id, status, attempts, next_attempt_at)
         VALUES (?, ?, ?, 'pending', 0, ?)`
      )
      let enqueued = 0
      for (const event of events) {
        // A webhook only matches events emitted after it subscribed
        // (start_event_id < event.id), never historical ones.
        const hooks = matching.all(event.id, event.type) as { id: string }[]
        for (const hook of hooks) {
          insert.run(newId('dlv'), hook.id, event.id, now)
          enqueued += 1
        }
      }
      const last = events[events.length - 1]
      if (last) {
        this.db
          .prepare('UPDATE dispatcher_state SET last_event_id = ? WHERE id = 1')
          .run(last.id)
      }
      return enqueued
    })
    return run()
  }

  // ---- delivery ------------------------------------------------------------------

  private async processDueDeliveries(
    now: number
  ): Promise<{ delivered: number; retried: number; failed: number }> {
    const due = this.db
      .prepare(
        `SELECT d.id, d.webhook_id, d.event_id, d.attempts,
                w.url, w.secret, w.is_active, w.failure_count,
                e.type, e.market_id, e.payload, e.created_at
           FROM deliveries d
           JOIN webhooks w ON w.id = d.webhook_id
           JOIN events e ON e.id = d.event_id
          WHERE d.status = 'pending' AND d.next_attempt_at <= ?
          ORDER BY d.event_id ASC, d.id ASC
          LIMIT ?`
      )
      .all(now, MAX_DELIVERIES_PER_TICK) as DueDeliveryRow[]

    let delivered = 0
    let retried = 0
    let failed = 0
    // Webhooks deactivated during this tick, so later batched deliveries for
    // them are abandoned rather than re-sent (their is_active was read stale).
    const deactivated = new Set<string>()
    for (const row of due) {
      if (row.is_active !== 1) {
        this.markFailed(row.id, row.attempts, 'Webhook is deactivated.', now)
        failed += 1
        continue
      }
      if (deactivated.has(row.webhook_id)) {
        // Deactivated earlier in THIS tick: abandon without another HTTP call.
        this.markFailed(row.id, row.attempts, 'Webhook is deactivated.', now)
        failed += 1
        continue
      }
      const outcome = await this.attempt(row, now)
      if (outcome === 'ok') delivered += 1
      else if (outcome === 'retried') retried += 1
      else failed += 1
      if (outcome !== 'ok' && this.isDeactivated(row.webhook_id)) {
        deactivated.add(row.webhook_id)
      }
    }
    return { delivered, retried, failed }
  }

  private async attempt(
    row: DueDeliveryRow,
    now: number
  ): Promise<'ok' | 'retried' | 'failed'> {
    const body = buildDeliveryBody({
      id: row.event_id,
      type: row.type,
      marketId: row.market_id,
      payload: row.payload,
      createdAt: row.created_at,
    })
    let error: string | null = null
    try {
      const res = await this.fetchFn(row.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Predikt-Signature': signBody(row.secret, body),
          'X-Predikt-Event': row.type as EventType,
        },
        body,
      })
      if (!res.ok) error = `Endpoint returned HTTP ${res.status}.`
    } catch (err) {
      error = err instanceof Error ? err.message : 'Request failed.'
    }

    if (error === null) {
      // Both writes commit together: a crash between them must not leave a
      // delivery marked ok while the webhook keeps a stale failure_count.
      this.db.transaction(() => {
        this.db
          .prepare(
            `UPDATE deliveries
                SET status = 'ok', attempts = ?, last_error = NULL, delivered_at = ?
              WHERE id = ?`
          )
          .run(row.attempts + 1, now, row.id)
        this.db
          .prepare('UPDATE webhooks SET failure_count = 0 WHERE id = ?')
          .run(row.webhook_id)
      })()
      return 'ok'
    }

    const attempts = row.attempts + 1
    const exhausted = attempts >= this.maxAttempts
    if (exhausted) {
      this.markFailed(row.id, row.attempts, error, now)
    } else {
      // 1s, 2s, 4s, ... exponential backoff, persisted — no in-process timers.
      const backoff = BASE_BACKOFF_MS * 2 ** (attempts - 1)
      this.db
        .prepare(
          `UPDATE deliveries
              SET attempts = ?, last_error = ?, next_attempt_at = ?
            WHERE id = ?`
        )
        .run(attempts, error, now + backoff, row.id)
    }
    this.recordWebhookFailure(row.webhook_id, now)
    return exhausted ? 'failed' : 'retried'
  }

  private markFailed(
    deliveryId: string,
    priorAttempts: number,
    error: string,
    now: number
  ): void {
    this.db
      .prepare(
        `UPDATE deliveries
            SET status = 'failed', attempts = ?, last_error = ?, next_attempt_at = ?
          WHERE id = ?`
      )
      .run(priorAttempts + 1, error, now, deliveryId)
  }

  // Counts consecutive failed attempts; a webhook that fails 20 times in a
  // row is deactivated and its still-pending deliveries are abandoned. The
  // increment is atomic in SQL (not derived from a value read earlier in the
  // tick), so many failures in one pass accumulate correctly.
  private recordWebhookFailure(webhookId: string, now: number): void {
    // The increment, the deactivation check, and the pending-delivery sweep
    // commit as one unit so a crash can't leave is_active = 0 with deliveries
    // still marked pending (which would later overwrite the deactivation
    // reason with a generic error).
    this.db.transaction(() => {
      this.db
        .prepare(
          'UPDATE webhooks SET failure_count = failure_count + 1 WHERE id = ?'
        )
        .run(webhookId)
      const row = this.db
        .prepare('SELECT failure_count FROM webhooks WHERE id = ?')
        .get(webhookId) as { failure_count: number } | undefined
      if (row && row.failure_count >= DEACTIVATE_AFTER_CONSECUTIVE_FAILURES) {
        this.db
          .prepare('UPDATE webhooks SET is_active = 0 WHERE id = ?')
          .run(webhookId)
        this.db
          .prepare(
            `UPDATE deliveries
                SET status = 'failed', last_error = 'Webhook was deactivated after repeated failures.',
                    next_attempt_at = ?
              WHERE webhook_id = ? AND status = 'pending'`
          )
          .run(now, webhookId)
      }
    })()
  }

  private isDeactivated(webhookId: string): boolean {
    const row = this.db
      .prepare('SELECT is_active FROM webhooks WHERE id = ?')
      .get(webhookId) as { is_active: number } | undefined
    return !!row && row.is_active !== 1
  }
}
