import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { moveVolumeToLetter, type LetterDb } from './driveLetter.ts'

const G = '\\\\?\\Volume{GGGG}\\'
const OTHER = '\\\\?\\Volume{OOOO}\\'

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT NOT NULL, drive TEXT, volume_id TEXT);
    CREATE UNIQUE INDEX idx_files_identity ON files (volume_id, path);
    CREATE TABLE favourite_paths (path TEXT NOT NULL, volume_id TEXT, added_at TEXT, PRIMARY KEY (path, volume_id));
    CREATE TABLE folder_snapshot (volume_id TEXT NOT NULL, path TEXT NOT NULL, mtime INTEGER, children TEXT, PRIMARY KEY (volume_id, path));
  `)
  return db
}
const add = (db: DatabaseSync, path: string, drive: string | null, vol: string | null): void =>
  void db.prepare('INSERT INTO files (path, drive, volume_id) VALUES (?, ?, ?)').run(path, drive, vol)
const rows = (db: DatabaseSync, vol: string): { path: string; drive: string }[] =>
  (db.prepare('SELECT path, drive FROM files WHERE volume_id = ? ORDER BY path').all(vol) as { path: string; drive: string }[]).map(
    (r) => ({ ...r })
  )
const move = (db: DatabaseSync, vol: string, letter: string): ReturnType<typeof moveVolumeToLetter> =>
  moveVolumeToLetter(db as unknown as LetterDb, vol, letter)

test("rows whose drive column already moved but whose path did not are repaired (the owner's 61k rows)", () => {
  const db = makeDb()
  add(db, 'D:\\1) Family Pictures\\Nana.mp4', 'G:', G)
  add(db, 'D:\\1) Family Pictures\\ALL PHOTOS\\012.JPG', 'G:', G)
  add(db, 'G:\\SAHITI\\IMG_0856.HEIC', 'G:', G)
  const r = move(db, G, 'G:')
  assert.deepEqual(r, { oldLetters: ['D:'], moved: 2, left: 0 })
  assert.deepEqual(rows(db, G), [
    { path: 'G:\\1) Family Pictures\\ALL PHOTOS\\012.JPG', drive: 'G:' },
    { path: 'G:\\1) Family Pictures\\Nana.mp4', drive: 'G:' },
    { path: 'G:\\SAHITI\\IMG_0856.HEIC', drive: 'G:' }
  ])
})

test('the classic case: drive and path both on the old letter', () => {
  const db = makeDb()
  add(db, 'E:\\DCIM\\a.jpg', 'E:', G)
  assert.equal(move(db, G, 'g:').moved, 1)
  assert.deepEqual(rows(db, G), [{ path: 'G:\\DCIM\\a.jpg', drive: 'G:' }])
})

test("another volume's rows at the old letter are never touched", () => {
  const db = makeDb()
  add(db, 'D:\\a.jpg', 'D:', G)
  add(db, 'D:\\a.jpg', 'D:', OTHER)
  add(db, 'D:\\legacy.jpg', 'D:', null)
  move(db, G, 'G:')
  assert.deepEqual(rows(db, OTHER), [{ path: 'D:\\a.jpg', drive: 'D:' }])
  assert.equal((db.prepare('SELECT path FROM files WHERE volume_id IS NULL').get() as { path: string }).path, 'D:\\legacy.jpg')
})

test('a row whose new path is already taken stays put; the rest still move', () => {
  const db = makeDb()
  add(db, 'D:\\x.jpg', 'D:', G)
  add(db, 'G:\\x.jpg', 'G:', G)
  add(db, 'D:\\y.jpg', 'D:', G)
  assert.deepEqual(move(db, G, 'G:'), { oldLetters: ['D:'], moved: 1, left: 1 })
  assert.deepEqual(
    rows(db, G).map((r) => r.path),
    ['D:\\x.jpg', 'G:\\x.jpg', 'G:\\y.jpg']
  )
})

test('favourites follow only files that moved; folder snapshots follow the volume', () => {
  const db = makeDb()
  add(db, 'D:\\x.jpg', 'D:', G)
  add(db, 'G:\\x.jpg', 'G:', G)
  add(db, 'D:\\fav.jpg', 'G:', G)
  db.prepare('INSERT INTO favourite_paths (path, volume_id) VALUES (?, ?), (?, ?)').run('D:\\fav.jpg', G, 'D:\\x.jpg', G)
  db.prepare('INSERT INTO folder_snapshot (volume_id, path, mtime) VALUES (?, ?, 5), (?, ?, 7)').run(G, 'D:\\DCIM', OTHER, 'D:\\DCIM')
  move(db, G, 'G:')
  const favs = (db.prepare('SELECT path FROM favourite_paths ORDER BY path').all() as { path: string }[]).map((r) => r.path)
  // D:\x.jpg collided and stayed, so its favourite stays with it.
  assert.deepEqual(favs, ['D:\\x.jpg', 'G:\\fav.jpg'])
  const snaps = (db.prepare('SELECT volume_id, path, mtime FROM folder_snapshot ORDER BY volume_id').all() as object[]).map((r) => ({ ...r }))
  assert.deepEqual(snaps, [
    { volume_id: G, path: 'G:\\DCIM', mtime: 5 },
    { volume_id: OTHER, path: 'D:\\DCIM', mtime: 7 }
  ])
})

test('a stale drive column on rows already on the right letter is corrected', () => {
  const db = makeDb()
  add(db, 'G:\\a.jpg', 'D:', G)
  add(db, 'G:\\b.jpg', null, G)
  assert.deepEqual(move(db, G, 'G:'), { oldLetters: [], moved: 0, left: 0 })
  assert.deepEqual(rows(db, G), [
    { path: 'G:\\a.jpg', drive: 'G:' },
    { path: 'G:\\b.jpg', drive: 'G:' }
  ])
})

test('running it again changes nothing', () => {
  const db = makeDb()
  add(db, 'D:\\a.jpg', 'G:', G)
  move(db, G, 'G:')
  assert.deepEqual(move(db, G, 'G:'), { oldLetters: [], moved: 0, left: 0 })
})
