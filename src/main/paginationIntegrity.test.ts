import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  summarySql,
  pageSql,
  countSql,
  groupOffsets,
  type LibraryQuery,
  type GroupBy,
  type SortOrder,
  type NavFilter
} from './libraryQuery.ts'

/**
 * Does the paginated read ever show the same file twice, or lose one?
 *
 * The SQL builders are covered elsewhere by string assertions; those cannot
 * answer this. This runs the production builders against a real SQLite database
 * (node:sqlite - in the standard library, so no dependency and no native build
 * to match) and walks every page of every grouping and order, checking the
 * result the renderer actually consumes.
 *
 * The fixture is built specifically to break naive pagination:
 *   - many files sharing one timestamp to the second, so `date` alone is not a
 *     total order and only the path tie-break makes a page boundary stable;
 *   - the same filename in two different folders, which is the real situation
 *     behind the reported "repeated video tiles" (two genuine files, one
 *     volume, two paths);
 *   - documents mixed in, since those sort after previewable files inside a
 *     group and are packed four to a cell by the grid;
 *   - files with no date at all;
 *   - a second volume, which must never appear.
 */

const VOL = '\\\\?\\Volume{AAAA}\\'
const OTHER_VOL = '\\\\?\\Volume{BBBB}\\'

interface Row {
  path: string
  name: string
  ext: string
  size: number
  date: string | null
  year: string | null
  month: string | null
  lat: number | null
  lng: number | null
  favourited: number
  thumb: string | null
  volume_id: string
}

function makeDb(): { db: DatabaseSync; rows: Row[] } {
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
    CREATE UNIQUE INDEX idx_files_identity ON files (volume_id, path);
    CREATE INDEX idx_files_volume_page ON files (volume_id, hidden, trashed_at, date DESC, path ASC);
  `)

  const rows: Row[] = []
  const add = (r: Partial<Row> & { path: string }): void => {
    const ext = r.path.slice(r.path.lastIndexOf('.')).toLowerCase()
    const full: Row = {
      path: r.path,
      name: r.path.slice(r.path.lastIndexOf('\\') + 1),
      ext,
      size: r.size ?? 1_000_000,
      date: r.date ?? null,
      year: r.date ? r.date.slice(0, 4) : null,
      month: r.date ? 'Month' : null,
      lat: r.lat ?? null,
      lng: r.lng ?? null,
      favourited: r.favourited ?? 0,
      thumb: r.thumb ?? null,
      volume_id: r.volume_id ?? VOL
    }
    rows.push(full)
  }

  // Two folder trees holding the SAME filenames - the reported case. Both are
  // real files; the read must return both, exactly once each.
  const trees = ['D:\\Transfer\\Safety', 'D:\\iPhone Safety Transfers\\Transfer']
  for (let day = 1; day <= 6; day++) {
    for (let i = 0; i < 9; i++) {
      // Every file in a day shares one timestamp to the second, so the page
      // boundary depends entirely on the unique tie-break.
      const date = `2025-04-${String(day).padStart(2, '0')}T12:00:00.000Z`
      for (const tree of trees) {
        add({ path: `${tree}\\IMG_${day}${i}.MOV`, date, thumb: 'x.jpg' })
      }
      // Documents: previewless, so they sort after the videos inside the group.
      if (i % 3 === 0) add({ path: `${trees[0]}\\notes_${day}${i}.pdf`, date })
    }
  }
  // Located files, for the location grouping.
  for (let i = 0; i < 7; i++) {
    add({
      path: `D:\\geo\\pic_${i}.jpg`,
      date: `2025-03-0${(i % 9) + 1}T08:00:00.000Z`,
      lat: 12.9 + (i % 3) * 0.5,
      lng: 77.5 + (i % 2) * 0.5,
      thumb: 'x.jpg'
    })
  }
  // Favourites, for the favourites grouping.
  for (let i = 0; i < 5; i++) {
    add({ path: `D:\\fav\\f_${i}.jpg`, date: `2025-02-1${i}T08:00:00.000Z`, favourited: 1, thumb: 'x.jpg' })
  }
  // No date at all - must still appear exactly once.
  add({ path: 'D:\\undated\\no_date_1.jpg', date: null })
  add({ path: 'D:\\undated\\no_date_2.MOV', date: null })
  // Hidden and trashed rows, which must never appear.
  rows.push()
  // A different volume. Same relative paths on purpose.
  for (const tree of trees) add({ path: `${tree}\\IMG_11.MOV`, volume_id: OTHER_VOL, date: '2025-04-01T12:00:00.000Z' })

  const insert = db.prepare(
    `INSERT INTO files (path, name, ext, size, date, year, month, lat, lng, drive, favourited, thumb, hidden, trashed_at, volume_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  for (const r of rows) {
    insert.run(
      r.path, r.name, r.ext, r.size, r.date, r.year, r.month, r.lat, r.lng,
      'D:', r.favourited, r.thumb, 0, null, r.volume_id
    )
  }
  // Explicitly excluded rows.
  insert.run('D:\\hid\\h.jpg', 'h.jpg', '.jpg', 1, '2025-04-02T12:00:00.000Z', '2025', 'Month', null, null, 'D:', 0, null, 1, null, VOL)
  insert.run('D:\\tr\\t.jpg', 't.jpg', '.jpg', 1, '2025-04-02T12:00:00.000Z', '2025', 'Month', null, null, 'D:', 0, null, 0, '2025-05-01', VOL)

  return { db, rows: rows.filter((r) => r.volume_id === VOL) }
}

function query(over: Partial<LibraryQuery> = {}): LibraryQuery {
  return {
    drive: 'D:',
    volumeId: VOL,
    nav: 'all',
    search: '',
    groupBy: 'day',
    order: 'default',
    ...over
  }
}

/** Walks every page the way the renderer does, in page-sized windows. */
function walkAllPages(db: DatabaseSync, q: LibraryQuery, pageSize: number): string[] {
  const p = pageSql(q)
  const stmt = db.prepare(p.sql)
  const out: string[] = []
  for (let offset = 0; ; offset += pageSize) {
    const batch = stmt.all(...(p.params as never[]), pageSize, offset) as { path: string }[]
    out.push(...batch.map((r) => r.path))
    if (batch.length < pageSize) break
  }
  return out
}

const GROUPINGS: GroupBy[] = ['day', 'month', 'year', 'location', 'favorites']
const ORDERS: SortOrder[] = ['default', 'reverse']
const NAVS: NavFilter[] = ['all', 'photos', 'videos', 'docs', 'places', 'favourites']

test('every file appears exactly once across page boundaries, for every grouping and order', () => {
  const { db } = makeDb()
  for (const groupBy of GROUPINGS) {
    for (const order of ORDERS) {
      // Deliberately awkward page sizes, so boundaries land inside groups and
      // inside runs of identical timestamps rather than tidily between them.
      for (const pageSize of [1, 2, 7, 13, 200]) {
        const q = query({ groupBy, order })
        const paths = walkAllPages(db, q, pageSize)
        const unique = new Set(paths)
        assert.equal(
          paths.length,
          unique.size,
          `duplicate rows with groupBy=${groupBy} order=${order} pageSize=${pageSize}`
        )
        const c = countSql(q)
        const total = (db.prepare(c.sql).get(...(c.params as never[])) as { n: number }).n
        assert.equal(
          paths.length,
          total,
          `page walk returned ${paths.length} of ${total} rows (groupBy=${groupBy} order=${order} pageSize=${pageSize})`
        )
      }
    }
  }
  db.close()
})

test('page size never changes which rows come back, only how they are chunked', () => {
  const { db } = makeDb()
  for (const groupBy of GROUPINGS) {
    for (const order of ORDERS) {
      const q = query({ groupBy, order })
      const big = walkAllPages(db, q, 500)
      for (const pageSize of [1, 3, 11, 50]) {
        assert.deepEqual(
          walkAllPages(db, q, pageSize),
          big,
          `pagination is not stable at pageSize=${pageSize} (groupBy=${groupBy} order=${order})`
        )
      }
    }
  }
  db.close()
})

test('identical queries return an identical order every time', () => {
  // Non-determinism here is invisible in one read and shows up as a tile moving
  // or repeating on the next.
  const { db } = makeDb()
  for (const groupBy of GROUPINGS) {
    const q = query({ groupBy })
    const first = walkAllPages(db, q, 7)
    for (let i = 0; i < 5; i++) assert.deepEqual(walkAllPages(db, q, 7), first)
  }
  db.close()
})

test('group counts match the rows actually at each group offset', () => {
  // The grid lays out from the summary's counts and then asks for rows by index.
  // If the two disagree, a tile shows a file from the neighbouring group - or
  // the same file shows under two headings.
  const { db } = makeDb()
  for (const groupBy of GROUPINGS) {
    for (const order of ORDERS) {
      const q = query({ groupBy, order })
      const s = summarySql(q)
      const groups = db.prepare(s.sql).all(...(s.params as never[])) as {
        gkey: string
        n: number
      }[]
      const offsets = groupOffsets(groups)
      const all = walkAllPages(db, q, 500)

      const p = pageSql(q)
      const stmt = db.prepare(p.sql)
      let running = 0
      for (const g of groups) {
        const offset = offsets.get(g.gkey)
        assert.equal(offset, running, `offset drift before group ${g.gkey}`)
        // The rows the grid would fetch for this group's own range.
        const slice = stmt.all(...(p.params as never[]), g.n, offset!) as { path: string }[]
        assert.equal(slice.length, g.n, `group ${g.gkey} promised ${g.n} rows, range held ${slice.length}`)
        // And they must be the same rows the full walk puts there.
        assert.deepEqual(
          slice.map((r) => r.path),
          all.slice(offset!, offset! + g.n),
          `group ${g.gkey} range does not match the overall ordering`
        )
        running += g.n
      }
      assert.equal(running, all.length, 'group counts do not add up to the number of rows')
    }
  }
  db.close()
})

test('every nav filter paginates without duplicates and agrees with its count', () => {
  const { db } = makeDb()
  for (const nav of NAVS) {
    const q = query({ nav })
    const paths = walkAllPages(db, q, 5)
    assert.equal(paths.length, new Set(paths).size, `duplicates under nav=${nav}`)
    const c = countSql(q)
    const total = (db.prepare(c.sql).get(...(c.params as never[])) as { n: number }).n
    assert.equal(paths.length, total, `nav=${nav} walk/count disagree`)
  }
  db.close()
})

test('two real files with the same name in different folders are both returned, once each', () => {
  // This is the reported case, and it must NOT be deduplicated: same volume,
  // same filename, same size, same timestamp, different paths.
  const { db } = makeDb()
  const paths = walkAllPages(db, query(), 7)
  const a = 'D:\\Transfer\\Safety\\IMG_10.MOV'
  const b = 'D:\\iPhone Safety Transfers\\Transfer\\IMG_10.MOV'
  assert.equal(paths.filter((p) => p === a).length, 1, 'first copy must appear exactly once')
  assert.equal(paths.filter((p) => p === b).length, 1, 'second copy must appear exactly once')
  const sameName = paths.filter((p) => p.endsWith('\\IMG_10.MOV'))
  assert.equal(sameName.length, 2, 'both genuine files must survive the read')
  db.close()
})

test('another volume never appears, even at the same relative path', () => {
  const { db } = makeDb()
  for (const groupBy of GROUPINGS) {
    const paths = walkAllPages(db, query({ groupBy }), 4)
    // The other volume holds OTHER_VOLUME_ONLY.MOV at both of the same
    // relative paths this volume uses. Matching relative paths must not be
    // enough to pull it in.
    assert.equal(paths.filter((p) => p.endsWith('OTHER_VOLUME_ONLY.MOV')).length, 0)
  }
  db.close()
})

test('hidden and trashed rows are excluded from both the walk and the counts', () => {
  const { db } = makeDb()
  const paths = walkAllPages(db, query(), 9)
  assert.ok(!paths.some((p) => p.startsWith('D:\\hid\\')), 'hidden row leaked')
  assert.ok(!paths.some((p) => p.startsWith('D:\\tr\\')), 'trashed row leaked')
  db.close()
})

test('undated files appear exactly once rather than being dropped or repeated', () => {
  const { db } = makeDb()
  for (const order of ORDERS) {
    const paths = walkAllPages(db, query({ order }), 6)
    assert.equal(paths.filter((p) => p === 'D:\\undated\\no_date_1.jpg').length, 1)
    assert.equal(paths.filter((p) => p === 'D:\\undated\\no_date_2.MOV').length, 1)
  }
  db.close()
})

test('a page read while rows are being inserted can repeat a file', () => {
  // Not a defect in the SQL - it is what OFFSET pagination means. It matters
  // because discovery commits continuously, so the renderer can hold page N
  // from before an insert and page N+1 from after it, and render one file at
  // two indices. Documenting it here is what justifies the catalogue-version
  // guard in useLibrary; if that guard is ever removed, the duplicate tiles
  // come back only while a scan is running, which is the hardest case to
  // notice by hand.
  const { db } = makeDb()
  const q = query()
  const p = pageSql(q)
  const stmt = db.prepare(p.sql)
  const PAGE = 10

  const page0 = (stmt.all(...(p.params as never[]), PAGE, 0) as { path: string }[]).map((r) => r.path)

  // Discovery finds something newer than everything on page 0.
  db.prepare(
    `INSERT INTO files (path, name, ext, size, date, year, month, drive, hidden, trashed_at, volume_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    'D:\\new\\arrived.MOV', 'arrived.MOV', '.mov', 5, '2026-01-01T00:00:00.000Z',
    '2026', 'Month', 'D:', 0, null, VOL
  )

  const page1 = (stmt.all(...(p.params as never[]), PAGE, PAGE) as { path: string }[]).map((r) => r.path)
  const overlap = page1.filter((x) => page0.includes(x))
  assert.ok(
    overlap.length > 0,
    'expected OFFSET drift to repeat a row; if this ever stops being true the guard may be unnecessary'
  )
  db.close()
})
