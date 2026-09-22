import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isSafeLocalPath,
  normalizeDrive,
  safePathList,
  isIndexableMedia,
  canHaveThumbnail,
  isGeneratedAsset
} from './validation.ts'

const BS = String.fromCharCode(92)
const j = (...parts: string[]): string => parts.join(BS)

// Real library paths: spaces, apostrophes, ampersands, parentheses, commas and
// the backslash separators Windows actually uses. Taken from folder names that
// exist on the drive this was developed against.
const REAL = [
  j('E:', 'GRAVITAS 2026', 'GraVITas Day 2&3', '2026_09_20_22_33_IMG_5217.MOV'),
  j('E:', 'SaiBaba Files', "NSB's iPhone 14 pro files", '2022', 'Class 12', 'IMG_5444.MOV'),
  j('E:', '1)Nana Mobile Videos', 'SaiBaba Home.mp4'),
  j('E:', 'Family Pictures', 'Tiktok Videos March 29th,2019', 'clip.mp4'),
  j('E:', '3rd year Jan - May', 'photo.JPG')
]

// Built from code points so this file stays ASCII: CJK, accented Latin with an
// en dash, Devanagari, and an astral-plane emoji (a surrogate pair, which is
// where naive length or slicing logic breaks).
const CJK = String.fromCharCode(0x5199, 0x771f)
const ACCENT = 'M' + String.fromCharCode(0xfc) + 'nchen ' + String.fromCharCode(0x2013) + ' 2024'
const DEVA = String.fromCharCode(0x906, 0x932, 0x92c, 0x92e)
const EMOJI = 'photo ' + String.fromCharCode(0xd83d, 0xdcf7)

const UNICODE = [
  j('E:', 'Photos', CJK + '.jpg'),
  j('E:', 'Fotos', ACCENT + '.jpg'),
  j('E:', DEVA, EMOJI + '.jpg')
]

test('accepts real Windows paths with spaces and punctuation', () => {
  for (const p of REAL) assert.equal(isSafeLocalPath(p), true, p)
})

test('accepts Unicode path components including an astral emoji', () => {
  for (const p of UNICODE) assert.equal(isSafeLocalPath(p), true, p)
})

test('accepts forward slashes as well as backslashes', () => {
  assert.equal(isSafeLocalPath('E:/GRAVITAS 2026/clip.mov'), true)
  assert.equal(isSafeLocalPath(j('E:', 'GRAVITAS 2026')), true)
})

test('rejects UNC shares, relative paths and null bytes', () => {
  assert.equal(isSafeLocalPath(BS + BS + j('server', 'share', 'a.jpg')), false)
  assert.equal(isSafeLocalPath(j('GRAVITAS 2026', 'clip.mov')), false)
  assert.equal(isSafeLocalPath(j('E:', 'a' + String.fromCharCode(0) + 'b.jpg')), false)
  assert.equal(isSafeLocalPath('E:'), false)
  assert.equal(isSafeLocalPath(''), false)
  assert.equal(isSafeLocalPath(undefined), false)
})

test('extension detection survives spaces, dots and Unicode in names', () => {
  assert.equal(isIndexableMedia(j('E:', 'GraVITas Day 2&3', 'a b.c d.MOV')), true)
  assert.equal(canHaveThumbnail(j('E:', 'x', 'IMG_5217.MOV')), true)
  assert.equal(canHaveThumbnail(j('E:', DEVA, EMOJI + '.jpg')), true)
  // A dot in a DIRECTORY name must not be read as the file's extension.
  assert.equal(isIndexableMedia(j('E:', 'v1.2', 'Local State')), false)
})

test('normalizeDrive handles the letter forms paths arrive in', () => {
  assert.equal(normalizeDrive(j('e:', 'GRAVITAS 2026')), 'E:')
  assert.equal(normalizeDrive('E:'), 'E:')
  assert.equal(normalizeDrive('  e:/x  '), 'E:')
  assert.equal(normalizeDrive(BS + BS + j('server', 'share')), null)
  assert.equal(normalizeDrive(''), null)
})

test('safePathList keeps real and Unicode paths, drops unsafe ones', () => {
  const mixed: unknown[] = [...REAL, ...UNICODE, BS + BS + j('server', 'x.jpg'), 'relative.jpg', 42]
  const out = safePathList(mixed, 200)
  assert.equal(out.length, REAL.length + UNICODE.length)
  for (const p of [...REAL, ...UNICODE]) assert.ok(out.includes(p), p)
})

test('generated-asset exclusion is case-insensitive on real-shaped paths', () => {
  const thumb = j('C:', 'Users', 'nagir', 'AppData', 'Roaming', 'diskframe', 'thumbs', 'a.jpg')
  assert.equal(isGeneratedAsset(thumb), true)
  assert.equal(isGeneratedAsset(thumb.toUpperCase()), true)
  // User media in a folder that merely contains the word is not generated.
  assert.equal(isGeneratedAsset(j('E:', 'My thumbs', 'a.jpg')), false)
})
