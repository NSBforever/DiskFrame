import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickEvictionVictim, reconcileCacheVersion, removeResidentRows } from './pageCache.ts'

test('evicts the page furthest from the wanted window', () => {
  assert.equal(pickEvictionVictim([0, 5, 10, 11, 12], 10, 12), 0)
  assert.equal(pickEvictionVictim([10, 11, 12, 40], 10, 12), 40)
})

test('keeps everything when all resident pages are inside the window', () => {
  assert.equal(pickEvictionVictim([10, 11, 12], 10, 12), undefined)
  assert.equal(pickEvictionVictim([], 0, 3), undefined)
})

test('never evicts a page the grid is about to read', () => {
  // The regression: a jump to the middle leaves far-away pages resident while
  // the visible ones have only just arrived. Insertion order picked a visible
  // page; distance must pick a far one.
  const resident = [200, 201, 202, 0, 1, 2]
  const victim = pickEvictionVictim(resident, 200, 202)
  assert.ok(victim !== undefined && victim < 200, 'must evict from the far cluster')
})

test('a thumbnail landing must not invalidate the page cache', () => {
  // The regression this guards, measured on the real 40,960-row volume: with
  // total_changes() in the catalogue version, one full walk saw 16 distinct
  // versions purely because the thumbnail backfill was writing `thumb` columns.
  // Every page that arrived would then have emptied the cache and forced a
  // re-fetch - a storm during ordinary browsing, caused by pictures showing up.
  // A thumbnail changes neither membership nor ordering, so the version is
  // unchanged and every resident page survives.
  const pages = new Map<number, string[]>([
    [0, ['a']],
    [1, ['b']]
  ])
  assert.equal(reconcileCacheVersion(pages, '7', '7'), '7')
  assert.equal(pages.size, 2, 'an unchanged version must keep every resident page')
})

test('pages read against a different catalogue are dropped, not mixed', () => {
  // Discovery committed between two page reads, so the pages already held
  // describe a different set of rows and may overlap the new one. Keeping both
  // is what put one file at two indices.
  const pages = new Map<number, string[]>([
    [0, ['a']],
    [1, ['b']]
  ])
  assert.equal(reconcileCacheVersion(pages, '7', '8'), '8')
  assert.equal(pages.size, 0, 'a changed version must empty the stale resident set')
})

test('the first page to arrive sets the version without discarding itself', () => {
  const pages = new Map<number, string[]>()
  assert.equal(reconcileCacheVersion(pages, null, '3'), '3')
  assert.equal(pages.size, 0)
})


const row = (n: number, ext = '.jpg') => ({ path: `p${n}`, ext })
const pagesOf = (size: number, from: number, to: number) => {
  const m = new Map<number, { path: string; ext: string }[]>()
  for (let i = from; i < to; i++) {
    const p = Math.floor(i / size)
    if (!m.has(p)) m.set(p, [])
    m.get(p)![i - p * size] = row(i, i % 5 === 4 ? '.pdf' : '.jpg')
  }
  return m
}

test('removing a resident row shifts everything after it up by one, across pages', () => {
  const pages = pagesOf(4, 0, 12) // three full pages, rows p0..p11
  const groups = [
    { key: 'a', count: 6, compactCount: 1, offset: 0 },
    { key: 'b', count: 6, compactCount: 1, offset: 6 }
  ]
  const r = removeResidentRows(pages, 4, groups, new Set(['p2']), (e) => e === '.pdf')
  assert.equal(r.removed, 1)
  assert.deepEqual(r.pages.get(0)!.map((x) => x.path), ['p0', 'p1', 'p3', 'p4'])
  assert.deepEqual(r.pages.get(1)!.map((x) => x.path), ['p5', 'p6', 'p7', 'p8'])
  assert.deepEqual(r.pages.get(2)!.map((x) => x.path), ['p9', 'p10', 'p11'])
  assert.deepEqual(r.groups.map((g) => [g.key, g.count, g.offset]), [['a', 5, 0], ['b', 6, 5]])
})

test('compact (document) counts follow, and an emptied group disappears', () => {
  const pages = pagesOf(10, 0, 6)
  const groups = [
    { key: 'a', count: 1, compactCount: 0, offset: 0 },
    { key: 'b', count: 5, compactCount: 1, offset: 1 }
  ]
  const r = removeResidentRows(pages, 10, groups, new Set(['p0', 'p4']), (e) => e === '.pdf')
  assert.deepEqual(r.groups.map((g) => [g.key, g.count, g.compactCount, g.offset]), [['b', 4, 0, 0]])
  assert.deepEqual(r.pages.get(0)!.map((x) => x.path), ['p1', 'p2', 'p3', 'p5'])
})

test('a gap in residency leaves a hole rather than inventing a row', () => {
  const pages = pagesOf(4, 0, 4) // only page 0 resident; page 1 not
  const groups = [{ key: 'a', count: 8, compactCount: 0, offset: 0 }]
  const r = removeResidentRows(pages, 4, groups, new Set(['p1']), () => false)
  assert.deepEqual(r.pages.get(0)!.map((x) => x?.path), ['p0', 'p2', 'p3'])
  assert.equal(r.pages.get(0)![3], undefined) // p4 is not resident; the re-read fills it
  assert.equal(r.groups[0].count, 7)
})

test('nothing resident to remove changes nothing', () => {
  const pages = pagesOf(4, 0, 4)
  const groups = [{ key: 'a', count: 4, compactCount: 0, offset: 0 }]
  const r = removeResidentRows(pages, 4, groups, new Set(['elsewhere']), () => false)
  assert.equal(r.removed, 0)
  assert.equal(r.pages, pages)
})
