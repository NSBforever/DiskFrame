import { test } from 'node:test'
import assert from 'node:assert/strict'
import { usageColor } from './usageColor.ts'

function rgb(s: string): [number, number, number] {
  const m = s.match(/rgb\((\d+), (\d+), (\d+)\)/)
  assert.ok(m, `not an rgb() string: ${s}`)
  return [Number(m![1]), Number(m![2]), Number(m![3])]
}
const isGreen = (c: [number, number, number]): boolean => c[1] > c[0] + 40
const isRed = (c: [number, number, number]): boolean => c[0] > c[1] + 100

test('low usage is green', () => {
  assert.ok(isGreen(rgb(usageColor(0))))
  assert.ok(isGreen(rgb(usageColor(20))))
})

// The external drive in the report sits near half full and should read
// yellow-green: green and red comparable, blue low.
test('around 50% is yellow-green, not green and not orange', () => {
  const c = rgb(usageColor(50))
  assert.ok(c[1] > 150, `green channel should stay high, got ${c}`)
  assert.ok(c[0] > 100, `red channel should have risen, got ${c}`)
  assert.ok(c[2] < 110, `blue should be low, got ${c}`)
})

test('around 65% is yellow', () => {
  const c = rgb(usageColor(65))
  assert.ok(c[0] > 180 && c[1] > 180, `expected yellow, got ${c}`)
  assert.ok(c[2] < 110, `blue should be low, got ${c}`)
})

test('around 80% is orange', () => {
  const c = rgb(usageColor(80))
  assert.ok(c[0] > 200, `red channel high, got ${c}`)
  assert.ok(c[1] > 110 && c[1] < 200, `green mid, got ${c}`)
})

// C: is 97.7% full in the report and must stay unambiguously red.
test('95-100% is red', () => {
  assert.ok(isRed(rgb(usageColor(95))), String(usageColor(95)))
  assert.ok(isRed(rgb(usageColor(97.7))), String(usageColor(97.7)))
  assert.ok(isRed(rgb(usageColor(100))), String(usageColor(100)))
})

test('the ramp is continuous - no jumps between neighbouring percentages', () => {
  let prev = rgb(usageColor(0))
  for (let p = 1; p <= 100; p++) {
    const cur = rgb(usageColor(p))
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(cur[i] - prev[i]) <= 12, `jump at ${p}% channel ${i}: ${prev} -> ${cur}`)
    }
    prev = cur
  }
})

test('out-of-range and nonsense inputs are clamped', () => {
  assert.ok(isGreen(rgb(usageColor(-20))))
  assert.ok(isRed(rgb(usageColor(150))))
  assert.ok(isGreen(rgb(usageColor(NaN))), 'NaN falls back to the low end')
})
