import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickEvictionVictim, reconcileCacheVersion } from './pageCache.ts'

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
