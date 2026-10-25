import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { UPDATE_THUMB_SQL, RECORD_THUMB_FAILURE_SQL } from './thumbRecords.ts'

const A = '\\\\?\\Volume{AAAA}\\'
const B = '\\\\?\\Volume{BBBB}\\'
const P = 'E:\\DCIM\\100APPLE\\IMG_0001.JPG'

/** The same camera path on two cards, plus a row from before volume identity. */
function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE files (
    id INTEGER PRIMARY KEY, path TEXT NOT NULL, volume_id TEXT, thumb TEXT,
    thumb_fail_count INTEGER DEFAULT 0, thumb_fail_sig TEXT
  )`)
  const add = db.prepare('INSERT INTO files (id, path, volume_id) VALUES (?, ?, ?)')
  add.run(1, P, A)
  add.run(2, P, B)
  add.run(3, 'E:\\old.jpg', null)
  return db
}
const row = (db: DatabaseSync, id: number): Record<string, unknown> =>
  db.prepare('SELECT thumb, thumb_fail_count, thumb_fail_sig FROM files WHERE id = ?').get(id) as Record<string, unknown>

test("a thumbnail lands on the mounted card's row only", () => {
  const db = makeDb()
  db.prepare(UPDATE_THUMB_SQL).run('C:\\thumbs\\a.jpg', P, A, A)
  assert.equal(row(db, 1).thumb, 'C:\\thumbs\\a.jpg')
  assert.equal(row(db, 2).thumb, null, "card B's row must not show card A's picture")
})

test('a row from before volume identity still gets its thumbnail', () => {
  const db = makeDb()
  db.prepare(UPDATE_THUMB_SQL).run('C:\\thumbs\\o.jpg', 'E:\\old.jpg', A, A)
  assert.equal(row(db, 3).thumb, 'C:\\thumbs\\o.jpg')
})

test('an unverified letter is not scoped, as before', () => {
  const db = makeDb()
  db.prepare(UPDATE_THUMB_SQL).run('C:\\thumbs\\u.jpg', P, null, null)
  assert.equal(row(db, 1).thumb, 'C:\\thumbs\\u.jpg')
  assert.equal(row(db, 2).thumb, 'C:\\thumbs\\u.jpg')
})

test('failures count on the mounted card only, and restart when the file changes', () => {
  const db = makeDb()
  const fail = (sig: string | null): void => void db.prepare(RECORD_THUMB_FAILURE_SQL).run(sig, sig, P, A, A)
  fail('10:1')
  fail('10:1')
  assert.equal(row(db, 1).thumb_fail_count, 2)
  assert.equal(row(db, 2).thumb_fail_count, 0)
  fail('11:2')
  assert.deepEqual({ ...row(db, 1) }, { thumb: null, thumb_fail_count: 1, thumb_fail_sig: '11:2' })
  // Success clears it.
  db.prepare(UPDATE_THUMB_SQL).run('C:\\thumbs\\a.jpg', P, A, A)
  assert.equal(row(db, 1).thumb_fail_count, 0)
  assert.equal(row(db, 1).thumb_fail_sig, null)
})
