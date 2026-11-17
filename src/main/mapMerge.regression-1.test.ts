// Regression: ISSUE-002 — neighbouring map places stacked their pins on top of
// each other, hiding the biggest place (682 files under an 18-file pin).
// Found by /qa on 2026-11-16
// Report: .gstack/qa-reports/run-20261116T0900Z/qa-report-diskframe-map-2026-11-16.md
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeOverlapping, type PlaceLike } from './mapMerge.ts'

// 1 degree = 100 px, so positions are easy to reason about.
const toPoint = (lat: number, lng: number): { x: number; y: number } => ({ x: lng * 100, y: -lat * 100 })
const pin = { w: 56, h: 64 }
const place = (lat: number, lng: number, count: number, thumb = ''): PlaceLike & { thumb: string } => ({
  lat, lng, count, minLat: lat, maxLat: lat, minLng: lng, maxLng: lng, thumb
})

test('two places whose pins overlap become one, with both counts', () => {
  const out = mergeOverlapping([place(14.27, 78.66, 682, 'big.jpg'), place(14.57, 78.8, 18, 'small.jpg')], toPoint, pin)
  assert.equal(out.length, 1)
  assert.equal(out[0].count, 700)
  assert.equal(out[0].thumb, 'big.jpg', 'the bigger place keeps its picture')
  assert.equal(out[0].minLat, 14.27)
  assert.equal(out[0].maxLat, 14.57)
  assert.equal(out[0].maxLng, 78.8)
  // Count-weighted position stays close to the big place.
  assert.ok(Math.abs(out[0].lat - (14.27 * 682 + 14.57 * 18) / 700) < 1e-9)
})

test('places far apart on screen stay separate', () => {
  const out = mergeOverlapping([place(14, 78, 5), place(19, 74, 7), place(37, -122, 2)], toPoint, pin)
  assert.equal(out.length, 3)
  assert.deepEqual(out.map((p) => p.count).sort((a, b) => a - b), [2, 5, 7])
})

test('a merge that moves a pin onto a third place merges that one too', () => {
  // B overlaps A; the merged pin then lands on C, which A alone did not reach.
  const a = place(0, 0, 10)
  const b = place(0, 0.5, 10)
  const c = place(0, 0.8, 1)
  const out = mergeOverlapping([a, b, c], toPoint, pin)
  assert.equal(out.length, 1)
  assert.equal(out[0].count, 21)
})

test('nothing is lost or invented', () => {
  const input = Array.from({ length: 40 }, (_, i) => place((i % 7) * 0.3, Math.floor(i / 7) * 0.3, i + 1))
  const out = mergeOverlapping(input, toPoint, pin)
  assert.equal(out.reduce((n, p) => n + p.count, 0), input.reduce((n, p) => n + p.count, 0))
  assert.equal(input[0].count, 1, 'input is not mutated')
})
