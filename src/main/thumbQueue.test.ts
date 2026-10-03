import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_QUEUE,
  mergeThumbRequest,
  nextThumb,
  queuedCount,
  MAX_VISIBLE,
  MAX_PREFETCH
} from './thumbQueue.ts'

const none = (): boolean => false

test('visible work is generated before any prefetch work', () => {
  const q = mergeThumbRequest(EMPTY_QUEUE, { visible: ['a', 'b'], prefetch: ['x', 'y'] }, none)
  assert.deepEqual([nextThumb(q), nextThumb(q), nextThumb(q), nextThumb(q)], ['a', 'b', 'x', 'y'])
  assert.equal(nextThumb(q), undefined)
})

test('a new prefetch band cannot get in front of un-generated visible tiles', () => {
  // The regression this guards: appending the band to one shared queue meant
  // the next scroll's prefetch landed ahead of the current screen's slow
  // formats, so a screen of videos was perpetually overtaken.
  let q = mergeThumbRequest(EMPTY_QUEUE, { visible: ['slow1', 'slow2'], prefetch: [] }, none)
  q = mergeThumbRequest(q, { visible: [], prefetch: ['band1', 'band2'] }, none)
  assert.deepEqual([nextThumb(q), nextThumb(q)], ['slow1', 'slow2'])
})

test('still-owed visible work survives a new screen, behind it', () => {
  // The grid only re-requests when the visible set changes, so anything dropped
  // here would never be asked for again - measured once as 52 tiles pending
  // forever on a settled screen.
  let q = mergeThumbRequest(EMPTY_QUEUE, { visible: ['old1', 'old2'], prefetch: [] }, none)
  q = mergeThumbRequest(q, { visible: ['new1'], prefetch: [] }, none)
  assert.deepEqual([nextThumb(q), nextThumb(q), nextThumb(q)], ['new1', 'old1', 'old2'])
})

test('a stale prefetch band is replaced, not accumulated', () => {
  // The band says where the user is heading. Once they head elsewhere the old
  // band is not worth generating, and keeping every band would grow without end.
  let q = mergeThumbRequest(EMPTY_QUEUE, { visible: [], prefetch: ['down1', 'down2'] }, none)
  q = mergeThumbRequest(q, { visible: [], prefetch: ['up1'] }, none)
  assert.equal(queuedCount(q), 1)
  assert.equal(nextThumb(q), 'up1')
})

test('a path is never queued twice, and promotion beats duplication', () => {
  const q = mergeThumbRequest(
    EMPTY_QUEUE,
    { visible: ['a', 'a'], prefetch: ['a', 'b'] },
    none
  )
  assert.deepEqual([nextThumb(q), nextThumb(q), nextThumb(q)], ['a', 'b', undefined])
})

test('in-flight and known-unproducible paths are excluded from both tiers', () => {
  const busy = new Set(['inflight', 'broken'])
  const q = mergeThumbRequest(
    EMPTY_QUEUE,
    { visible: ['inflight', 'good'], prefetch: ['broken', 'alsogood'] },
    (p) => busy.has(p)
  )
  assert.deepEqual([nextThumb(q), nextThumb(q), nextThumb(q)], ['good', 'alsogood', undefined])
})

test('each tier is bounded independently', () => {
  const many = (n: number, tag: string): string[] =>
    Array.from({ length: n }, (_, i) => `${tag}${i}`)
  const q = mergeThumbRequest(
    EMPTY_QUEUE,
    { visible: many(MAX_VISIBLE + 50, 'v'), prefetch: many(MAX_PREFETCH + 50, 'p') },
    none
  )
  assert.equal(q.visible.length, MAX_VISIBLE)
  assert.equal(q.prefetch.length, MAX_PREFETCH)
  // The bound must keep the FRONT of the request - the tiles nearest the
  // viewport - not an arbitrary slice.
  assert.equal(q.visible[0], 'v0')
  assert.equal(q.prefetch[0], 'p0')
})

test('an empty request leaves outstanding work alone', () => {
  let q = mergeThumbRequest(EMPTY_QUEUE, { visible: ['a'], prefetch: ['b'] }, none)
  q = mergeThumbRequest(q, { visible: [], prefetch: [] }, none)
  // Visible work is still owed; the band was superseded by an empty one.
  assert.deepEqual(q.visible, ['a'])
  assert.deepEqual(q.prefetch, [])
})

test('a predicate lets one pool take only its own kind of work', () => {
  // Video generation is an ffmpeg subprocess; photo generation runs sharp inside
  // the main process. They need different concurrency limits but must share one
  // priority order, so the pools filter a single queue rather than keeping two.
  const q = mergeThumbRequest(
    EMPTY_QUEUE,
    { visible: ['a.jpg', 'b.mov', 'c.jpg'], prefetch: ['d.mov'] },
    none
  )
  const isVideo = (p: string): boolean => p.endsWith('.mov')
  assert.equal(nextThumb(q, isVideo), 'b.mov', 'video pool skips the photos ahead of it')
  assert.equal(nextThumb(q, (p) => !isVideo(p)), 'a.jpg', 'photo pool takes the first photo')
  assert.equal(nextThumb(q, isVideo), 'd.mov', 'and then falls through to the prefetch tier')
  assert.equal(nextThumb(q, (p) => !isVideo(p)), 'c.jpg')
  assert.equal(nextThumb(q, isVideo), undefined)
})

test('a visible item is still taken before a prefetched one of the same kind', () => {
  // The whole point of one shared queue: filtering by kind must not let a
  // prefetched item overtake a visible one.
  const q = mergeThumbRequest(EMPTY_QUEUE, { visible: ['v.mov'], prefetch: ['p.mov'] }, none)
  assert.equal(nextThumb(q, (p) => p.endsWith('.mov')), 'v.mov')
  assert.equal(nextThumb(q, (p) => p.endsWith('.mov')), 'p.mov')
})

test('no predicate keeps the original visible-then-prefetch behaviour', () => {
  const q = mergeThumbRequest(EMPTY_QUEUE, { visible: ['a'], prefetch: ['b'] }, none)
  assert.equal(nextThumb(q), 'a')
  assert.equal(nextThumb(q), 'b')
  assert.equal(nextThumb(q), undefined)
})
