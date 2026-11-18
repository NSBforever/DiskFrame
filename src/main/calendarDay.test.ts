import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { CALENDAR_SCHEMA_SQL, applyEventChanges } from './calendarStore.ts'
import { normalizeEvent } from './eventNormalize.ts'
import { dayEvents, setLink } from './calendarDay.ts'

const VOL = 'VOL-E'
// Local wall-clock times, so the test means the same thing in any zone.
const at = (d: number, h: number, m = 0): Date => new Date(2026, 10, d, h, m)

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(CALENDAR_SCHEMA_SQL)
  db.exec(`CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT, volume_id TEXT, name TEXT, ext TEXT, thumb TEXT, date TEXT,
           date_source TEXT DEFAULT 'mtime', hidden INTEGER DEFAULT 0, trashed_at TEXT)`)
  return db
}
const file = (db: DatabaseSync, name: string, when: Date, source = 'exif', opts: { vol?: string; trashed?: boolean } = {}): void => {
  const ext = name.slice(name.lastIndexOf('.'))
  db.prepare('INSERT INTO files (path, volume_id, name, ext, date, date_source, trashed_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    `E:\\${name}`,
    opts.vol ?? VOL,
    name,
    ext,
    when.toISOString(),
    source,
    opts.trashed ? 'T' : null
  )
}
const event = (db: DatabaseSync, id: string, from: Date, to: Date): void => {
  applyEventChanges(db, 'primary', [normalizeEvent({ id, summary: id, start: { dateTime: from.toISOString() }, end: { dateTime: to.toISOString() } })], from.getTime())
}
const view = (db: DatabaseSync, day = '2026-11-18'): Record<string, string[]> =>
  Object.fromEntries(dayEvents(db, day, VOL, 30).map((e) => [e.eventId, e.files.map((f) => `${f.name}:${f.status}`)]))

test('a day lists its events with suggested files from the right volume only', () => {
  const db = makeDb()
  event(db, 'team', at(18, 10), at(18, 11, 30))
  file(db, 'IMG_1.jpg', at(18, 10, 15))
  file(db, 'clip.mov', at(18, 10, 45), 'quicktime')
  file(db, 'Notes.pdf', at(18, 11, 10), 'mtime')
  file(db, 'other-drive.jpg', at(18, 10, 20), 'exif', { vol: 'VOL-G' })
  file(db, 'binned.jpg', at(18, 10, 25), 'exif', { trashed: true })
  file(db, 'yesterday.jpg', at(17, 10, 15))
  assert.deepEqual(view(db), { team: ['IMG_1.jpg:suggested', 'clip.mov:suggested'] })
  assert.deepEqual(dayEvents(db, '2026-11-19', VOL, 30), [], 'a day without events is empty')
  assert.deepEqual(dayEvents(db, '2026-11-18', null, 30), [], 'no verified volume, no answer')
})

test('confirm, reject, undo, and a file linked by hand from another day', () => {
  const db = makeDb()
  event(db, 'team', at(18, 10), at(18, 11))
  file(db, 'a.jpg', at(18, 10, 10))
  file(db, 'b.jpg', at(18, 10, 20))
  file(db, 'scan.pdf', at(2, 9, 0), 'mtime')
  setLink(db, 'confirm', 'E:\\a.jpg', VOL, 'primary', 'team')
  setLink(db, 'reject', 'E:\\b.jpg', VOL, 'primary', 'team')
  setLink(db, 'manual', 'E:\\scan.pdf', VOL, 'primary', 'team')
  assert.deepEqual(view(db), { team: ['scan.pdf:manual', 'a.jpg:confirmed'] })
  setLink(db, 'undo', 'E:\\b.jpg', VOL, 'primary', 'team')
  assert.deepEqual(view(db), { team: ['scan.pdf:manual', 'a.jpg:confirmed', 'b.jpg:suggested'] })
  db.prepare("UPDATE files SET trashed_at = 'T' WHERE name = 'scan.pdf'").run()
  assert.deepEqual(view(db), { team: ['a.jpg:confirmed', 'b.jpg:suggested'] }, 'a link to a trashed file shows nothing')
})

test('all-day events are listed for context, with no suggestions', () => {
  const db = makeDb()
  applyEventChanges(db, 'primary', [normalizeEvent({ id: 'diwali', summary: 'Diwali', start: { date: '2026-11-18' }, end: { date: '2026-11-19' } })], at(18, 0).getTime())
  file(db, 'lamp.jpg', at(18, 19))
  const d = dayEvents(db, '2026-11-18', VOL, 30)
  assert.deepEqual(d.map((e) => [e.eventId, e.allDay, e.files.length]), [['diwali', true, 0]])
})

test('a file just before midnight goes to the evening event it belongs to, not the next day\'s', () => {
  const db = makeDb()
  event(db, 'party', at(17, 22), at(17, 23, 50))
  event(db, 'early', at(18, 0, 10), at(18, 1))
  file(db, 'late.jpg', at(17, 23, 58)) // 8 min after party, 12 min before early
  assert.deepEqual(view(db, '2026-11-18'), { early: [] }, 'asking for the 18th does not steal it')
  assert.deepEqual(view(db, '2026-11-17'), { party: ['late.jpg:suggested'] })
})
