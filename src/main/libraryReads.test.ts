import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { pageSql, type LibraryQuery } from './libraryQuery.ts'
import { LibraryReads, EPOCH_SCHEMA_SQL, type ReadDb } from './libraryReads.ts'

/**
 * Pages are now served from an ordering computed once per catalogue version
 * instead of re-sorting the volume per page (86-231ms each on the main thread,
 * measured on a 41k-file drive). These pin the two things that change could
 * break: the pages must be exactly the old OFFSET pages, and a cached ordering
 * must never outlive a change to what it orders.
 */

const VOL = '\\\\?\\Volume{AAAA}\\'

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL, name TEXT, ext TEXT, size INTEGER,
      date TEXT, year TEXT, month TEXT, lat REAL, lng REAL,
      drive TEXT, favourited INTEGER DEFAULT 0, thumb TEXT,
      locked INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, vault_path TEXT,
      trashed_at TEXT, mtime INTEGER, hash TEXT, ino INTEGER,
      volume_id TEXT, exif_checked INTEGER DEFAULT 0
    );
  `)
  db.exec(EPOCH_SCHEMA_SQL)
  const insert = db.prepare(
    `INSERT INTO files (path, name, ext, size, date, year, month, lat, lng, drive, favourited, thumb, hidden, trashed_at, volume_id)
     VALUES (?,?,?,?,?,?,?,?,?,'D:',?,?,?,?,?)`
  )
  let n = 0
  const add = (folder: string, ext: string, date: string | null, extra: { lat?: number; fav?: number; hidden?: number; trashed?: string; vol?: string } = {}): void => {
    const name = `F_${n++}${ext}`
    insert.run(`D:\\${folder}\\${name}`, name, ext, 1, date, date?.slice(0, 4) ?? null, 'M', extra.lat ?? null, extra.lat ? 77.5 : null, extra.fav ?? 0, null, extra.hidden ?? 0, extra.trashed ?? null, extra.vol ?? VOL)
  }
  // Shared timestamps (only the path tie-break orders them), documents that
  // pack into compact cells, undated rows, located rows, favourites, and rows
  // that must never appear (hidden, trashed, another volume).
  for (let day = 1; day <= 9; day++) {
    const date = `2025-0${(day % 3) + 1}-1${day}T12:00:00.000Z`
    for (let i = 0; i < 11; i++) add(i % 2 ? 'A' : 'B', ['.jpg', '.mov', '.pdf', '.heic'][i % 4], date, { lat: i % 3 ? 12.9 + day * 0.5 : undefined, fav: i % 5 === 0 ? 1 : 0 })
  }
  add('U', '.jpg', null)
  add('U', '.mov', null)
  add('X', '.jpg', '2025-01-11T12:00:00.000Z', { hidden: 1 })
  add('X', '.jpg', '2025-01-11T12:00:00.000Z', { trashed: '2025-05-01' })
  add('X', '.jpg', '2025-01-11T12:00:00.000Z', { vol: '\\\\?\\Volume{BBBB}\\' })
  return db
}

const q = (over: Partial<LibraryQuery> = {}): LibraryQuery => ({
  drive: 'D:', volumeId: VOL, nav: 'all', search: '', groupBy: 'day', order: 'default', bbox: null, ...over
})

function offsetWalk(db: DatabaseSync, query: LibraryQuery, size: number): string[] {
  const p = pageSql(query)
  const out: string[] = []
  for (let off = 0; ; off += size) {
    const batch = db.prepare(p.sql).all(...(p.params as never[]), size, off) as { path: string }[]
    out.push(...batch.map((r) => r.path))
    if (batch.length < size) return out
  }
}

function cachedWalk(reads: LibraryReads, query: LibraryQuery, size: number): string[] {
  const out: string[] = []
  for (let off = 0; ; off += size) {
    const batch = reads.page(query, off, size).rows as { path: string }[]
    out.push(...batch.map((r) => r.path))
    if (batch.length < size) return out
  }
}

test('pages from the cached ordering are exactly the OFFSET pages, for every grouping and order', () => {
  const db = makeDb()
  const reads = new LibraryReads(db as unknown as ReadDb)
  for (const groupBy of ['day', 'month', 'year', 'location', 'favorites'] as const) {
    for (const order of ['default', 'reverse'] as const) {
      for (const nav of ['all', 'photos', 'videos', 'docs', 'places', 'favourites'] as const) {
        const query = q({ groupBy, order, nav })
        const expected = offsetWalk(db, query, 7)
        assert.deepEqual(cachedWalk(reads, query, 7), expected, `${groupBy}/${order}/${nav}`)
        assert.equal(new Set(expected).size, expected.length, 'no row twice')
      }
    }
  }
})

test('a page carries every column the grid draws, and nothing it does not', () => {
  const db = makeDb()
  const row = new LibraryReads(db as unknown as ReadDb).page(q(), 0, 1).rows[0]
  assert.deepEqual(Object.keys(row).sort(), ['date', 'drive', 'ext', 'favourited', 'lat', 'lng', 'month', 'name', 'path', 'size', 'thumb', 'volume_id', 'year'])
})

test('a membership change moves the version and the next page reflects it', () => {
  const db = makeDb()
  const reads = new LibraryReads(db as unknown as ReadDb)
  const before = reads.page(q(), 0, 5)
  db.prepare(
    `INSERT INTO files (path, name, ext, size, date, drive, volume_id) VALUES ('D:\\New\\newest.jpg', 'newest.jpg', '.jpg', 1, '2030-01-01T00:00:00.000Z', 'D:', ?)`
  ).run(VOL)
  const after = reads.page(q(), 0, 5)
  assert.notEqual(after.version, before.version)
  assert.equal((after.rows[0] as { path: string }).path, 'D:\\New\\newest.jpg')
  // Trash and restore move it too.
  db.prepare("UPDATE files SET trashed_at = 'now' WHERE path = 'D:\\New\\newest.jpg'").run()
  assert.notEqual(reads.page(q(), 0, 5).version, after.version)
  assert.notEqual((reads.page(q(), 0, 5).rows[0] as { path: string }).path, 'D:\\New\\newest.jpg')
})

test('thumbnails and favourites do not move the version, so the grid is not re-laid out for them', () => {
  const db = makeDb()
  const reads = new LibraryReads(db as unknown as ReadDb)
  const v = reads.version()
  db.prepare("UPDATE files SET thumb = 'C:\\t.jpg', exif_checked = 1").run()
  db.prepare('UPDATE files SET favourited = 1 - favourited').run()
  assert.equal(reads.version(), v)
})

test('favourite-dependent queries are never served from a stale ordering', () => {
  const db = makeDb()
  const reads = new LibraryReads(db as unknown as ReadDb)
  const fq = q({ nav: 'favourites' })
  const before = cachedWalk(reads, fq, 50)
  db.prepare('UPDATE files SET favourited = 1 WHERE favourited = 0 AND hidden = 0 AND trashed_at IS NULL').run()
  const after = cachedWalk(reads, fq, 50)
  assert.ok(after.length > before.length)
  assert.deepEqual(after, offsetWalk(db, fq, 50))
})
