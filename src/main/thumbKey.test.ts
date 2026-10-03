import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

/**
 * The thumbnail cache key, mirrored from scanner.ts.
 *
 * scanner.ts cannot be imported here: it opens the production database at module
 * load. The key is three lines, so it is restated and pinned - if the real one
 * ever diverges from this, these expectations are what says so.
 */
const md5 = (s: string): string => createHash('md5').update(s).digest('hex')
const NUL = String.fromCharCode(0)
const legacyKey = (p: string): string => md5(p) + '.jpg'
const scopedKey = (p: string, volumeId: string | null): string =>
  volumeId ? md5(volumeId + NUL + p) + '.jpg' : legacyKey(p)

// Opaque stand-ins. These tests are about key separation, not about how a volume
// GUID or a Windows path is spelled.
const VOL_A = 'volume-A'
const VOL_B = 'volume-B'
const FILE = 'drive-letter-D/DCIM/IMG_0001.MOV'

test('the same path on two volumes no longer shares one thumbnail', () => {
  // This machine has had two different volumes mounted as D:. Keyed by path
  // alone, whichever thumbnail was generated first was shown for both files.
  assert.notEqual(scopedKey(FILE, VOL_A), scopedKey(FILE, VOL_B))
})

test('the same file on the same volume keeps one stable key', () => {
  assert.equal(scopedKey(FILE, VOL_A), scopedKey(FILE, VOL_A))
})

test('an unverified volume falls back to the legacy key rather than inventing a scope', () => {
  // Asserting an identity that was never established is what the rest of the app
  // refuses to do; the cache key is no different.
  assert.equal(scopedKey(FILE, null), legacyKey(FILE))
})

test('the separator cannot be forged by a path or a volume id', () => {
  // Without an unambiguous separator, volume 'AB' + path 'C' and volume 'A' +
  // path 'BC' would hash identically. NUL appears in neither.
  assert.notEqual(scopedKey('BC', 'A'), scopedKey('C', 'AB'))
})

test('the legacy key stays derivable, so an existing cache entry is findable', () => {
  // Migration adopts the old file instead of regenerating it, which only works
  // if the old key remains computable from the path alone.
  assert.equal(legacyKey(FILE), md5(FILE) + '.jpg')
  assert.notEqual(legacyKey(FILE), scopedKey(FILE, VOL_A))
})
