// Market event capture + webhook subscription storage.
//
// Events are captured by SQLite triggers on the engine's own tables (trades,
// markets), which fully decouples event capture from service code: nothing in
// the engine knows webhooks exist. The WebhookDispatcher (dispatcher.ts)
// polls the events table and fans deliveries out to subscriptions.
//
// SECURITY NOTE: webhook secrets are stored in PLAINTEXT by design — the
// dispatcher must produce an HMAC-SHA256 signature over every delivery body,
// which is impossible with a hashed secret. The secret is returned exactly
// once at creation time and masked on every subsequent read.

import { randomBytes } from 'node:crypto'
import type { Db } from '../engine/store'
import { ServiceError } from '../engine/errors'
import { newId } from '../engine/ids'

export const EVENT_TYPES = [
  'trade.executed',
  'market.created',
  'market.resolved',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export const MAX_ACTIVE_WEBHOOKS_PER_ACCOUNT = 5

// ---- schema -----------------------------------------------------------------

const EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  market_id   TEXT NOT NULL,
  payload     TEXT NOT NULL,              -- JSON, built by json_object()
  created_at  INTEGER NOT NULL            -- epoch millis
);

CREATE TABLE IF NOT EXISTS webhooks (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES accounts(id),
  url            TEXT NOT NULL,
  events         TEXT NOT NULL,           -- JSON array of event types
  secret         TEXT NOT NULL,           -- plaintext: needed to sign deliveries
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  failure_count  INTEGER NOT NULL DEFAULT 0,
  -- The highest events.id that existed when this subscription was created.
  -- The dispatcher only delivers events with a STRICTLY GREATER id, so a new
  -- webhook never receives events that predated it (see enqueueNewEvents).
  start_event_id INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS deliveries (
  id               TEXT PRIMARY KEY,
  webhook_id       TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_id         INTEGER NOT NULL REFERENCES events(id),
  status           TEXT NOT NULL DEFAULT 'pending',   -- pending | ok | failed
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL,
  last_error       TEXT,
  delivered_at     INTEGER
);

CREATE TABLE IF NOT EXISTS dispatcher_state (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  last_event_id  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_events_market ON events(market_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_account ON webhooks(account_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_due ON deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON deliveries(webhook_id, status);

CREATE TRIGGER IF NOT EXISTS trg_events_trade_executed
AFTER INSERT ON trades
BEGIN
  INSERT INTO events (type, market_id, payload, created_at)
  VALUES (
    'trade.executed',
    NEW.market_id,
    json_object(
      'marketId',  NEW.market_id,
      'tradeId',   NEW.id,
      'side',      NEW.side,
      'kind',      NEW.kind,
      'amount',    NEW.amount,
      'probAfter', NEW.prob_after,
      'answerId',  NEW.answer_id
    ),
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_events_market_created
AFTER INSERT ON markets
BEGIN
  INSERT INTO events (type, market_id, payload, created_at)
  VALUES (
    'market.created',
    NEW.id,
    json_object(
      'marketId',    NEW.id,
      'question',    NEW.question,
      'outcomeType', NEW.outcome_type
    ),
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_events_market_resolved
AFTER UPDATE OF status ON markets
WHEN NEW.status = 'RESOLVED'
BEGIN
  INSERT INTO events (type, market_id, payload, created_at)
  VALUES (
    'market.resolved',
    NEW.id,
    json_object(
      'marketId', NEW.id,
      'outcome',  NEW.outcome
    ),
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  );
END;
`

function hasColumn(db: Db, table: string, column: string): boolean {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[]
  return cols.some((col) => col.name === column)
}

/** Idempotently creates the event/webhook tables, triggers, and indexes. */
export function initEventsSchema(db: Db): void {
  db.exec(EVENTS_SCHEMA)
  // Upgrade databases created before per-subscription start cursors existed.
  // Pre-existing webhooks default to 0 (they keep their historical behavior of
  // matching from the beginning of the event log).
  if (!hasColumn(db, 'webhooks', 'start_event_id')) {
    db.exec(
      'ALTER TABLE webhooks ADD COLUMN start_event_id INTEGER NOT NULL DEFAULT 0'
    )
  }
  db.prepare(
    'INSERT OR IGNORE INTO dispatcher_state (id, last_event_id) VALUES (1, 0)'
  ).run()
}

// ---- rows and views -----------------------------------------------------------

export type EventRow = {
  id: number
  type: EventType
  market_id: string
  payload: string
  created_at: number
}

export type WebhookRow = {
  id: string
  account_id: string
  url: string
  events: string
  secret: string
  is_active: number
  created_at: number
  failure_count: number
  start_event_id: number
}

export type Webhook = {
  id: string
  accountId: string
  url: string
  events: EventType[]
  isActive: boolean
  createdAt: number
  failureCount: number
}

export function toWebhook(row: WebhookRow): Webhook {
  return {
    id: row.id,
    accountId: row.account_id,
    url: row.url,
    events: JSON.parse(row.events) as EventType[],
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    failureCount: row.failure_count,
  }
}

/** Shows just enough of a secret to correlate it, never enough to sign. */
export function maskSecret(secret: string): string {
  return `${secret.slice(0, 10)}…${secret.slice(-4)}`
}

// ---- subscription CRUD --------------------------------------------------------

export function createWebhook(
  db: Db,
  accountId: string,
  input: { url: string; events: EventType[] }
): { webhook: Webhook; secret: string } {
  const events = [...new Set(input.events)]
  const run = db.transaction((): { webhook: Webhook; secret: string } => {
    const activeRow = db
      .prepare(
        'SELECT COUNT(*) AS n FROM webhooks WHERE account_id = ? AND is_active = 1'
      )
      .get(accountId) as { n: number }
    if (activeRow.n >= MAX_ACTIVE_WEBHOOKS_PER_ACCOUNT) {
      throw new ServiceError(
        409,
        `Limit reached: at most ${MAX_ACTIVE_WEBHOOKS_PER_ACCOUNT} active webhooks per account.`
      )
    }
    const id = newId('wh')
    const secret = `whsec_${randomBytes(24).toString('hex')}`
    const now = Date.now()
    // Snapshot the current end of the event log. The dispatcher delivers only
    // events with a strictly greater id, so this subscription never receives
    // events that were emitted before it was created.
    const startEventId = (
      db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM events').get() as {
        m: number
      }
    ).m
    db.prepare(
      `INSERT INTO webhooks
         (id, account_id, url, events, secret, is_active, created_at, failure_count, start_event_id)
       VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?)`
    ).run(id, accountId, input.url, JSON.stringify(events), secret, now, startEventId)
    return {
      webhook: {
        id,
        accountId,
        url: input.url,
        events,
        isActive: true,
        createdAt: now,
        failureCount: 0,
      },
      secret,
    }
  })
  return run()
}

export function listWebhooks(db: Db, accountId: string): WebhookRow[] {
  return db
    .prepare('SELECT * FROM webhooks WHERE account_id = ? ORDER BY created_at ASC')
    .all(accountId) as WebhookRow[]
}

/** Deletes the caller's webhook (and, via cascade, its deliveries). */
export function deleteWebhook(db: Db, accountId: string, webhookId: string): Webhook {
  const run = db.transaction((): Webhook => {
    const row = db
      .prepare('SELECT * FROM webhooks WHERE id = ? AND account_id = ?')
      .get(webhookId, accountId) as WebhookRow | undefined
    if (!row) {
      // 404 (not 403) for foreign ids: don't leak that the webhook exists.
      throw new ServiceError(404, 'Webhook not found.')
    }
    db.prepare('DELETE FROM deliveries WHERE webhook_id = ?').run(webhookId)
    db.prepare('DELETE FROM webhooks WHERE id = ?').run(webhookId)
    return toWebhook(row)
  })
  return run()
}
