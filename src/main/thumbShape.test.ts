import { test } from 'node:test'
import assert from 'node:assert/strict'
import { thumbShape } from './thumbShape.ts'

test('the short side is the thumbnail size and the shape is kept', () => {
  assert.deepEqual(thumbShape(4000, 3000, 300), { width: 400, height: 300 })
  assert.deepEqual(thumbShape(3000, 4000, 300), { width: 300, height: 400 })
  assert.deepEqual(thumbShape(1920, 1080, 300), { width: 533, height: 300 })
  assert.deepEqual(thumbShape(1000, 1000, 300), { width: 300, height: 300 })
})

test('a small picture is still made at thumbnail size', () => {
  assert.deepEqual(thumbShape(120, 90, 300), { width: 400, height: 300 })
})

test('a panorama is capped at 3:1 either way', () => {
  assert.deepEqual(thumbShape(12000, 1000, 300), { width: 900, height: 300 })
  assert.deepEqual(thumbShape(1000, 12000, 300), { width: 300, height: 900 })
})

test('unknown or nonsense dimensions fall back to a square', () => {
  assert.deepEqual(thumbShape(0, 0, 300), { width: 300, height: 300 })
  assert.deepEqual(thumbShape(NaN, 100, 300), { width: 300, height: 300 })
})
