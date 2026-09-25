import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWhere,
  groupKeyExpr,
  orderExpr,
  summarySql,
  pageSql,
  countSql,
  groupOffsets,
  clusterCellSize,
  mapClustersSql,
  clusterThumbsSql,
  MAX_CLUSTERS,
  type LibraryQuery
} from './libraryQuery.ts'

const base: LibraryQuery = { drive: 'C:', nav: 'all', search: '', groupBy: 'day', order: 'default' }

test('base query scopes to drive and excludes hidden and trashed', () => {
  const w = buildWhere(base)
  assert.match(w.sql, /drive = \?/)
  assert.match(w.sql, /hidden = 0/)
  assert.match(w.sql, /trashed_at IS NULL/)
  assert.deepEqual(w.params, ['C:'])
})

test('nav filters bind their extension lists rather than interpolating', () => {
  const photos = buildWhere({ ...base, nav: 'photos' })
  assert.match(photos.sql, /ext IN \(\?,\?,\?,\?,\?\)/)
  assert.deepEqual(photos.params, ['C:', '.jpg', '.jpeg', '.png', '.webp', '.heic'])

  assert.match(buildWhere({ ...base, nav: 'places' }).sql, /lat IS NOT NULL AND lng IS NOT NULL/)
  assert.match(buildWhere({ ...base, nav: 'favourites' }).sql, /favourited = 1/)
  assert.match(buildWhere({ ...base, nav: 'screenshots' }).sql, /screenshot/)
})

test('search operators are parsed and bound', () => {
  assert.match(buildWhere({ ...base, search: 'is:fav' }).sql, /favourited = 1/)

  const ext = buildWhere({ ...base, search: 'ext:png' })
  assert.deepEqual(ext.params, ['C:', '.png'], 'bare extension gets a leading dot')
  assert.deepEqual(buildWhere({ ...base, search: 'ext:.png' }).params, ['C:', '.png'])

  const free = buildWhere({ ...base, search: 'Holiday' })
  assert.deepEqual(free.params, ['C:', 'holiday', 'holiday'], 'case-folded and bound twice')
})

// A search term must never become SQL. These are the shapes that would matter.
test('search cannot inject SQL', () => {
  const evil = buildWhere({ ...base, search: "'; DROP TABLE files; --" })
  assert.ok(!evil.sql.includes('DROP'), 'no fragment of the term reaches the SQL text')
  assert.ok(evil.params.some((p) => String(p).includes('drop table files')), 'it is a bound value')
})

test('search length is capped by the caller, and empty search adds no clause', () => {
  const none = buildWhere(base)
  const withSearch = buildWhere({ ...base, search: 'x' })
  assert.ok(withSearch.sql.length > none.sql.length)
  assert.equal(buildWhere({ ...base, search: '   ' }).sql, none.sql, 'whitespace is not a search')
})

test('group keys sort the same way the dates do', () => {
  assert.equal(groupKeyExpr('day'), 'substr(date, 1, 10)')
  assert.equal(groupKeyExpr('month'), 'substr(date, 1, 7)')
  assert.equal(groupKeyExpr('year'), 'substr(date, 1, 4)')
  assert.match(groupKeyExpr('location'), /ROUND/)
  assert.match(groupKeyExpr('favorites'), /favourited/)
})

// Without a unique tie-break, two pages can return the same row or skip one.
test('ordering always ends with the unique path column', () => {
  assert.equal(orderExpr('default'), 'date DESC, path ASC')
  assert.equal(orderExpr('reverse'), 'date ASC, path ASC')
})

test('page and summary agree on direction', () => {
  const fwd = summarySql(base)
  assert.match(fwd.sql, /MAX\(date\) DESC/)
  const rev = summarySql({ ...base, order: 'reverse' })
  assert.match(rev.sql, /MIN\(date\) ASC/)
})

test('page query is bounded by LIMIT and OFFSET placeholders', () => {
  const p = pageSql(base)
  assert.match(p.sql, /LIMIT \? OFFSET \?$/)
  assert.match(p.sql, /ORDER BY date DESC, path ASC/)
})

test('count query selects only a count', () => {
  assert.match(countSql(base).sql, /SELECT COUNT\(\*\) AS n/)
})

// The scrubber jumps to a date by offset, so offsets must be exact and cumulative.
test('group offsets are cumulative and start at zero', () => {
  const offsets = groupOffsets([
    { gkey: '2026-09-21', n: 10 },
    { gkey: '2026-09-20', n: 5 },
    { gkey: '2026-09-19', n: 1 }
  ])
  assert.equal(offsets.get('2026-09-21'), 0)
  assert.equal(offsets.get('2026-09-20'), 10)
  assert.equal(offsets.get('2026-09-19'), 15)
})

test('group offsets handle an empty library', () => {
  assert.equal(groupOffsets([]).size, 0)
})

test('date-derived groupings keep the fast index-friendly page order', () => {
  for (const g of ['day', 'month', 'year'] as const) {
    const sql = pageSql({ ...base, groupBy: g }).sql
    assert.match(sql, /ORDER BY date DESC, path ASC LIMIT \? OFFSET \?/)
    assert.ok(!sql.includes('OVER (PARTITION BY'), g + ' should not need a window function')
  }
})

test('location and favourites pages are ordered by group, not date alone', () => {
  // The summary ranks groups by MAX(date); rows ordered by date alone
  // interleave groups, so groupOffsets() would point at the wrong files.
  for (const g of ['location', 'favorites'] as const) {
    const sql = pageSql({ ...base, groupBy: g }).sql
    assert.match(sql, /MAX\(date\) OVER \(PARTITION BY/)
    assert.match(sql, /ORDER BY gsort DESC, gkey DESC, date DESC, path ASC/)
  }
})

test('reversed order flips both the group ranking and the rows', () => {
  const sql = pageSql({ ...base, groupBy: 'favorites', order: 'reverse' }).sql
  assert.match(sql, /MIN\(date\) OVER \(PARTITION BY/)
  assert.match(sql, /ORDER BY gsort ASC, gkey ASC, date ASC, path ASC/)
  // and the summary it must agree with
  const sum = summarySql({ ...base, groupBy: 'favorites', order: 'reverse' }).sql
  assert.match(sum, /ORDER BY MIN\(date\) ASC, gkey ASC/)
})

test('page ordering matches the summary ordering for every grouping', () => {
  for (const g of ['day', 'month', 'year', 'location', 'favorites'] as const) {
    for (const order of ['default', 'reverse'] as const) {
      const q = { ...base, groupBy: g, order }
      const sum = summarySql(q).sql
      const page = pageSql(q).sql
      const dir = order === 'reverse' ? 'ASC' : 'DESC'
      const agg = order === 'reverse' ? 'MIN' : 'MAX'
      assert.ok(sum.includes('ORDER BY ' + agg + '(date) ' + dir), 'summary ' + g + '/' + order)
      if (g === 'location' || g === 'favorites') {
        assert.ok(page.includes(agg + '(date) OVER (PARTITION BY'), g + '/' + order)
        assert.ok(page.includes('ORDER BY gsort ' + dir), g + '/' + order)
      }
    }
  }
})

test('location grouping gives unlocated files their own key', () => {
  const key = groupKeyExpr('location')
  assert.match(key, /lat IS NULL OR lng IS NULL/)
  assert.match(key, /'none'/)
})

test('favourites grouping separates favourited from the rest', () => {
  const key = groupKeyExpr('favorites')
  assert.match(key, /favourited = 1/)
  assert.match(key, /'fav'/)
  assert.match(key, /'other'/)
})


// ─── map clustering ──────────────────────────────────────────────────────

const mapQ = (over: Partial<LibraryQuery> = {}): LibraryQuery => ({
  drive: 'C:',
  nav: 'all',
  search: '',
  groupBy: 'day',
  order: 'default',
  ...over
})

test('cluster cells shrink as the zoom goes in', () => {
  const wide = clusterCellSize(2)
  const close = clusterCellSize(12)
  assert.ok(close < wide, 'zooming in must split cells')
  // One zoom level is one halving, so ten levels is a factor of 1024.
  assert.ok(Math.abs(wide / close - 1024) < 1, `${wide} / ${close}`)
})

test('cluster cell size is clamped for absurd zooms', () => {
  assert.ok(clusterCellSize(-5) === clusterCellSize(0))
  assert.ok(clusterCellSize(99) === clusterCellSize(22))
  assert.ok(clusterCellSize(Number.NaN) > 0)
})

test('a bounding box narrows the query and binds all four edges', () => {
  const w = buildWhere(mapQ({ bbox: { minLat: 10, maxLat: 20, minLng: 70, maxLng: 80 } }))
  assert.ok(w.sql.includes('lat BETWEEN ? AND ?'))
  assert.ok(w.sql.includes('lng BETWEEN ? AND ?'))
  assert.deepEqual(w.params.slice(-4), [10, 20, 70, 80])
})

test('a reversed box is normalised rather than matching nothing', () => {
  const w = buildWhere(mapQ({ bbox: { minLat: 20, maxLat: 10, minLng: 80, maxLng: 70 } }))
  assert.deepEqual(w.params.slice(-4), [10, 20, 70, 80])
})

test('no box leaves the query untouched', () => {
  const plain = buildWhere(mapQ())
  const nulled = buildWhere(mapQ({ bbox: null }))
  assert.equal(plain.sql, nulled.sql)
  assert.ok(!plain.sql.includes('BETWEEN'))
})

test('clusters never include rows without coordinates', () => {
  const c = mapClustersSql(mapQ(), 0.5)
  assert.ok(c.sql.includes('lat IS NOT NULL AND lng IS NOT NULL'))
  const t = clusterThumbsSql(mapQ(), 0.5)
  assert.ok(t.sql.includes('lat IS NOT NULL AND lng IS NOT NULL'))
})

test('the cell size binds before the where-clause parameters', () => {
  // SQLite binds by position in the SQL text, and the cell divisor appears in
  // the SELECT list, which comes before WHERE. Getting this order wrong would
  // silently cluster by the drive letter.
  const c = mapClustersSql(mapQ(), 0.25)
  assert.equal(c.params[0], 0.25)
  assert.equal(c.params[1], 0.25)
  assert.equal(c.params[2], 'C:')

  const t = clusterThumbsSql(mapQ(), 0.25)
  assert.deepEqual(t.params.slice(0, 4), [0.25, 0.25, 0.25, 0.25])
  assert.equal(t.params[4], 'C:')
})

test('clusters are capped and ordered by size', () => {
  const c = mapClustersSql(mapQ(), 0.5)
  assert.ok(c.sql.includes('ORDER BY n DESC'))
  assert.ok(c.sql.includes('LIMIT ?'))
  assert.ok(MAX_CLUSTERS > 0 && MAX_CLUSTERS <= 500)
})

test('each cluster gets one representative row, preferring a thumbnail', () => {
  const t = clusterThumbsSql(mapQ(), 0.5)
  assert.ok(t.sql.includes('ROW_NUMBER() OVER'))
  assert.ok(t.sql.includes('(thumb IS NULL) ASC'))
  assert.ok(t.sql.trimEnd().endsWith('WHERE rn = 1'))
})

test('a box combines with the nav filter rather than replacing it', () => {
  const w = buildWhere(mapQ({ nav: 'videos', bbox: { minLat: 0, maxLat: 1, minLng: 0, maxLng: 1 } }))
  assert.ok(w.sql.includes('ext IN ('))
  assert.ok(w.sql.includes('lat BETWEEN ? AND ?'))
  assert.ok(w.params.includes('.mp4'))
})
