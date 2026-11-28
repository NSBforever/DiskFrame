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
      volume_id TEXT, exif_checked INTEGER DEFAULT 0, thumb_fail_count INTEGER DEFAULT 0
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

test('the background tier is fed newest first, only rows still owed and still worth trying', () => {
  const db = makeDb()
  const reads = new LibraryReads(db as unknown as ReadDb)
  db.prepare("UPDATE files SET thumb = 'C:\\t.jpg' WHERE ext = '.jpg'").run()
  db.prepare("UPDATE files SET thumb_fail_count = 3 WHERE ext = '.heic'").run()
  const owed = reads.owedThumbnails(VOL, ['.jpg', '.mov', '.heic'], 3, 1000)
  const rows = owed.map((p) => db.prepare('SELECT ext, date, trashed_at, volume_id FROM files WHERE path = ?').get(p) as { ext: string; date: string | null; trashed_at: string | null; volume_id: string })
  assert.ok(owed.length > 0)
  assert.ok(rows.every((r) => r.ext === '.mov' && r.trashed_at === null && r.volume_id === VOL), 'thumbnailed, exhausted, trashed and foreign rows are left out')
  const dates = rows.map((r) => r.date ?? '')
  assert.deepEqual(dates, [...dates].sort().reverse(), 'newest first')
  assert.equal(reads.owedThumbnails(VOL, ['.mov'], 3, 2).length, 2, 'bounded')
})

test('folders groups a volume by folder with counts that add up to its rows', () => {
  const db = makeDb()
  const groups = new LibraryReads(db as unknown as ReadDb).folders(VOL)
  const live = (db.prepare('SELECT COUNT(*) n FROM files WHERE volume_id = ? AND hidden = 0 AND trashed_at IS NULL').get(VOL) as { n: number }).n
  assert.equal(groups.reduce((a, g) => a + g.count, 0), live)
  assert.deepEqual(groups.map((g) => g.folder).sort(), ['D:\\A', 'D:\\B', 'D:\\U'])
  for (const g of groups) assert.ok(g.sample.startsWith(g.folder + '\\'))
})

// ── Size sort ────────────────────────────────────────────────────────────────

/** makeDb with real byte counts: repeated sizes (ties) and a few never recorded. */
function sizedDb(): DatabaseSync {
  const db = makeDb()
  db.prepare('UPDATE files SET size = (id * 7919) % 23 * 1000').run()
  db.prepare('UPDATE files SET size = NULL WHERE id % 13 = 0').run()
  return db
}

type Row = { path: string; size: number | null; date: string | null; ext: string }

function walkRows(reads: LibraryReads, query: LibraryQuery): Row[] {
  const out: Row[] = []
  for (let off = 0; ; off += 9) {
    const batch = reads.page(query, off, 9).rows as Row[]
    out.push(...batch)
    if (batch.length < 9) return out
  }
}

/** Expected comparison inside one group: known sizes first, by size, then date, then path. */
function sizeCmp(dir: 'size-desc' | 'size-asc', order: 'default' | 'reverse') {
  return (a: Row, b: Row): number => {
    if ((a.size === null) !== (b.size === null)) return a.size === null ? 1 : -1
    if (a.size !== b.size) return dir === 'size-desc' ? b.size! - a.size! : a.size! - b.size!
    const da = a.date ?? ''
    const db = b.date ?? ''
    if (da !== db) return order === 'default' ? (da < db ? 1 : -1) : da < db ? -1 : 1
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  }
}

test('a size sort orders the files inside every group by stored size, with date then path breaking ties', () => {
  const db = sizedDb()
  const reads = new LibraryReads(db as unknown as ReadDb)
  for (const groupBy of ['day', 'month', 'year', 'location', 'favorites'] as const) {
    for (const order of ['default', 'reverse'] as const) {
      for (const sort of ['size-desc', 'size-asc'] as const) {
        const query = q({ groupBy, order, sort })
        const rows = walkRows(reads, query)
        const summary = reads.summary(query)
        // The groups and their sizes are exactly what the date sort gives:
        // a sort reorders files inside a group, never across groups.
        assert.deepEqual(summary.groups, reads.summary(q({ groupBy, order })).groups, `${groupBy}/${order}/${sort} groups`)
        for (const g of summary.groups) {
          const inGroup = rows.slice(g.offset, g.offset + g.count)
          const media = inGroup.slice(0, g.count - g.compactCount)
          const compact = inGroup.slice(g.count - g.compactCount)
          assert.ok(compact.every((r) => r.ext === '.pdf'), 'previewless files still sit after the rest')
          const cmp = sizeCmp(sort, order)
          assert.deepEqual(media, [...media].sort(cmp), `${groupBy}/${order}/${sort} ${g.key}`)
          assert.deepEqual(compact, [...compact].sort(cmp), `${groupBy}/${order}/${sort} ${g.key} compact`)
        }
        // Cached pages are the plain OFFSET pages: pagination is stable.
        assert.deepEqual(rows.map((r) => r.path), offsetWalk(db, query, 9), `${groupBy}/${order}/${sort} pages`)
      }
    }
  }
})

test('ungrouped, a size sort runs across the whole collection', () => {
  const db = sizedDb()
  const reads = new LibraryReads(db as unknown as ReadDb)
  // Read the date ordering first: the cache must keep the two apart.
  walkRows(reads, q({ groupBy: 'none' }))
  const query = q({ groupBy: 'none', sort: 'size-desc' })
  const summary = reads.summary(query)
  assert.equal(summary.groups.length, 1)
  assert.equal(summary.groups[0].count, summary.total)
  const rows = walkRows(reads, query)
  const media = rows.slice(0, summary.total - summary.groups[0].compactCount)
  assert.deepEqual(media, [...media].sort(sizeCmp('size-desc', 'default')))
  assert.ok(media[0].size! >= media[media.length - 1].size! || media[media.length - 1].size === null)
  const sizes = media.filter((r) => r.size !== null).map((r) => r.size!)
  assert.equal(sizes[0], Math.max(...sizes), 'largest file first')
  const asc = walkRows(reads, q({ groupBy: 'none', sort: 'size-asc' })).filter((r) => r.ext !== '.pdf' && r.size !== null)
  assert.equal(asc[0].size, Math.min(...sizes), 'smallest file first')
})

test('the date sort is untouched by the new key', () => {
  const db = sizedDb()
  const reads = new LibraryReads(db as unknown as ReadDb)
  assert.deepEqual(walkRows(reads, q({ sort: 'date' })), walkRows(reads, q()))
})

test('a change to a file size alone moves the version, so a size ordering is never stale', () => {
  const db = sizedDb()
  const reads = new LibraryReads(db as unknown as ReadDb)
  const query = q({ groupBy: 'none', sort: 'size-desc' })
  const first = walkRows(reads, query)[0]
  const v = reads.version()
  const last = walkRows(reads, query).filter((r) => r.size !== null && r.ext !== '.pdf').at(-1)!
  db.prepare('UPDATE files SET size = ? WHERE path = ?').run(10_000_000, last.path)
  assert.notEqual(reads.version(), v)
  const top = walkRows(reads, query)[0]
  assert.equal(top.path, last.path)
  assert.notEqual(top.path, first.path)
})

test('re-applying the epoch schema upgrades an old trigger that did not watch size', () => {
  const db = makeDb()
  db.exec('DROP TRIGGER files_epoch_update')
  db.exec(`CREATE TRIGGER files_epoch_update AFTER UPDATE OF date ON files BEGIN UPDATE catalogue_epoch SET n = n + 1; END;`)
  db.exec(EPOCH_SCHEMA_SQL)
  const reads = new LibraryReads(db as unknown as ReadDb)
  const v = reads.version()
  db.prepare('UPDATE files SET size = 5 WHERE id = 1').run()
  assert.notEqual(reads.version(), v)
})
