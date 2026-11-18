import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { CALENDAR_SCHEMA_SQL, applyEventChanges } from './calendarStore.ts'
import { normalizeEvent } from './eventNormalize.ts'
import { eventCards, eventDetail, pickerFiles, pickCover, setLink } from './calendarEvents.ts'

const VOL = 'VOL-E'
// Local wall-clock times, so the tests mean the same thing in any zone.
const at = (d: number, h: number, m = 0): Date => new Date(2026, 10, d, h, m)

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(CALENDAR_SCHEMA_SQL)
  db.exec(`CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT, volume_id TEXT, name TEXT, ext TEXT, thumb TEXT, date TEXT,
           date_source TEXT DEFAULT 'mtime', hidden INTEGER DEFAULT 0, trashed_at TEXT,
           size INTEGER DEFAULT 1, year TEXT, month TEXT, lat REAL, lng REAL, drive TEXT DEFAULT 'E:', favourited INTEGER DEFAULT 0)`)
  return db
}
const file = (db: DatabaseSync, name: string, when: Date, source = 'exif', o: { vol?: string; trashed?: boolean; lat?: number; lng?: number } = {}): void => {
  db.prepare('INSERT INTO files (path, volume_id, name, ext, date, date_source, trashed_at, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    `E:\\${name}`,
    o.vol ?? VOL,
    name,
    name.slice(name.lastIndexOf('.')),
    when.toISOString(),
    source,
    o.trashed ? 'T' : null,
    o.lat ?? null,
    o.lng ?? null
  )
}
const event = (db: DatabaseSync, id: string, from: Date, to: Date, location = ''): void => {
  applyEventChanges(db, 'primary', [normalizeEvent({ id, summary: id, location, start: { dateTime: from.toISOString() }, end: { dateTime: to.toISOString() } })], from.getTime())
}
const allDay = (db: DatabaseSync, id: string, from: string, toExcl: string): void => {
  applyEventChanges(db, 'primary', [normalizeEvent({ id, summary: id, start: { date: from }, end: { date: toExcl } })], at(1, 0).getTime())
}
const NOW = at(30, 12).getTime()
const cards = (db: DatabaseSync): Record<string, string> =>
  Object.fromEntries(eventCards(db, VOL, 30, NOW).cards.map((c) => [c.eventId, `${c.confirmed}+${c.suggested}`]))
const detail = (db: DatabaseSync, id: string): string[] => (eventDetail(db, VOL, 'primary', id, 30)?.files ?? []).map((f) => `${f.name}:${f.status}`)

test('the Events list: events with files from this volume, newest first; the rest apart', () => {
  const db = makeDb()
  event(db, 'team', at(18, 10), at(18, 11, 30), 'Room 4')
  event(db, 'dinner', at(20, 19), at(20, 21))
  event(db, 'standup', at(18, 9, 30), at(18, 9, 45))
  file(db, 'IMG_1.jpg', at(18, 10, 15))
  file(db, 'clip.mov', at(18, 10, 45), 'quicktime')
  file(db, 'Notes.pdf', at(18, 11, 10), 'mtime')
  file(db, 'other-drive.jpg', at(18, 10, 20), 'exif', { vol: 'VOL-G' })
  file(db, 'binned.jpg', at(18, 10, 25), 'exif', { trashed: true })
  file(db, 'dinner.jpg', at(20, 19, 30))
  const list = eventCards(db, VOL, 30, NOW)
  assert.deepEqual(list.cards.map((c) => c.eventId), ['dinner', 'team'])
  assert.deepEqual(cards(db), { team: '0+2', dinner: '0+1' })
  assert.equal(list.cards[1].location, 'Room 4', 'the calendar location, verbatim')
  assert.deepEqual(list.others.map((o) => o.eventId), ['standup'], 'no photos: listed apart, not as a card')
  assert.deepEqual(eventCards(db, null, 30, NOW), { cards: [], others: [] }, 'no verified volume, no answer')
})

test('list and detail agree, and decisions win: confirm, reject, undo, manual, trash', () => {
  const db = makeDb()
  event(db, 'team', at(18, 10), at(18, 11))
  file(db, 'a.jpg', at(18, 10, 10))
  file(db, 'b.jpg', at(18, 10, 20))
  file(db, 'scan.pdf', at(2, 9, 0), 'mtime')
  setLink(db, 'confirm', 'E:\\a.jpg', VOL, 'primary', 'team')
  setLink(db, 'reject', 'E:\\b.jpg', VOL, 'primary', 'team')
  setLink(db, 'manual', 'E:\\scan.pdf', VOL, 'primary', 'team')
  assert.deepEqual(detail(db, 'team'), ['scan.pdf:manual', 'a.jpg:confirmed'])
  assert.deepEqual(cards(db), { team: '2+0' })
  setLink(db, 'undo', 'E:\\b.jpg', VOL, 'primary', 'team')
  assert.deepEqual(detail(db, 'team'), ['scan.pdf:manual', 'a.jpg:confirmed', 'b.jpg:suggested'])
  assert.deepEqual(cards(db), { team: '2+1' })
  db.prepare("UPDATE files SET trashed_at = 'T' WHERE name = 'scan.pdf'").run()
  assert.deepEqual(detail(db, 'team'), ['a.jpg:confirmed', 'b.jpg:suggested'], 'a link to a trashed file shows nothing')
})

test('a photo just before midnight belongs to the evening event, in the list and on its page', () => {
  const db = makeDb()
  event(db, 'party', at(17, 22), at(17, 23, 50))
  event(db, 'early', at(18, 0, 10), at(18, 1))
  file(db, 'late.jpg', at(17, 23, 58)) // 8 min after party, 12 min before early
  assert.deepEqual(cards(db), { party: '0+1' })
  assert.deepEqual(detail(db, 'party'), ['late.jpg:suggested'])
  assert.deepEqual(detail(db, 'early'), [])
})

test('a trip (all-day, several days) holds only what the user adds; the picker offers its days', () => {
  const db = makeDb()
  allDay(db, 'goa', '2026-11-05', '2026-11-08')
  file(db, 'beach.jpg', at(6, 11))
  file(db, 'copied.jpg', at(6, 15), 'mtime')
  file(db, 'after.jpg', at(9, 10))
  assert.deepEqual(cards(db), {}, 'never suggested')
  const offer = pickerFiles(db, VOL, 'primary', 'goa').map((f) => f.name)
  assert.deepEqual(offer, ['beach.jpg', 'copied.jpg'], "the trip's days, file-dated copies included, nothing after")
  setLink(db, 'manual', 'E:\\copied.jpg', VOL, 'primary', 'goa')
  assert.deepEqual(cards(db), { goa: '1+0' })
  assert.deepEqual(pickerFiles(db, VOL, 'primary', 'goa').map((f) => f.name), ['beach.jpg'], 'already added: not offered again')
})

test('the cover: a confirmed photo, else the best suggestion; a video only without photos', () => {
  const f = (name: string, status: 'confirmed' | 'suggested' | 'manual', score: number): never => ({ path: name, name, ext: name.slice(-4), status, score, date: '2026' }) as never
  assert.equal(pickCover([f('v.mov', 'confirmed', 1), f('s.jpg', 'suggested', 0.85), f('c.jpg', 'confirmed', 1)])!.path, 'c.jpg')
  assert.equal(pickCover([f('s1.jpg', 'suggested', 0.7), f('s2.jpg', 'suggested', 0.85)])!.path, 's2.jpg')
  assert.equal(pickCover([f('v.mov', 'suggested', 0.85)])!.path, 'v.mov')
  assert.equal(pickCover([]), null)
})

test("the detail page gives the photos' GPS centre, never a made-up place", () => {
  const db = makeDb()
  event(db, 'walk', at(18, 10), at(18, 11))
  file(db, 'a.jpg', at(18, 10, 10), 'exif', { lat: 17.0, lng: 78.0 })
  file(db, 'b.jpg', at(18, 10, 20), 'exif', { lat: 17.2, lng: 78.4 })
  file(db, 'c.jpg', at(18, 10, 30))
  const d = eventDetail(db, VOL, 'primary', 'walk', 30)!
  assert.equal(d.location, '', 'no calendar location stays empty')
  assert.ok(Math.abs(d.gps!.lat - 17.1) < 1e-9 && Math.abs(d.gps!.lng - 78.2) < 1e-9)
  assert.equal(eventDetail(db, VOL, 'primary', 'nope', 30), null)
})
