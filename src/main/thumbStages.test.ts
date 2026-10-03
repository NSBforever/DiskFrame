import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ThumbStageStats, type StageSample } from './thumbStages.ts'

const sample = (o: Partial<StageSample> = {}): StageSample => ({
  waitMs: 0, lookupMs: 0, generateMs: 0, deliverMs: 0,
  cacheHit: false, failed: false, video: false, ...o
})

/** Substring assertions rather than regexes: the report is a human-readable
 *  line, and escaping its parentheses through a regex adds nothing. */
const has = (r: string | null, needle: string): void => {
  assert.ok(r !== null && r.includes(needle), `expected ${JSON.stringify(needle)} in ${JSON.stringify(r)}`)
}

test('nothing measured yet reports nothing rather than zeros', () => {
  const s = new ThumbStageStats()
  assert.equal(s.report(), null)
  assert.equal(s.total, 0)
})

test('failures are counted apart from successes', () => {
  // Averaging a 130ms undecodable stub into a 300ms real decode flatters both
  // and explains neither, which is the whole reason these are separate.
  const s = new ThumbStageStats()
  s.add(sample({ generateMs: 300 }))
  s.add(sample({ generateMs: 130, failed: true }))
  const r = s.report()
  has(r, 'generated=1 (wait 0ms, lookup 0ms, gen 300ms')
  has(r, 'failed=1 (wait 0ms, lookup 0ms, gen 130ms')
  assert.equal(s.total, 2)
})

test('a cache hit is not counted as generation', () => {
  const s = new ThumbStageStats()
  s.add(sample({ cacheHit: true, lookupMs: 2, deliverMs: 1 }))
  const r = s.report()
  has(r, 'generated=0')
  has(r, 'cached=1 (wait 0ms, lookup 2ms, gen 0ms, deliver 1ms)')
})

test('video generation is reported on its own', () => {
  // Photos decode in milliseconds and video does not; one mean hides that.
  const s = new ThumbStageStats()
  s.add(sample({ generateMs: 20 }))
  s.add(sample({ generateMs: 400, video: true }))
  s.add(sample({ generateMs: 300, video: true }))
  has(s.report(), 'video-gen=2 (gen 350ms)')
})

test('a failed video is not folded into the video generation mean', () => {
  const s = new ThumbStageStats()
  s.add(sample({ generateMs: 400, video: true }))
  s.add(sample({ generateMs: 130, video: true, failed: true }))
  has(s.report(), 'video-gen=1 (gen 400ms)')
})

test('means are per category, not over everything', () => {
  const s = new ThumbStageStats()
  s.add(sample({ waitMs: 100, generateMs: 200 }))
  s.add(sample({ waitMs: 300, generateMs: 400 }))
  has(s.report(), 'generated=2 (wait 200ms, lookup 0ms, gen 300ms')
})

test('the worst single wait and generation survive averaging', () => {
  // A mean hides the one tile that took two seconds - the one actually noticed.
  const s = new ThumbStageStats()
  s.add(sample({ waitMs: 10, generateMs: 10 }))
  s.add(sample({ waitMs: 2000, generateMs: 1500 }))
  has(s.report(), 'worst wait 2000ms, worst gen 1500ms')
})

test('reset clears every category', () => {
  const s = new ThumbStageStats()
  s.add(sample({ generateMs: 1, failed: true }))
  s.add(sample({ cacheHit: true }))
  s.reset()
  assert.equal(s.report(), null)
  assert.equal(s.total, 0)
})
