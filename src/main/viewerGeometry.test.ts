import { test } from 'node:test'
import assert from 'node:assert/strict'
import { containFit, visibleFraction, provisionalBox, boxesDiffer } from './viewerGeometry.ts'

const stage = { x: 0, y: 0, w: 1646, h: 1029 }

test('a 3:2 photo on a 16:10 screen fills the height, centred, whole and unstretched', () => {
  const b = containFit({ width: 6000, height: 4000 }, stage)
  assert.equal(Math.round(b.w * 10) / 10, 1543.5)
  assert.equal(b.h, 1029)
  assert.equal(Math.round(b.x), 51)
  assert.ok(Math.abs(b.w / b.h - 1.5) < 1e-9)
})

test('a portrait video fills the height', () => {
  const b = containFit({ width: 1080, height: 1920 }, stage)
  assert.equal(b.h, 1029)
  assert.equal(Math.round(b.w), 579)
  assert.equal(b.y, 0)
})

test('a small image is shown at its natural size, as the viewer lays it out', () => {
  assert.deepEqual(containFit({ width: 300, height: 200 }, stage), { x: 673, y: 414.5, w: 300, h: 200 })
  assert.equal(containFit({ width: 300, height: 200 }, stage, true).h, 1029)
})

test('a tile half off the screen is half visible', () => {
  assert.equal(visibleFraction({ x: -50, y: 0, w: 100, h: 100 }, stage), 0.5)
  assert.equal(visibleFraction({ x: 10, y: 10, w: 100, h: 100 }, stage), 1)
  assert.equal(visibleFraction({ x: 0, y: 2000, w: 100, h: 100 }, stage), 0)
})

test('provisional target is a centred square inside the stage', () => {
  const p = provisionalBox(stage)
  assert.equal(p.w, p.h)
  assert.ok(p.x > 0 && p.y > 0 && p.x + p.w < stage.w && p.y + p.h < stage.h)
  assert.ok(!boxesDiffer(p, { ...p, x: p.x + 0.5 }))
  assert.ok(boxesDiffer(p, { ...p, w: p.w + 3 }))
})
