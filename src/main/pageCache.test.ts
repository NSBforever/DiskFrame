import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickEvictionVictim } from './pageCache.ts'

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
