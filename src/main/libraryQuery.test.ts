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
