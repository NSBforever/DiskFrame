import { test } from 'node:test'
import assert from 'node:assert/strict'
import { progressiveUpdateAction, groupSelectionRange } from './progressiveLibrary.ts'
import { isWatchIgnoredPath } from './validation.ts'

const base = { nowMs: 10_000, lastReadMs: 0, intervalMs: 2500 }

test('progressive results are applied while there is nothing to disturb', () => {
  // The regression this is for: a first scan of a large drive showed a spinner
  // (and a stale zero count) until the whole volume had been walked, because
  // nothing re-read the summary as rows were committed.
  assert.equal(
    progressiveUpdateAction({ ...base, scrolled: false, hasRows: false }),
    'apply'
  )
  assert.equal(progressiveUpdateAction({ ...base, scrolled: false, hasRows: true }), 'apply')
})

test('results are parked, not applied, once the user is reading them', () => {
  assert.equal(progressiveUpdateAction({ ...base, scrolled: true, hasRows: true }), 'park')
})

test('a scrolled but still-empty library is not parked', () => {
  // Nothing on screen to re-anchor, so parking would just withhold the first
  // files behind a button the user has no reason to press.
  assert.equal(progressiveUpdateAction({ ...base, scrolled: true, hasRows: false }), 'apply')
})

test('the summary is not re-read faster than the throttle allows', () => {
  // Each read is ~230ms of synchronous main-process work on a 41k-row volume.
  // Running it per progress event trades the old freeze for a stutter.
  assert.equal(
    progressiveUpdateAction({ nowMs: 1000, lastReadMs: 0, intervalMs: 2500, scrolled: false, hasRows: false }),
    'skip'
  )
  assert.equal(
    progressiveUpdateAction({ nowMs: 2500, lastReadMs: 0, intervalMs: 2500, scrolled: false, hasRows: false }),
    'apply'
  )
  // A parked decision is still gated by the throttle - it must not fire the
  // "updates available" flag on every single progress event either.
  assert.equal(
    progressiveUpdateAction({ nowMs: 100, lastReadMs: 0, intervalMs: 2500, scrolled: true, hasRows: true }),
    'skip'
  )
})

const groups = [
  { key: '2026-09-10', count: 40, offset: 0 },
  { key: '2026-09-09', count: 10, offset: 40 },
  { key: '2026-09-08', count: 5, offset: 50 }
]

test('selecting one group covers exactly that group range', () => {
  assert.deepEqual(groupSelectionRange(groups, '2026-09-09', null, false), { start: 40, count: 10 })
  assert.deepEqual(groupSelectionRange(groups, '2026-09-10', null, false), { start: 0, count: 40 })
})

test('shift-selecting spans the contiguous run of groups, either direction', () => {
  assert.deepEqual(groupSelectionRange(groups, '2026-09-08', '2026-09-10', true), {
    start: 0,
    count: 55
  })
  assert.deepEqual(groupSelectionRange(groups, '2026-09-10', '2026-09-08', true), {
    start: 0,
    count: 55
  })
})

test('an anchor is ignored without shift, and when it is no longer in the summary', () => {
  assert.deepEqual(groupSelectionRange(groups, '2026-09-08', '2026-09-10', false), {
    start: 50,
    count: 5
  })
  assert.deepEqual(groupSelectionRange(groups, '2026-09-08', 'gone', true), { start: 50, count: 5 })
})

test('a group key from a stale query selects nothing rather than guessing', () => {
  // The confirmed bug this replaces: the grid's headers carry raw library keys
  // ("2026-09-10") while the old selection code keyed its groups by formatted
  // labels ("Thursday, September 10, 2026"), so Select matched nothing at all
  // and failed silently. A miss has to be a miss, not an arbitrary range.
  assert.equal(groupSelectionRange(groups, 'Thursday, September 10, 2026', null, false), null)
  assert.equal(groupSelectionRange([], '2026-09-10', null, false), null)
})

test('watcher ignores the directories whose churn is never user media', () => {
  // These came from chokidar's `ignored` globs. The watcher now reads the OS's
  // own recursive notifications, which filter nothing, so losing these would
  // refill the index with browser cache images the way it once did.
  assert.equal(isWatchIgnoredPath('Users\\me\\AppData\\Local\\cache\\x.png'), true)
  assert.equal(isWatchIgnoredPath('$Recycle.Bin\\S-1-5\\x.jpg'), true)
  assert.equal(isWatchIgnoredPath('Windows\\System32\\x.png'), true)
  assert.equal(isWatchIgnoredPath('Program Files (x86)\\app\\logo.png'), true)
  assert.equal(isWatchIgnoredPath('proj/node_modules/pkg/demo.jpg'), true)
  assert.equal(isWatchIgnoredPath('repo\\.git\\thing.png'), true)
})

test('watcher does not ignore ordinary user media', () => {
  assert.equal(isWatchIgnoredPath('Users\\me\\Pictures\\2026\\holiday.jpg'), false)
  assert.equal(isWatchIgnoredPath('DCIM/100CANON/IMG_0001.CR2'), false)
  // A single dot segment is the current directory, not a dot-directory.
  assert.equal(isWatchIgnoredPath('.\\Photos\\a.jpg'), false)
})
