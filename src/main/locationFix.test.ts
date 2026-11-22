import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  REPAIR_GPS_SQL,
  RESTORE_LOCATION_SQL,
  UPDATE_EXIF_SQL,
  UPDATE_GPS_ONLY_SQL,
  parseLocationTarget,
  setLocationSql
} from './locationFix.ts'
import type { LibraryQuery } from './libraryQuery.ts'

const q: LibraryQuery = {
  drive: 'C:',
  volumeId: 'VOL-C',
  nav: 'all',
  search: '',
  groupBy: 'day',
  order: 'default'
}
// The owner's case: Windows Camera wrote a Chennai position on photos taken in Vellore.
const WRONG = { lat: 13.1811795, lng: 80.0993575 }
const VELLORE = { lat: 12.9724, lng: 79.1595 }
const box = { minLat: 13.18, maxLat: 13.183, minLng: 80.098, maxLng: 80.101 }

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE files (path TEXT, name TEXT, ext TEXT, date TEXT, year TEXT, month TEXT,
    lat REAL, lng REAL, drive TEXT, volume_id TEXT, hidden INTEGER DEFAULT 0, trashed_at TEXT,
    date_source TEXT, date_offset_min INTEGER, loc_override INTEGER)`)
  const ins = db.prepare(`INSERT INTO files (path, name, ext, lat, lng, drive, volume_id) VALUES (?, ?, '.jpg', ?, ?, 'C:', 'VOL-C')`)
  ins.run('C:\\Camera Roll\\WIN_1.jpg', 'WIN_1.jpg', WRONG.lat, WRONG.lng)
  ins.run('C:\\Camera Roll\\WIN_2.jpg', 'WIN_2.jpg', WRONG.lat, WRONG.lng)
  ins.run('C:\\Phone\\IMG_1.jpg', 'IMG_1.jpg', VELLORE.lat, VELLORE.lng)
  return db
}

function pos(db: DatabaseSync, path: string): { lat: number | null; lng: number | null; loc_override: number | null } {
  return db.prepare('SELECT lat, lng, loc_override FROM files WHERE path = ?').get(path) as never
}

function apply(db: DatabaseSync, query: LibraryQuery, to: { lat: number; lng: number } | null): number {
  const s = setLocationSql(query, to)
  assert.ok(s)
  return Number(db.prepare(s.sql).run(...(s.params as never[])).changes)
}

test('a correction without a map box is refused: it must never touch the whole library', () => {
  assert.equal(setLocationSql(q, VELLORE), null)
  assert.equal(setLocationSql({ ...q, bbox: null }, null), null)
})

test('moving a place rewrites only the files inside its box and marks them corrected', () => {
  const db = makeDb()
  assert.equal(apply(db, { ...q, bbox: box }, VELLORE), 2)
  assert.deepEqual({ ...pos(db, 'C:\\Camera Roll\\WIN_1.jpg') }, { ...VELLORE, loc_override: 1 })
  assert.deepEqual({ ...pos(db, 'C:\\Phone\\IMG_1.jpg') }, { ...VELLORE, loc_override: null }, 'a file elsewhere is untouched')
})

test('removing a place takes its files off the map, marked corrected', () => {
  const db = makeDb()
  assert.equal(apply(db, { ...q, bbox: box }, null), 2)
  assert.deepEqual({ ...pos(db, 'C:\\Camera Roll\\WIN_2.jpg') }, { lat: null, lng: null, loc_override: 1 })
})

test("the EXIF re-read never puts the file's wrong position back over a correction", () => {
  const p = 'C:\\Camera Roll\\WIN_1.jpg'
  const removed = makeDb()
  apply(removed, { ...q, bbox: box }, null)
  // The backfill's three writes, each with the position the file itself carries.
  removed.prepare(UPDATE_EXIF_SQL).run('2025-01-31T13:08:44.000Z', '2025', 'January', WRONG.lat, WRONG.lng, 'exif', null, p, 'VOL-C')
  removed.prepare(UPDATE_GPS_ONLY_SQL).run(WRONG.lat, WRONG.lng, p, 'VOL-C')
  removed.prepare(REPAIR_GPS_SQL).run(WRONG.lat, WRONG.lng, p, 'VOL-C')
  assert.deepEqual({ ...pos(removed, p) }, { lat: null, lng: null, loc_override: 1 })
  // The date still lands: only the position is protected.
  assert.equal((removed.prepare('SELECT date FROM files WHERE path = ?').get(p) as { date: string }).date, '2025-01-31T13:08:44.000Z')

  const moved = makeDb()
  apply(moved, { ...q, bbox: box }, VELLORE)
  moved.prepare(REPAIR_GPS_SQL).run(WRONG.lat, WRONG.lng, p, 'VOL-C')
  assert.deepEqual({ ...pos(moved, p) }, { ...VELLORE, loc_override: 1 })
})

test('uncorrected files are still written by the EXIF backfill as before', () => {
  const db = makeDb()
  db.prepare('UPDATE files SET lat = NULL, lng = NULL').run()
  const p = 'C:\\Phone\\IMG_1.jpg'
  db.prepare(UPDATE_EXIF_SQL).run('2024-01-01T00:00:00.000Z', '2024', 'January', VELLORE.lat, VELLORE.lng, 'exif', 330, p, 'VOL-C')
  assert.deepEqual({ ...pos(db, p) }, { ...VELLORE, loc_override: null })
})

test("restoring puts back the file's own position and clears the correction", () => {
  const db = makeDb()
  apply(db, { ...q, bbox: box }, VELLORE)
  const p = 'C:\\Camera Roll\\WIN_1.jpg'
  db.prepare(RESTORE_LOCATION_SQL).run(WRONG.lat, WRONG.lng, p, 'VOL-C')
  assert.deepEqual({ ...pos(db, p) }, { ...WRONG, loc_override: null })
})

test('a target is either null (remove) or a real position on Earth', () => {
  assert.equal(parseLocationTarget(null), null)
  assert.deepEqual(parseLocationTarget({ lat: 12.97, lng: 79.16 }), { lat: 12.97, lng: 79.16 })
  for (const bad of [undefined, {}, { lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { lat: 'x', lng: 1 }, { lat: NaN, lng: 1 }, 5])
    assert.equal(parseLocationTarget(bad), undefined, JSON.stringify(bad))
})
