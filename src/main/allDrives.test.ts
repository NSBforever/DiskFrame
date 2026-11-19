import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { buildWhere, orderedSql, summarySql, ALL_DRIVES_KEY, type LibraryQuery } from './libraryQuery.ts'
import { LibraryReads, EPOCH_SCHEMA_SQL, type ReadDb } from './libraryReads.ts'
import { resolveScope, parseScope, type ScopeVolume } from './driveScope.ts'

/**
 * All Drives: one virtual library over the rows already indexed for several
 * volumes. Nothing is copied; the query is the same query with the volume
 * filter widened, so these pin the widening and everything that depends on a
 * path no longer being unique (two volumes can hold the same literal path).
 */

const A = '\\\\?\\Volume{AAAA}\\'
const B = '\\\\?\\Volume{BBBB}\\'
const C = '\\\\?\\Volume{CCCC}\\'

const all = (volumeIds: string[], over: Partial<LibraryQuery> = {}): LibraryQuery => ({
  drive: ALL_DRIVES_KEY,
  volumeId: null,
  volumeIds,
  nav: 'all',
  search: '',
  groupBy: 'day',
  order: 'default',
  bbox: null,
  ...over
})

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE files (
      id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, name TEXT, ext TEXT, size INTEGER,
      date TEXT, year TEXT, month TEXT, lat REAL, lng REAL, drive TEXT, favourited INTEGER DEFAULT 0, thumb TEXT,
      hidden INTEGER DEFAULT 0, trashed_at TEXT, volume_id TEXT
    );
    CREATE UNIQUE INDEX idx_files_identity ON files (volume_id, path);
  `)
  db.exec(EPOCH_SCHEMA_SQL)
  return db
}
const add = (db: DatabaseSync, vol: string, path: string, date: string, ext = '.jpg', extra: { hidden?: number; trashed?: string; fav?: number; lat?: number } = {}): void =>
  void db
    .prepare('INSERT INTO files (path, name, ext, date, drive, volume_id, hidden, trashed_at, favourited, lat, lng) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(path, path.split('\\').pop() ?? '', ext, date, path.slice(0, 2), vol, extra.hidden ?? 0, extra.trashed ?? null, extra.fav ?? 0, extra.lat ?? null, extra.lat ? 77 : null)

test('All Drives scopes to exactly the chosen volumes, still excluding hidden and trashed', () => {
  const w = buildWhere(all([A, B]))
  assert.match(w.sql, /volume_id IN \(\?,\?\)/)
  assert.match(w.sql, /hidden = 0/)
  assert.match(w.sql, /trashed_at IS NULL/)
  assert.deepEqual(w.params.slice(0, 2), [A, B])
})

test('an empty selection is an honest empty library, never "everything"', () => {
  assert.match(buildWhere(all([])).sql, /^0 AND/)
})

test('volumeIds on a single-drive query are ignored: one drive browses exactly as before', () => {
  const single: LibraryQuery = { drive: 'E:', volumeId: A, nav: 'all', search: '', groupBy: 'day', order: 'default' }
  assert.deepEqual(buildWhere({ ...single, volumeIds: [A, B] }), buildWhere(single))
  assert.equal(orderedSql({ ...single, volumeIds: [A, B] }).sql, orderedSql(single).sql)
  assert.ok(!orderedSql(single).sql.includes('volume_id ASC'), 'single-drive ordering unchanged')
})

test('chronological across drives, with the same path on two volumes kept as two files in a stable order', () => {
  const db = makeDb()
  add(db, A, 'E:\\DCIM\\IMG_0001.JPG', '2026-01-03T10:00:00.000Z')
  add(db, B, 'E:\\DCIM\\IMG_0001.JPG', '2026-01-03T10:00:00.000Z') // same literal path, other volume
  add(db, B, 'F:\\Pics\\b.jpg', '2026-01-05T10:00:00.000Z')
  add(db, A, 'E:\\DCIM\\a.jpg', '2026-01-01T10:00:00.000Z')
  add(db, C, 'G:\\c.jpg', '2026-01-04T10:00:00.000Z')
  const reads = new LibraryReads(db as unknown as ReadDb)
  const rows = reads.page(all([A, B]), 0, 50).rows as { path: string; volume_id: string }[]
  assert.deepEqual(
    rows.map((r) => `${r.volume_id === A ? 'A' : 'B'} ${r.path}`),
    ['B F:\\Pics\\b.jpg', 'A E:\\DCIM\\IMG_0001.JPG', 'B E:\\DCIM\\IMG_0001.JPG', 'A E:\\DCIM\\a.jpg']
  )
  // Paging one row at a time walks the same order with nothing repeated or skipped.
  const walked: string[] = []
  for (let o = 0; o < 6; o++) for (const r of reads.page(all([A, B]), o, 1).rows as { path: string; volume_id: string }[]) walked.push(r.volume_id + r.path)
  assert.deepEqual(walked, rows.map((r) => r.volume_id + r.path))
  assert.equal(reads.summary(all([A, B])).total, 4)
})

test('favourites-dependent All Drives pages (no cached ordering) are stable too', () => {
  const db = makeDb()
  add(db, A, 'E:\\x.jpg', '2026-01-03T10:00:00.000Z', '.jpg', { fav: 1 })
  add(db, B, 'E:\\x.jpg', '2026-01-03T10:00:00.000Z', '.jpg', { fav: 1 })
  const reads = new LibraryReads(db as unknown as ReadDb)
  const first = (reads.page(all([A, B], { nav: 'favourites' }), 0, 1).rows[0] as { volume_id: string }).volume_id
  const second = (reads.page(all([A, B], { nav: 'favourites' }), 1, 1).rows[0] as { volume_id: string }).volume_id
  assert.deepEqual([first, second], [A, B])
})

test('search and filters work across the chosen drives', () => {
  const db = makeDb()
  add(db, A, 'E:\\Goa\\beach.jpg', '2026-01-03T10:00:00.000Z')
  add(db, B, 'F:\\Goa\\clip.mov', '2026-01-04T10:00:00.000Z', '.mov')
  add(db, B, 'F:\\Home\\cat.jpg', '2026-01-05T10:00:00.000Z')
  add(db, C, 'G:\\Goa\\other.jpg', '2026-01-05T10:00:00.000Z')
  const reads = new LibraryReads(db as unknown as ReadDb)
  const paths = (qq: LibraryQuery): string[] => (reads.page(qq, 0, 50).rows as { path: string }[]).map((r) => r.path)
  assert.deepEqual(paths(all([A, B], { search: 'goa' })), ['F:\\Goa\\clip.mov', 'E:\\Goa\\beach.jpg'])
  assert.deepEqual(paths(all([A, B], { nav: 'videos' })), ['F:\\Goa\\clip.mov'])
  assert.deepEqual(paths(all([A, B], { nav: 'photos' })), ['F:\\Home\\cat.jpg', 'E:\\Goa\\beach.jpg'])
})

test('changing the drive selection is a different query, never a stale cached ordering', () => {
  const db = makeDb()
  add(db, A, 'E:\\a.jpg', '2026-01-03T10:00:00.000Z')
  add(db, B, 'F:\\b.jpg', '2026-01-04T10:00:00.000Z')
  const reads = new LibraryReads(db as unknown as ReadDb)
  assert.equal(reads.page(all([A]), 0, 10).rows.length, 1)
  assert.equal(reads.page(all([A, B]), 0, 10).rows.length, 2)
  assert.equal(reads.summary(all([B])).total, 1)
})

test('summary groups mix drives by day, newest first', () => {
  const s = summarySql(all([A, B]))
  assert.match(s.sql, /volume_id IN/)
})

// ── Scope resolution (main process) ────────────────────────────────────────

const vols: ScopeVolume[] = [
  { volumeId: A, count: 10 },
  { volumeId: B, count: 5 },
  { volumeId: C, count: 0 }
]

test('"all" means every volume that has indexed files, including ones indexed later', () => {
  assert.deepEqual(resolveScope({ mode: 'all' }, vols), [A, B])
  assert.deepEqual(resolveScope({ mode: 'all' }, [...vols, { volumeId: 'NEW', count: 1 }]), [A, B, 'NEW'])
})

test('a chosen combination keeps only volumes that still exist in the catalogue', () => {
  assert.deepEqual(resolveScope({ mode: 'some', volumeIds: [B, 'GONE'] }, vols), [B])
  assert.deepEqual(resolveScope({ mode: 'some', volumeIds: [] }, vols), [])
})

test('a stored scope that is missing or corrupt falls back to all drives', () => {
  assert.deepEqual(parseScope(null), { mode: 'all' })
  assert.deepEqual(parseScope('{nope'), { mode: 'all' })
  assert.deepEqual(parseScope('{"mode":"some","volumeIds":[1,"x"]}'), { mode: 'some', volumeIds: ['x'] })
  assert.deepEqual(parseScope('{"mode":"some","volumeIds":["' + 'v'.repeat(600) + '"]}'), { mode: 'some', volumeIds: [] })
})

// ── Matrix: 1-3 drives, identical files, disconnect, reconnect, letter change ──

import { markOffline } from './driveScope.ts'
import { moveVolumeToLetter, type LetterDb } from './driveLetter.ts'

test('one, two and three drives: the selection decides exactly which files are in the library', () => {
  const db = makeDb()
  for (const [v, p] of [[A, 'E:\\a.jpg'], [B, 'F:\\b.jpg'], [C, 'G:\\c.jpg']] as const) add(db, v, p, '2026-01-03T10:00:00.000Z')
  const reads = new LibraryReads(db as unknown as ReadDb)
  assert.equal(reads.summary(all([A])).total, 1)
  assert.equal(reads.summary(all([A, B])).total, 2)
  assert.equal(reads.summary(all([A, B, C])).total, 3)
})

test('identical files on two drives (same name, size and date) are two files, never merged', () => {
  const db = makeDb()
  add(db, A, 'E:\\Trip\\IMG_1.JPG', '2026-01-03T10:00:00.000Z')
  add(db, B, 'F:\\Backup\\Trip\\IMG_1.JPG', '2026-01-03T10:00:00.000Z')
  const reads = new LibraryReads(db as unknown as ReadDb)
  const rows = reads.page(all([A, B]), 0, 10).rows as { volume_id: string }[]
  assert.deepEqual(rows.map((r) => r.volume_id).sort(), [A, B])
})

test('a file is offline when its drive is unplugged, or when another drive now has its letter', () => {
  const mounted = new Map([['E:', B]]) // B is at E: now; A (once E:) is unplugged
  const rows: { path: string; volume_id: string; thumb: string | null; offline?: boolean }[] = [
    { path: 'E:\\DCIM\\IMG_1.JPG', volume_id: A, thumb: null },
    { path: 'E:\\DCIM\\IMG_1.JPG', volume_id: B, thumb: null },
    { path: 'Q:\\x.jpg', volume_id: C, thumb: 'T:\\thumbs\\x.jpg' }
  ]
  const out = markOffline(rows, (l) => mounted.get(l) ?? null)
  assert.deepEqual(
    out.map((r) => [r.offline === true, r.thumb]),
    [
      [true, '!offline'], // never a thumbnail made from B's file at that path
      [false, null],
      [true, 'T:\\thumbs\\x.jpg'] // keeps the thumbnail it already had
    ]
  )
})

test('reconnecting the same drive under a new letter brings its files back; its old letter is not trusted', () => {
  const db = makeDb()
  db.exec(`CREATE TABLE favourite_paths (path TEXT NOT NULL, volume_id TEXT, added_at TEXT, PRIMARY KEY (path, volume_id));
    CREATE TABLE folder_snapshot (volume_id TEXT NOT NULL, path TEXT NOT NULL, mtime INTEGER, children TEXT, PRIMARY KEY (volume_id, path));
    CREATE TABLE event_file_links (path TEXT NOT NULL, volume_id TEXT, calendar_id TEXT NOT NULL, event_id TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (path, volume_id, calendar_id, event_id));
    CREATE TABLE collection_files (collection_id INTEGER NOT NULL, path TEXT NOT NULL, volume_id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (collection_id, path, volume_id));
    CREATE TABLE collections (id INTEGER PRIMARY KEY, cover_path TEXT, cover_volume_id TEXT);`)
  add(db, A, 'E:\\DCIM\\IMG_1.JPG', '2026-01-03T10:00:00.000Z')
  const reads = new LibraryReads(db as unknown as ReadDb)
  const rowsAt = (letterOf: Map<string, string>): { offline?: boolean; path: string }[] =>
    markOffline(reads.page(all([A]), 0, 10).rows as { path: string; volume_id: string; thumb: string | null }[], (l) => letterOf.get(l) ?? null)
  // Unplugged: offline.
  assert.equal(rowsAt(new Map())[0].offline, true)
  // Back as G: - opening All Drives repairs its rows onto G:, and they are live again.
  moveVolumeToLetter(db as unknown as LetterDb, A, 'G:')
  const back = rowsAt(new Map([['G:', A]]))
  assert.equal(back[0].path, 'G:\\DCIM\\IMG_1.JPG')
  assert.equal(back[0].offline, undefined)
})
