import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { groupIndexOfRow, nearestGroupByDate, normalizeAnchor, resolveAnchorRow, type AnchorGroup } from './galleryAnchor.ts'
import { cellOfRow, cellSpan } from './compactCells.ts'
import { LibraryReads, EPOCH_SCHEMA_SQL, type ReadDb } from './libraryReads.ts'
import type { LibraryQuery } from './libraryQuery.ts'

const g = (offset: number, count: number, minDate: string | null, maxDate: string | null): AnchorGroup => ({ offset, count, minDate, maxDate })

// Newest first, the default view order: three days.
const DAYS = [
  g(0, 4, '2024-05-12T08:00:00.000Z', '2024-05-12T20:00:00.000Z'),
  g(4, 3, '2024-05-03T08:00:00.000Z', '2024-05-03T18:00:00.000Z'),
  g(7, 5, '2024-04-30T09:00:00.000Z', '2024-04-30T09:30:00.000Z')
]

test('the row index maps to the group that holds it', () => {
  assert.equal(groupIndexOfRow(DAYS, 0), 0)
  assert.equal(groupIndexOfRow(DAYS, 3), 0)
  assert.equal(groupIndexOfRow(DAYS, 4), 1)
  assert.equal(groupIndexOfRow(DAYS, 11), 2)
  assert.equal(groupIndexOfRow([], 0), -1)
})

test('a file found in the new arrangement comes back exactly, in file mode', () => {
  assert.deepEqual(resolveAnchorRow(DAYS, { date: null, mode: 'file' }, 5), { row: 5, groupIndex: 1, exact: true })
})

test("in group mode (a new sort) the top of the file's group is shown instead", () => {
  assert.deepEqual(resolveAnchorRow(DAYS, { date: null, mode: 'group' }, 5), { row: 4, groupIndex: 1, exact: false })
})

test('a file no longer in the result falls back to the group covering its date', () => {
  assert.deepEqual(resolveAnchorRow(DAYS, { date: '2024-05-03T12:00:00.000Z', mode: 'file' }, -1), { row: 4, groupIndex: 1, exact: false })
})

test('a date with no group of its own goes to the nearest one, either side', () => {
  // 1 May sits between 3 May and 30 April; 30 April 09:30 is nearer.
  assert.equal(nearestGroupByDate(DAYS, '2024-05-01T00:00:00.000Z'), 2)
  assert.equal(nearestGroupByDate(DAYS, '2024-05-02T23:00:00.000Z'), 1)
  assert.equal(nearestGroupByDate(DAYS, '2030-01-01T00:00:00.000Z'), 0)
  assert.equal(nearestGroupByDate(DAYS, '1999-01-01T00:00:00.000Z'), 2)
})

test('nothing to anchor to resolves to null rather than guessing', () => {
  assert.equal(resolveAnchorRow([], { date: '2024-05-03T12:00:00.000Z', mode: 'file' }, 3), null)
  assert.equal(resolveAnchorRow(DAYS, { date: null, mode: 'file' }, -1), null)
  assert.equal(resolveAnchorRow(DAYS, { date: 'not a date', mode: 'file' }, null), null)
  // An index past the end (a stale answer) is not trusted.
  assert.equal(resolveAnchorRow(DAYS, { date: null, mode: 'file' }, 12), null)
})

test('undated groups never win the date fallback', () => {
  const withUndated = [...DAYS, g(12, 2, null, null)]
  assert.equal(nearestGroupByDate(withUndated, '1999-01-01T00:00:00.000Z'), 2)
})

test('cellOfRow is the inverse of cellSpan, compact files included', () => {
  for (const shape of [{ count: 10, compactCount: 0 }, { count: 10, compactCount: 7 }, { count: 3, compactCount: 3 }]) {
    let cell = 0
    for (let i = 0; i < shape.count; ) {
      const span = cellSpan(shape, cell)
      for (let k = 0; k < span.count; k++) assert.equal(cellOfRow(shape, span.start + k), cell, JSON.stringify(shape) + ' row ' + (span.start + k))
      i = span.start + span.count
      cell++
    }
  }
})

test('the anchor crossing IPC is bounded strings or nothing', () => {
  assert.deepEqual(normalizeAnchor({ path: 'C:\\a.jpg', volumeId: 'V' }), { path: 'C:\\a.jpg', volumeId: 'V' })
  assert.deepEqual(normalizeAnchor({ path: 'C:\\a.jpg' }), { path: 'C:\\a.jpg', volumeId: null })
  assert.equal(normalizeAnchor(null), null)
  assert.equal(normalizeAnchor({ path: 7 }), null)
  assert.equal(normalizeAnchor({ path: '' }), null)
  assert.equal(normalizeAnchor({ path: 'x'.repeat(5000) }), null)
  assert.equal(normalizeAnchor({ path: 'C:\\a.jpg', volumeId: { $: 1 } }), null)
})

// ── End to end against the real reads: Day <-> Month <-> Year keep the same file ──

const VOL = 'V1'
function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  d.exec(`CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, name TEXT, ext TEXT, size INTEGER,
    date TEXT, year TEXT, month TEXT, lat REAL, lng REAL, drive TEXT, favourited INTEGER DEFAULT 0, thumb TEXT,
    hidden INTEGER DEFAULT 0, trashed_at TEXT, volume_id TEXT)`)
  d.exec(EPOCH_SCHEMA_SQL)
  const ins = d.prepare(`INSERT INTO files (path,name,ext,size,date,drive,volume_id) VALUES (?,?,?,?,?,'C:',?)`)
  // Midday UTC, so the local day is the same in any zone this runs in.
  for (let i = 0; i < 400; i++) {
    const date = new Date(Date.UTC(2022, 0, 1, 12) + Math.floor(i / 3) * 5 * 86400e3).toISOString()
    const ext = i % 9 === 0 ? '.pdf' : '.jpg'
    ins.run(`C:\\P\\IMG_${i}${ext}`, `IMG_${i}${ext}`, ext, (i * 37) % 101, date, VOL)
  }
  return d
}
const q = (o: Partial<LibraryQuery>): LibraryQuery => ({ drive: 'C:', volumeId: VOL, nav: 'all', search: '', groupBy: 'day', order: 'default', bbox: null, ...o })

test('regrouping keeps the anchor file, and the group it lands in covers its date', () => {
  const d = db()
  const reads = new LibraryReads(d as unknown as ReadDb)
  const transitions: [LibraryQuery['groupBy'], LibraryQuery['groupBy']][] = [
    ['day', 'month'], ['month', 'day'], ['month', 'year'], ['year', 'month'], ['day', 'year'], ['year', 'day'], ['day', 'none'], ['none', 'day'], ['day', 'location']
  ]
  for (const order of ['default', 'reverse'] as const) {
    for (const [from, to] of transitions) {
      for (const at of [0, 57, 199, 398]) {
        const before = reads.page(q({ groupBy: from, order }), at, 1).rows[0] as { path: string; volume_id: string; date: string }
        const nq = q({ groupBy: to, order })
        const summary = reads.summary(nq)
        const idx = reads.indexOf(nq, before.path, before.volume_id)
        const hit = resolveAnchorRow(summary.groups, { date: before.date, mode: 'file' }, idx)
        assert.ok(hit, `${from}->${to} ${order} @${at}`)
        const row = reads.page(nq, hit.row, 1).rows[0] as { path: string }
        assert.equal(row.path, before.path, `${from}->${to} ${order} @${at}: same file`)
        const grp = summary.groups[hit.groupIndex]
        if (to !== 'location') assert.ok(grp.minDate <= before.date && before.date <= grp.maxDate, 'its group covers its date')
      }
    }
  }
})

test("a new sort shows the top of the anchor file's group, which still covers its date", () => {
  const d = db()
  const reads = new LibraryReads(d as unknown as ReadDb)
  const before = reads.page(q({ groupBy: 'month' }), 120, 1).rows[0] as { path: string; volume_id: string; date: string }
  const nq = q({ groupBy: 'month', sort: 'size-desc' })
  const summary = reads.summary(nq)
  const hit = resolveAnchorRow(summary.groups, { date: before.date, mode: 'group' }, reads.indexOf(nq, before.path, before.volume_id))!
  const grp = summary.groups[hit.groupIndex]
  assert.equal(hit.row, grp.offset)
  assert.ok(grp.minDate <= before.date && before.date <= grp.maxDate)
})

test('a file the new query does not return is reported as not found', () => {
  const d = db()
  const reads = new LibraryReads(d as unknown as ReadDb)
  assert.equal(reads.indexOf(q({ nav: 'docs' }), 'C:\\P\\IMG_1.jpg', VOL), -1)
  assert.equal(reads.indexOf(q({}), 'C:\\P\\nope.jpg', VOL), -1)
  assert.equal(reads.indexOf(q({}), 'C:\\P\\IMG_1.jpg', 'other volume'), -1)
  assert.ok(reads.indexOf(q({ nav: 'docs' }), 'C:\\P\\IMG_0.pdf', VOL) >= 0)
})
