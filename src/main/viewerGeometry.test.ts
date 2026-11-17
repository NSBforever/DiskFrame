import { test } from 'node:test'
import assert from 'node:assert/strict'
import { containFit, visibleFraction, provisionalBox, boxesDiffer, cubicBezier, flightFrame, flightFrames } from './viewerGeometry.ts'

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

/** Where a flight step actually puts the clip and the picture on screen. */
function applied(f: { outer: string; inner: string }, rest: { x: number; y: number; w: number; h: number }) {
  const nums = (s: string): number[] => (s.match(/-?\d+(\.\d+)?(e-?\d+)?/g) ?? []).map(Number)
  const [tx, ty, sx, sy] = nums(f.outer)
  const [ix, iy, isx, isy] = nums(f.inner)
  const clip = { x: rest.x + tx, y: rest.y + ty, w: rest.w * sx, h: rest.h * sy }
  // The picture is the clip's child: its own transform first, then the clip's.
  const pic = { x: clip.x + ix * sx, y: clip.y + iy * sy, w: rest.w * isx * sx, h: rest.h * isy * sy }
  return { clip, pic }
}
const near = (a: number, b: number, eps = 0.01): boolean => Math.abs(a - b) < eps

test('at the tile, the flight shows the tile crop: undistorted, covering, centred', () => {
  const rest = containFit({ width: 4000, height: 3000 }, stage) // 1372 x 1029
  const tile = { x: 300, y: 500, w: 120, h: 120 }
  const { clip, pic } = applied(flightFrame(tile, rest), rest)
  assert.ok(near(clip.x, 300) && near(clip.y, 500) && near(clip.w, 120) && near(clip.h, 120))
  // Same scale both ways, so the picture keeps its 4:3 shape...
  assert.ok(near(pic.w / pic.h, 4 / 3, 1e-4))
  // ...fills the tile's height, overhangs equally left and right.
  assert.ok(near(pic.h, 120) && near(pic.w, 160))
  assert.ok(near(pic.x, 300 - 20) && near(pic.y, 500))
})

test('at rest, both transforms are the identity', () => {
  const rest = containFit({ width: 3000, height: 4000 }, stage)
  const { clip, pic } = applied(flightFrame(rest, rest), rest)
  for (const b of [clip, pic]) assert.ok(near(b.x, rest.x) && near(b.y, rest.y) && near(b.w, rest.w) && near(b.h, rest.h))
})

test('every step of a flight keeps the picture undistorted and covering its clip', () => {
  const rest = containFit({ width: 6000, height: 4000 }, stage)
  const tile = { x: 40, y: 900, w: 82, h: 82 }
  const frames = flightFrames(tile, rest, rest, cubicBezier(0.2, 0.85, 0.25, 1))
  assert.equal(frames.length, 31)
  let lastW = 0
  for (const f of frames) {
    const { clip, pic } = applied(f, rest)
    assert.ok(near(pic.w / pic.h, 1.5, 1e-3), 'aspect kept')
    assert.ok(pic.x <= clip.x + 0.01 && pic.y <= clip.y + 0.01, 'covers top-left')
    assert.ok(pic.x + pic.w >= clip.x + clip.w - 0.01 && pic.y + pic.h >= clip.y + clip.h - 0.01, 'covers bottom-right')
    assert.ok(near(pic.x + pic.w / 2, clip.x + clip.w / 2) && near(pic.y + pic.h / 2, clip.y + clip.h / 2), 'centred')
    assert.ok(clip.w >= lastW - 1e-6, 'grows monotonically')
    lastW = clip.w
  }
  const end = applied(frames[frames.length - 1], rest).clip
  assert.ok(near(end.x, rest.x) && near(end.w, rest.w))
})

test('the easing matches CSS cubic-bezier at its ends and is monotonic', () => {
  const e = cubicBezier(0.2, 0.85, 0.25, 1)
  assert.equal(e(0), 0)
  assert.equal(e(1), 1)
  let last = 0
  for (let i = 1; i <= 50; i++) {
    const v = e(i / 50)
    assert.ok(v >= last && v <= 1.0001)
    last = v
  }
  // ease-out: most of the distance is covered early.
  assert.ok(e(0.3) > 0.7)
  // A linear bezier is the identity.
  assert.ok(near(cubicBezier(0, 0, 1, 1)(0.37), 0.37, 1e-4))
})
