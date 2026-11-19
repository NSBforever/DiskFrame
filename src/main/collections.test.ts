import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  COLLECTIONS_SCHEMA_SQL,
  createCollection,
  updateCollection,
  addFiles,
  removeFiles,
  mergeCollections,
  splitCollection,
  deleteCollection,
  listCollections,
  collectionFiles,
  applyDiscovery,
  type ColDb,
  type Discovered
} from './collections.ts'
import { moveVolumeToLetter, type LetterDb } from './driveLetter.ts'

const NOW = '2026-11-19T10:00:00.000Z'
const A = 'VOL-A'
const B = 'VOL-B'

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT NOT NULL, name TEXT, ext TEXT, size INTEGER, date TEXT, year TEXT, month TEXT,
      lat REAL, lng REAL, drive TEXT, favourited INTEGER DEFAULT 0, thumb TEXT, hidden INTEGER DEFAULT 0, trashed_at TEXT, volume_id TEXT);
    CREATE UNIQUE INDEX idx_files_identity ON files (volume_id, path);
    CREATE TABLE favourite_paths (path TEXT NOT NULL, volume_id TEXT, added_at TEXT, PRIMARY KEY (path, volume_id));
    CREATE TABLE folder_snapshot (volume_id TEXT NOT NULL, path TEXT NOT NULL, mtime INTEGER, children TEXT, PRIMARY KEY (volume_id, path));
    CREATE TABLE event_file_links (path TEXT NOT NULL, volume_id TEXT, calendar_id TEXT NOT NULL, event_id TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (path, volume_id, calendar_id, event_id));
  `)
  db.exec(COLLECTIONS_SCHEMA_SQL)
  return db
}
const d = (db: DatabaseSync): ColDb => db as unknown as ColDb
const file = (db: DatabaseSync, path: string, vol: string, date = '2026-01-01T10:00:00.000Z', thumb: string | null = null): void =>
  void db.prepare('INSERT INTO files (path, name, date, volume_id, drive, thumb) VALUES (?, ?, ?, ?, ?, ?)').run(path, path.split('\\').pop() ?? '', date, vol, path.slice(0, 2), thumb)
const count = (db: DatabaseSync, sql: string): number => (db.prepare(sql).get() as { n: number }).n
const orphans = (db: DatabaseSync): number =>
  count(db, 'SELECT COUNT(*) n FROM collection_files cf WHERE NOT EXISTS (SELECT 1 FROM collections c WHERE c.id = cf.collection_id)')

// ── Manual collections ──────────────────────────────────────────────────────

test('manual collections: create, add, rename, cover, remove', () => {
  const db = makeDb()
  file(db, 'E:\\a.jpg', A, '2026-01-01T00:00:00Z', 'T:\\thumbs\\a.jpg')
  file(db, 'E:\\b.mp4', A, '2026-01-02T00:00:00Z')
  const id = createCollection(d(db), { kind: 'place', name: 'Grandma’s house' }, NOW)
  assert.equal(addFiles(d(db), id, [{ path: 'E:\\a.jpg', volumeId: A }, { path: 'E:\\b.mp4', volumeId: A }]), 2)
  assert.equal(addFiles(d(db), id, [{ path: 'E:\\a.jpg', volumeId: A }]), 0, 'adding twice is a no-op')
  updateCollection(d(db), id, { name: 'Nani’s house', cover: { path: 'E:\\b.mp4', volumeId: A } }, NOW)
  const [card] = listCollections(d(db), [A])
  assert.equal(card.name, 'Nani’s house')
  assert.equal(card.count, 2)
  assert.equal(card.coverPath, 'E:\\b.mp4')
  assert.deepEqual(card.volumes, [A])
  removeFiles(d(db), id, [{ path: 'E:\\a.jpg', volumeId: A }])
  assert.deepEqual(collectionFiles(d(db), id).map((f) => f.path), ['E:\\b.mp4'])
})

test('a collection can hold files from two volumes that share a path, and keeps them apart', () => {
  const db = makeDb()
  file(db, 'E:\\DCIM\\IMG_0001.JPG', A)
  file(db, 'E:\\DCIM\\IMG_0001.JPG', B)
  const id = createCollection(d(db), { kind: 'custom', name: 'Both' }, NOW)
  addFiles(d(db), id, [{ path: 'E:\\DCIM\\IMG_0001.JPG', volumeId: A }, { path: 'E:\\DCIM\\IMG_0001.JPG', volumeId: B }])
  assert.deepEqual(collectionFiles(d(db), id).map((f) => f.volume_id).sort(), [A, B])
  removeFiles(d(db), id, [{ path: 'E:\\DCIM\\IMG_0001.JPG', volumeId: A }])
  assert.deepEqual(collectionFiles(d(db), id).map((f) => f.volume_id), [B])
})

test('merge moves members and removes the source; split moves the chosen files to a new collection', () => {
  const db = makeDb()
  for (const n of ['1', '2', '3', '4']) file(db, `E:\\${n}.jpg`, A)
  const x = createCollection(d(db), { kind: 'place', name: 'Cafe' }, NOW)
  const y = createCollection(d(db), { kind: 'place', name: 'Cafe (2)' }, NOW)
  addFiles(d(db), x, [{ path: 'E:\\1.jpg', volumeId: A }, { path: 'E:\\2.jpg', volumeId: A }])
  addFiles(d(db), y, [{ path: 'E:\\2.jpg', volumeId: A }, { path: 'E:\\3.jpg', volumeId: A }])
  mergeCollections(d(db), x, y, NOW)
  assert.deepEqual(collectionFiles(d(db), x).map((f) => f.path).sort(), ['E:\\1.jpg', 'E:\\2.jpg', 'E:\\3.jpg'])
  assert.equal(listCollections(d(db), [A]).length, 1)
  const z = splitCollection(d(db), x, [{ path: 'E:\\3.jpg', volumeId: A }], 'Bookshop', NOW)
  assert.deepEqual(collectionFiles(d(db), z).map((f) => f.path), ['E:\\3.jpg'])
  assert.deepEqual(collectionFiles(d(db), x).map((f) => f.path).sort(), ['E:\\1.jpg', 'E:\\2.jpg'])
  assert.equal((db.prepare('SELECT kind FROM collections WHERE id = ?').get(z) as { kind: string }).kind, 'place')
  deleteCollection(d(db), z)
  assert.equal(orphans(db), 0)
})

test('listing is scoped to the volumes in view, but empty manual collections always show', () => {
  const db = makeDb()
  file(db, 'E:\\a.jpg', A)
  file(db, 'F:\\b.jpg', B)
  const onA = createCollection(d(db), { kind: 'custom', name: 'A' }, NOW)
  addFiles(d(db), onA, [{ path: 'E:\\a.jpg', volumeId: A }])
  const onB = createCollection(d(db), { kind: 'custom', name: 'B' }, NOW)
  addFiles(d(db), onB, [{ path: 'F:\\b.jpg', volumeId: B }])
  createCollection(d(db), { kind: 'trip', name: 'Empty' }, NOW)
  assert.deepEqual(listCollections(d(db), [A]).map((c) => c.name).sort(), ['A', 'Empty'])
  assert.deepEqual(listCollections(d(db), [A, B]).map((c) => c.name).sort(), ['A', 'B', 'Empty'])
})

test('trashed and hidden files are not counted or listed', () => {
  const db = makeDb()
  file(db, 'E:\\a.jpg', A)
  file(db, 'E:\\b.jpg', A)
  db.prepare("UPDATE files SET trashed_at = 'x' WHERE path = 'E:\\b.jpg'").run()
  const id = createCollection(d(db), { kind: 'custom', name: 'X' }, NOW)
  addFiles(d(db), id, [{ path: 'E:\\a.jpg', volumeId: A }, { path: 'E:\\b.jpg', volumeId: A }])
  assert.equal(listCollections(d(db), [A])[0].count, 1)
  assert.equal(collectionFiles(d(db), id).length, 1)
})

// ── Discovery bookkeeping ───────────────────────────────────────────────────

const found = (kind: 'place' | 'trip', paths: string[], extra: Partial<Discovered> = {}): Discovered => ({
  kind,
  members: paths.map((p) => ({ path: p, volumeId: A })),
  lat: 15.5,
  lng: 73.8,
  radiusM: 120,
  startMs: Date.UTC(2026, 0, 3),
  endMs: Date.UTC(2026, 0, 6),
  confidence: 'medium',
  ...extra
})

test('discovery adds suggestions, refreshes them, and never re-suggests a dismissed one', () => {
  const db = makeDb()
  for (const n of ['1', '2', '3', '4', '5']) file(db, `E:\\${n}.jpg`, A)
  assert.deepEqual(applyDiscovery(d(db), A, [found('place', ['E:\\1.jpg', 'E:\\2.jpg', 'E:\\3.jpg'])], NOW), { added: 1, updated: 0, removed: 0 })
  const [s] = listCollections(d(db), [A])
  assert.equal(s.status, 'suggested')
  assert.equal(s.confidence, 'medium')
  assert.equal(s.count, 3)
  // Found again with one more photo: updated in place, not a second card.
  assert.deepEqual(applyDiscovery(d(db), A, [found('place', ['E:\\1.jpg', 'E:\\2.jpg', 'E:\\3.jpg', 'E:\\4.jpg'])], NOW), { added: 0, updated: 1, removed: 0 })
  assert.equal(listCollections(d(db), [A])[0].count, 4)
  updateCollection(d(db), s.id, { status: 'dismissed' }, NOW)
  assert.equal(listCollections(d(db), [A]).length, 0)
  const r3 = applyDiscovery(d(db), A, [found('place', ['E:\\1.jpg', 'E:\\2.jpg', 'E:\\3.jpg', 'E:\\4.jpg', 'E:\\5.jpg'])], NOW)
  assert.deepEqual(r3, { added: 0, updated: 0, removed: 0 })
  assert.equal(listCollections(d(db), [A]).length, 0)
})

test('discovery respects the user: accepted is frozen, removed photos stay removed, stale untouched suggestions go', () => {
  const db = makeDb()
  for (const n of ['1', '2', '3', '4', '5', '6']) file(db, `E:\\${n}.jpg`, A)
  applyDiscovery(d(db), A, [found('trip', ['E:\\1.jpg', 'E:\\2.jpg', 'E:\\3.jpg']), found('place', ['E:\\5.jpg', 'E:\\6.jpg'])], NOW)
  const trip = listCollections(d(db), [A]).find((c) => c.kind === 'trip')!
  removeFiles(d(db), trip.id, [{ path: 'E:\\3.jpg', volumeId: A }])
  applyDiscovery(d(db), A, [found('trip', ['E:\\1.jpg', 'E:\\2.jpg', 'E:\\3.jpg', 'E:\\4.jpg'])], NOW)
  assert.deepEqual(collectionFiles(d(db), trip.id).map((f) => f.path).sort(), ['E:\\1.jpg', 'E:\\2.jpg', 'E:\\4.jpg'])
  // The place was not found this time and the user never touched it.
  assert.equal(listCollections(d(db), [A]).filter((c) => c.kind === 'place').length, 0)
  updateCollection(d(db), trip.id, { status: 'accepted' }, NOW)
  applyDiscovery(d(db), A, [found('trip', ['E:\\1.jpg', 'E:\\2.jpg', 'E:\\3.jpg', 'E:\\4.jpg', 'E:\\5.jpg', 'E:\\6.jpg'])], NOW)
  assert.equal(collectionFiles(d(db), trip.id).length, 3, 'accepted collections are never changed by discovery')
  assert.equal(listCollections(d(db), [A]).length, 1, 'and no duplicate suggestion appears for it')
  assert.equal(orphans(db), 0)
})

test('a renamed suggestion is kept even when discovery stops finding it', () => {
  const db = makeDb()
  file(db, 'E:\\1.jpg', A)
  file(db, 'E:\\2.jpg', A)
  applyDiscovery(d(db), A, [found('place', ['E:\\1.jpg', 'E:\\2.jpg'])], NOW)
  const [s] = listCollections(d(db), [A])
  updateCollection(d(db), s.id, { name: 'Library' }, NOW)
  applyDiscovery(d(db), A, [], NOW)
  assert.deepEqual(listCollections(d(db), [A]).map((c) => c.name), ['Library'])
})

test('discovery in one scope never touches suggestions from another scope', () => {
  const db = makeDb()
  file(db, 'E:\\1.jpg', A)
  file(db, 'E:\\2.jpg', A)
  applyDiscovery(d(db), A, [found('place', ['E:\\1.jpg', 'E:\\2.jpg'])], NOW)
  applyDiscovery(d(db), '*', [], NOW)
  assert.equal(listCollections(d(db), [A]).length, 1)
})

// ── Drive letter changes ────────────────────────────────────────────────────

test('collection members and covers follow their volume to a new drive letter', () => {
  const db = makeDb()
  file(db, 'E:\\Goa\\1.jpg', A)
  file(db, 'E:\\Goa\\1.jpg', B) // another volume that also used E:
  const id = createCollection(d(db), { kind: 'trip', name: 'Goa' }, NOW)
  addFiles(d(db), id, [{ path: 'E:\\Goa\\1.jpg', volumeId: A }, { path: 'E:\\Goa\\1.jpg', volumeId: B }])
  updateCollection(d(db), id, { cover: { path: 'E:\\Goa\\1.jpg', volumeId: A } }, NOW)
  moveVolumeToLetter(db as unknown as LetterDb, A, 'G:')
  const m = collectionFiles(d(db), id).map((f) => `${f.volume_id}:${f.path}`).sort()
  assert.deepEqual(m, [`${A}:G:\\Goa\\1.jpg`, `${B}:E:\\Goa\\1.jpg`])
  assert.equal(listCollections(d(db), [A, B])[0].coverPath, 'G:\\Goa\\1.jpg')
})

test('a collection made by hand keeps the dates and place text the user gives it, with or without GPS', () => {
  const db = makeDb()
  file(db, 'E:\\scan.jpg', A) // no GPS, no reliable date
  const id = createCollection(d(db), { kind: 'trip', name: 'Varanasi' }, NOW)
  addFiles(d(db), id, [{ path: 'E:\\scan.jpg', volumeId: A }])
  updateCollection(d(db), id, { note: 'Varanasi, Uttar Pradesh', startMs: Date.UTC(2025, 10, 12), endMs: Date.UTC(2025, 10, 14) }, NOW)
  const [c] = listCollections(d(db), [A])
  assert.equal(c.note, 'Varanasi, Uttar Pradesh')
  assert.equal(c.startMs, Date.UTC(2025, 10, 12))
  assert.equal(c.endMs, Date.UTC(2025, 10, 14))
  updateCollection(d(db), id, { startMs: null, endMs: null }, NOW)
  assert.equal(listCollections(d(db), [A])[0].startMs, null)
  // A backwards range is stored the right way round.
  updateCollection(d(db), id, { startMs: Date.UTC(2025, 10, 14), endMs: Date.UTC(2025, 10, 12) }, NOW)
  const [r] = listCollections(d(db), [A])
  assert.deepEqual([r.startMs, r.endMs], [Date.UTC(2025, 10, 12), Date.UTC(2025, 10, 14)])
})

test('the listing leaves out suggestions from the discovery mode not in use, but never what the user kept', () => {
  const db = makeDb()
  for (const n of ['1', '2', '3', '4']) file(db, `E:\\${n}.jpg`, A)
  applyDiscovery(d(db), A, [found('place', ['E:\\1.jpg', 'E:\\2.jpg'])], NOW)
  applyDiscovery(d(db), '*', [found('place', ['E:\\3.jpg', 'E:\\4.jpg'])], NOW)
  assert.equal(listCollections(d(db), [A], { crossDrive: false }).length, 1)
  assert.equal(listCollections(d(db), [A], { crossDrive: true }).length, 1)
  const cross = listCollections(d(db), [A], { crossDrive: true })[0]
  updateCollection(d(db), cross.id, { status: 'accepted' }, NOW)
  assert.equal(listCollections(d(db), [A], { crossDrive: false }).length, 2, 'kept from either mode always shows')
})
