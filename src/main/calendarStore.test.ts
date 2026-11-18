import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  CALENDAR_SCHEMA_SQL,
  applyEventChanges,
  forgetCalendarData,
  getAccount,
  saveAccount,
  saveCalendar,
  syncTokenOf,
  FUTURE_HORIZON_MS
} from './calendarStore.ts'
import { normalizeEvent, type EventChange } from './eventNormalize.ts'

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(CALENDAR_SCHEMA_SQL)
  db.exec(CALENDAR_SCHEMA_SQL) // runs on every launch: must be idempotent
  return db
}
const ev = (id: string, iso: string): EventChange => normalizeEvent({ id, summary: id, start: { dateTime: iso }, end: { dateTime: iso } })
const ids = (db: DatabaseSync): string[] => (db.prepare('SELECT event_id FROM calendar_events ORDER BY event_id').all() as { event_id: string }[]).map((r) => r.event_id)

test('pages upsert and delete; a re-sent event replaces its row', () => {
  const db = makeDb()
  const now = Date.parse('2026-11-18T00:00:00Z')
  assert.deepEqual(applyEventChanges(db, 'primary', [ev('a', '2026-11-18T04:30:00Z'), ev('b', '2026-11-19T04:30:00Z')], now), { upserted: 2, deleted: 0 })
  applyEventChanges(db, 'primary', [normalizeEvent({ id: 'a', summary: 'renamed', start: { dateTime: '2026-11-18T05:00:00Z' } }), normalizeEvent({ id: 'b', status: 'cancelled' })], now)
  assert.deepEqual(ids(db), ['a'])
  assert.equal((db.prepare('SELECT summary FROM calendar_events').get() as { summary: string }).summary, 'renamed')
})

test('instances past the horizon are not stored, and one that moves out is dropped', () => {
  const db = makeDb()
  const now = Date.parse('2026-11-18T00:00:00Z')
  const far = new Date(now + FUTURE_HORIZON_MS + 86_400_000).toISOString()
  applyEventChanges(db, 'primary', [ev('near', '2026-12-01T00:00:00Z'), ev('far', far)], now)
  assert.deepEqual(ids(db), ['near'])
  applyEventChanges(db, 'primary', [ev('near', far)], now)
  assert.deepEqual(ids(db), [])
})

test('a failing page leaves the cache exactly as it was', () => {
  const db = makeDb()
  applyEventChanges(db, 'primary', [ev('keep', '2026-11-18T04:30:00Z')])
  const bad = { kind: 'upsert', row: { event_id: 'x', start_ms: null } } as never
  assert.throws(() => applyEventChanges(db, 'primary', [ev('new', '2026-11-18T05:00:00Z'), bad]))
  assert.deepEqual(ids(db), ['keep'], 'rolled back, nothing half-applied')
})

test('disconnect forgets Google data but keeps the user\'s own links (D2)', () => {
  const db = makeDb()
  saveAccount(db, { email: 'me@example.com', status: 'connected', connected_at: '2026-11-18T00:00:00Z' })
  saveCalendar(db, 'primary', { sync_token: 'tok1' })
  applyEventChanges(db, 'primary', [ev('a', '2026-11-18T04:30:00Z')])
  db.prepare("INSERT INTO event_file_links VALUES ('E:\\x.jpg', 'VOL', 'primary', 'a', 'confirmed', '2026-11-18')").run()
  forgetCalendarData(db)
  assert.equal(getAccount(db), null)
  assert.equal(syncTokenOf(db, 'primary'), null)
  assert.deepEqual(ids(db), [])
  assert.equal((db.prepare('SELECT COUNT(*) n FROM event_file_links').get() as { n: number }).n, 1)
})

test('account fields merge rather than wipe each other', () => {
  const db = makeDb()
  saveAccount(db, { email: 'me@example.com', status: 'connected', connected_at: 'T0' })
  saveAccount(db, { last_sync_at: 'T1' })
  saveAccount(db, { status: 'expired', last_error: 'reconnect needed' })
  assert.deepEqual({ ...getAccount(db) }, { email: 'me@example.com', status: 'expired', connected_at: 'T0', last_sync_at: 'T1', last_error: 'reconnect needed' })
})
