import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyMappings, missingRootOf, normalisePrefix, scoreMapping } from './pathMapping.ts'

const M = (from: string, to: string) => ({ from, to })

test('a path with no mapping is returned untouched', () => {
  const p = 'E:\\Camera\\SHA_3065.JPG'
  assert.equal(applyMappings(p, []), p)
  assert.equal(applyMappings(p, [M('E:\\Other', 'E:\\Elsewhere')]), p)
})

test('a mapped folder rewrites every path under it', () => {
  const m = [M('E:\\College Memories', 'E:\\Archive\\College Memories')]
  assert.equal(
    applyMappings('E:\\College Memories\\photos sankrathi\\DSC06148.JPG', m),
    'E:\\Archive\\College Memories\\photos sankrathi\\DSC06148.JPG'
  )
})

test('mapping matches only at a path boundary', () => {
  const m = [M('E:\\Camera', 'E:\\NewCamera')]
  // "E:\CameraRoll" is a different folder and must not be rewritten.
  assert.equal(applyMappings('E:\\CameraRoll\\a.jpg', m), 'E:\\CameraRoll\\a.jpg')
  assert.equal(applyMappings('E:\\Camera\\a.jpg', m), 'E:\\NewCamera\\a.jpg')
})

test('the most specific mapping wins', () => {
  const m = [
    M('E:\\Photos', 'E:\\A'),
    M('E:\\Photos\\2024', 'E:\\B'),
    M('E:\\Photos\\2024\\Jan', 'E:\\C')
  ]
  assert.equal(applyMappings('E:\\Photos\\2023\\x.jpg', m), 'E:\\A\\2023\\x.jpg')
  assert.equal(applyMappings('E:\\Photos\\2024\\x.jpg', m), 'E:\\B\\x.jpg')
  assert.equal(applyMappings('E:\\Photos\\2024\\Jan\\x.jpg', m), 'E:\\C\\x.jpg')
})

test('matching ignores case, as Windows does', () => {
  const m = [M('E:\\COLLEGE memories', 'E:\\Moved')]
  assert.equal(applyMappings('E:\\college Memories\\a.jpg', m), 'E:\\Moved\\a.jpg')
})

test('trailing separators do not create a second prefix', () => {
  assert.equal(normalisePrefix('E:\\x\\'), 'E:\\x')
  assert.equal(normalisePrefix('E:\\'), 'E:\\')
  const m = [M('E:\\x\\', 'E:\\y\\')]
  assert.equal(applyMappings('E:\\x\\a.jpg', m), 'E:\\y\\a.jpg')
})

test('spaces, unicode and url-special characters survive a rewrite', () => {
  const m = [M('E:\\College Memories', 'E:\\Archive #1\\Collège Mémories')]
  assert.equal(
    applyMappings('E:\\College Memories\\photos sankrathi\\DSC 06148 (1)&2.JPG', m),
    'E:\\Archive #1\\Collège Mémories\\photos sankrathi\\DSC 06148 (1)&2.JPG'
  )
})

// ─── missing root ────────────────────────────────────────────────────────

const fsLike = (present: string[]) => {
  const set = new Set(present.map((p) => p.toLowerCase()))
  return (p: string) => set.has(p.toLowerCase())
}

test('a fully resolvable path has no missing root', () => {
  const exists = fsLike(['E:\\', 'E:\\Camera', 'E:\\Camera\\a.jpg'])
  assert.equal(missingRootOf('E:\\Camera\\a.jpg', exists), null)
})

test('a missing file under a present folder is not a relink candidate', () => {
  // The folder chain is intact, so asking the user to locate a folder would be
  // the wrong question - this file alone is gone.
  const exists = fsLike(['E:\\', 'E:\\Camera'])
  assert.equal(missingRootOf('E:\\Camera\\gone.jpg', exists), null)
})

test('a missing top-level folder is reported with the drive as its ancestor', () => {
  const exists = fsLike(['E:\\', 'E:\\Camera'])
  assert.deepEqual(missingRootOf('E:\\College Memories\\x\\a.jpg', exists), {
    presentAncestor: 'E:\\',
    missingRoot: 'E:\\College Memories'
  })
})

test('a folder missing part-way down reports the deepest present ancestor', () => {
  const exists = fsLike(['E:\\', 'E:\\TO EDIT'])
  assert.deepEqual(missingRootOf('E:\\TO EDIT\\Project VARANASI\\Samsung\\a.mp4', exists), {
    presentAncestor: 'E:\\TO EDIT',
    missingRoot: 'E:\\TO EDIT\\Project VARANASI'
  })
})

test('an offline drive yields no missing root, so it is never offered for relink', () => {
  // Nothing exists, not even the drive root: that is a disconnected volume and
  // a completely different state from a moved folder.
  const exists = fsLike([])
  assert.equal(missingRootOf('E:\\College Memories\\a.jpg', exists), null)
})

// ─── mapping corroboration ───────────────────────────────────────────────

test('a correct mapping scores every sample', () => {
  const samples = [
    { storedPath: 'E:\\Old\\a.jpg', size: 10 },
    { storedPath: 'E:\\Old\\sub\\b.jpg', size: 20 }
  ]
  const probe = (p: string) =>
    p === 'E:\\New\\a.jpg' ? { size: 10 } : p === 'E:\\New\\sub\\b.jpg' ? { size: 20 } : null
  const r = scoreMapping(samples, M('E:\\Old', 'E:\\New'), probe)
  assert.deepEqual(r, { checked: 2, found: 2, sizeMatches: 2, ratio: 1 })
})

test('a wrong folder scores zero, so it can be refused', () => {
  const samples = [{ storedPath: 'E:\\Old\\a.jpg', size: 10 }]
  const r = scoreMapping(samples, M('E:\\Old', 'E:\\Unrelated'), () => null)
  assert.equal(r.found, 0)
  assert.equal(r.ratio, 0)
})

test('files present but of different sizes are counted separately', () => {
  // Same names, different content: found, but not corroborated.
  const samples = [{ storedPath: 'E:\\Old\\a.jpg', size: 10 }]
  const r = scoreMapping(samples, M('E:\\Old', 'E:\\New'), () => ({ size: 999 }))
  assert.equal(r.found, 1)
  assert.equal(r.sizeMatches, 0)
})

test('scoring an empty sample cannot report success', () => {
  const r = scoreMapping([], M('E:\\Old', 'E:\\New'), () => ({ size: 1 }))
  assert.equal(r.ratio, 0)
  assert.equal(r.checked, 0)
})
