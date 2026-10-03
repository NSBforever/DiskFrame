import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orderBand, DIRECTION_DISCOUNT, type BandCandidate } from './thumbBand.ts'

/** Rows 0..39, one path each, with the viewport mounted over 20..24. */
const all: BandCandidate[] = Array.from({ length: 40 }, (_, i) => ({ index: i, path: 'p' + i }))
const FIRST = 20
const LAST = 24

test('nothing inside the viewport is queued as band work', () => {
  const out = orderBand(all, FIRST, LAST, 'none')
  for (let i = FIRST; i <= LAST; i++) {
    assert.ok(!out.includes('p' + i), `p${i} is visible and belongs to the visible tier`)
  }
  assert.equal(out.length, 40 - (LAST - FIRST + 1))
})

test('nearer rows come before distant ones', () => {
  const out = orderBand(all, FIRST, LAST, 'none')
  // p25 is 1 past the end, p19 is 1 before the start: both nearer than p30/p10.
  assert.ok(out.indexOf('p25') < out.indexOf('p30'))
  assert.ok(out.indexOf('p19') < out.indexOf('p10'))
})

test('scrolling down prefers rows below, without excluding rows above', () => {
  const out = orderBand(all, FIRST, LAST, 'down')
  assert.equal(out[0], 'p25', 'the row about to appear is first')
  // Distance 1 below scores 0.5; distance 1 above scores 1. Below wins.
  assert.ok(out.indexOf('p25') < out.indexOf('p19'))
  // The trailing side is still present - a reversal must not wait for a drain.
  assert.ok(out.includes('p19') && out.includes('p10'))
})

test('scrolling up mirrors it exactly', () => {
  const out = orderBand(all, FIRST, LAST, 'up')
  assert.equal(out[0], 'p19')
  assert.ok(out.indexOf('p19') < out.indexOf('p25'))
  assert.ok(out.includes('p25') && out.includes('p30'))
})

test('the discount bounds how far the leading side can reach ahead of the trailing side', () => {
  // With a 0.5 discount, a leading row at distance 4 (score 2) still beats a
  // trailing row at distance 3 (score 3), but not one at distance 1.
  const out = orderBand(all, FIRST, LAST, 'down')
  assert.equal(DIRECTION_DISCOUNT, 0.5)
  assert.ok(out.indexOf('p28') < out.indexOf('p17'), 'leading d=4 beats trailing d=3')
  assert.ok(out.indexOf('p19') < out.indexOf('p29'), 'trailing d=1 still beats leading d=5')
})

test('with no direction, both sides interleave by pure distance', () => {
  const out = orderBand(all, FIRST, LAST, 'none')
  // Distance 1 both ways comes before distance 2 either way.
  const d1 = [out.indexOf('p25'), out.indexOf('p19')]
  const d2 = [out.indexOf('p26'), out.indexOf('p18')]
  assert.ok(Math.max(...d1) < Math.min(...d2))
})

test('the order is total and stable across repeated calls', () => {
  // The band is recomputed on every scroll event. An unstable order would
  // re-request the same work in a different sequence each time.
  const a = orderBand(all, FIRST, LAST, 'down')
  for (let i = 0; i < 5; i++) assert.deepEqual(orderBand(all, FIRST, LAST, 'down'), a)
  // Input order must not matter either.
  assert.deepEqual(orderBand([...all].reverse(), FIRST, LAST, 'down'), a)
})

test('an empty band and a viewport covering everything both yield nothing', () => {
  assert.deepEqual(orderBand([], 0, 10, 'down'), [])
  assert.deepEqual(orderBand(all, 0, 39, 'down'), [])
})
