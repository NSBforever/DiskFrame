import type { EventChange } from './eventNormalize.ts'

/**
 * Local cache of the user's calendar, in the catalogue database.
 *
 * Never holds a credential: diskframe.db is copied into backups/, and a secret
 * must not multiply. The refresh token lives in credentialStore.ts.
 *
 * Takes the narrow interface both better-sqlite3 (app) and node:sqlite (tests)
 * satisfy, like libraryReads.ts.
 */
export interface CalDb {
  exec(sql: string): unknown
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
}

export const CALENDAR_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS calendar_accounts (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    provider TEXT NOT NULL DEFAULT 'google',
    email TEXT,
    status TEXT NOT NULL,
    connected_at TEXT,
    last_sync_at TEXT,
    last_error TEXT
  );
  CREATE TABLE IF NOT EXISTS calendar_calendars (
    id TEXT PRIMARY KEY,
    summary TEXT,
    time_zone TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    sync_token TEXT
  );
  CREATE TABLE IF NOT EXISTS calendar_events (
    calendar_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    recurring_event_id TEXT,
    original_start_ms INTEGER,
    summary TEXT,
    description TEXT,
    location TEXT,
    all_day INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    start_day TEXT NOT NULL,
    end_day TEXT NOT NULL,
    event_tz TEXT,
    updated TEXT,
    PRIMARY KEY (calendar_id, event_id)
  );
  CREATE INDEX IF NOT EXISTS idx_cal_events_days ON calendar_events (start_day, end_day);
  CREATE INDEX IF NOT EXISTS idx_cal_events_range ON calendar_events (start_ms, end_ms);
  CREATE TABLE IF NOT EXISTS event_file_links (
    path TEXT NOT NULL,
    volume_id TEXT,
    calendar_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('confirmed', 'rejected', 'manual')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (path, volume_id, calendar_id, event_id)
  );
  CREATE INDEX IF NOT EXISTS idx_links_event ON event_file_links (calendar_id, event_id);
`

export type AccountStatus = 'connected' | 'expired' | 'error'

export interface AccountRow {
  email: string | null
  status: AccountStatus
  connected_at: string | null
  last_sync_at: string | null
  last_error: string | null
}

export function getAccount(db: CalDb): AccountRow | null {
  return (db.prepare('SELECT email, status, connected_at, last_sync_at, last_error FROM calendar_accounts WHERE id = 1').get() as AccountRow) ?? null
}

export function saveAccount(db: CalDb, patch: Partial<AccountRow>): void {
  const cur = getAccount(db)
  const next = { email: null, status: 'connected', connected_at: null, last_sync_at: null, last_error: null, ...cur, ...patch }
  db.prepare(
    `INSERT OR REPLACE INTO calendar_accounts (id, email, status, connected_at, last_sync_at, last_error) VALUES (1, ?, ?, ?, ?, ?)`
  ).run(next.email, next.status, next.connected_at, next.last_sync_at, next.last_error)
}

export function syncTokenOf(db: CalDb, calendarId: string): string | null {
  return (db.prepare('SELECT sync_token FROM calendar_calendars WHERE id = ?').get(calendarId) as { sync_token: string | null } | undefined)?.sync_token ?? null
}

export function saveCalendar(db: CalDb, id: string, fields: { summary?: string | null; time_zone?: string | null; sync_token?: string | null }): void {
  db.prepare('INSERT OR IGNORE INTO calendar_calendars (id) VALUES (?)').run(id)
  if ('summary' in fields) db.prepare('UPDATE calendar_calendars SET summary = ? WHERE id = ?').run(fields.summary ?? null, id)
  if ('time_zone' in fields) db.prepare('UPDATE calendar_calendars SET time_zone = ? WHERE id = ?').run(fields.time_zone ?? null, id)
  if ('sync_token' in fields) db.prepare('UPDATE calendar_calendars SET sync_token = ? WHERE id = ?').run(fields.sync_token ?? null, id)
}

/**
 * Infinite series ("every Monday") expand into instances for years ahead.
 * Files can only be from the past, so instances more than a year out are not
 * stored; they arrive again on a later sync as time moves on.
 * ponytail: fixed horizon; make it a setting if anyone needs far-future events.
 */
export const FUTURE_HORIZON_MS = 366 * 24 * 3600 * 1000

/** Applies one page of changes atomically. Returns what was written. */
export function applyEventChanges(db: CalDb, calendarId: string, changes: EventChange[], now = Date.now()): { upserted: number; deleted: number } {
  const up = db.prepare(
    `INSERT OR REPLACE INTO calendar_events
       (calendar_id, event_id, recurring_event_id, original_start_ms, summary, description, location,
        all_day, start_ms, end_ms, start_day, end_day, event_tz, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const del = db.prepare('DELETE FROM calendar_events WHERE calendar_id = ? AND event_id = ?')
  let upserted = 0
  let deleted = 0
  db.exec('BEGIN')
  try {
    for (const c of changes) {
      if (c.kind === 'delete') {
        del.run(calendarId, c.event_id)
        deleted++
      } else if (c.kind === 'upsert') {
        const r = c.row
        if (r.start_ms > now + FUTURE_HORIZON_MS) {
          // Moved out past the horizon: drop any copy stored before it moved.
          del.run(calendarId, r.event_id)
          continue
        }
        up.run(calendarId, r.event_id, r.recurring_event_id, r.original_start_ms, r.summary, r.description, r.location, r.all_day, r.start_ms, r.end_ms, r.start_day, r.end_day, r.event_tz, r.updated)
        upserted++
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return { upserted, deleted }
}

/**
 * Disconnect (design decision D2): sync tokens, cached events and the account
 * go; the user's own confirmed/manual links stay, so reconnecting restores
 * them. They hold nothing from Google beyond an event id.
 */
export function forgetCalendarData(db: CalDb): void {
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM calendar_events').run()
    db.prepare('DELETE FROM calendar_calendars').run()
    db.prepare('DELETE FROM calendar_accounts').run()
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
