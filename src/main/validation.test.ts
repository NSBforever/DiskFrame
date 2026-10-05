import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isSafeLocalPath,
  normalizeDrive,
  safePathList,
  safePathRefs,
  isUsableCaptureDate,
  isMassRemoval,
  isSameFileVersion,
  isIndexableMedia,
  canHaveThumbnail,
  isGeneratedAsset,
  isIndexableUserMedia
} from './validation.ts'

test('isSafeLocalPath accepts absolute local paths', () => {
  assert.ok(isSafeLocalPath('C:\\Users\\me\\photo.jpg'))
  assert.ok(isSafeLocalPath('D:/media/clip.mov'))
})

test('isSafeLocalPath rejects what must never reach the filesystem', () => {
  assert.ok(!isSafeLocalPath('\\\\server\\share\\secret.jpg'), 'UNC share')
  assert.ok(!isSafeLocalPath('../../etc/passwd'), 'relative traversal')
  assert.ok(!isSafeLocalPath('C:\\ok.jpg\0.png'), 'null byte')
  assert.ok(!isSafeLocalPath(''), 'empty')
  assert.ok(!isSafeLocalPath(null), 'null')
  assert.ok(!isSafeLocalPath(42), 'non-string')
  assert.ok(!isSafeLocalPath('C:' + 'a'.repeat(5000)), 'absurd length')
})

test('normalizeDrive reduces any drive-ish input to a bare letter', () => {
  assert.equal(normalizeDrive('c:'), 'C:')
  assert.equal(normalizeDrive('D:\\'), 'D:')
  assert.equal(normalizeDrive('E:\\photos\\2024'), 'E:')
  assert.equal(normalizeDrive('  f:  '), 'F:')
})

test('normalizeDrive rejects anything that is not a drive letter', () => {
  assert.equal(normalizeDrive('\\\\server\\share'), null)
  assert.equal(normalizeDrive('../..'), null)
  assert.equal(normalizeDrive(''), null)
  assert.equal(normalizeDrive(undefined), null)
  assert.equal(normalizeDrive({ toString: () => 'C:' }), null, 'non-string object')
})

test('safePathList filters and caps', () => {
  assert.deepEqual(safePathList(['C:\\a.jpg', '../b.jpg', null, 'D:/c.png']), [
    'C:\\a.jpg',
    'D:/c.png'
  ])
  assert.deepEqual(safePathList('not an array'), [])
  assert.equal(safePathList(Array(500).fill('C:\\a.jpg'), 200).length, 200)
})

// A single-file action sends { path, volumeId } so trash/restore/permanent-
// delete act on exactly the row the user meant, even if another volume has a
// row at the same path; a batch action built from a selection of paths alone
// still sends bare strings, and both must survive in one call.
test('safePathRefs accepts bare paths and volume-scoped refs together', () => {
  const refs = safePathRefs([
    'C:\\a.jpg',
    { path: 'D:\\b.jpg', volumeId: 'VOL-1' },
    { path: 'E:\\c.jpg', volumeId: null },
    { path: 'F:\\legacy.jpg' }
  ])
  assert.deepEqual(refs, [
    'C:\\a.jpg',
    { path: 'D:\\b.jpg', volumeId: 'VOL-1' },
    { path: 'E:\\c.jpg', volumeId: null },
    { path: 'F:\\legacy.jpg', volumeId: undefined }
  ])
})

test('safePathRefs drops unsafe paths in either shape, and non-array input', () => {
  assert.deepEqual(
    safePathRefs(['../etc/passwd', { path: '\\\\server\\share\\x.jpg', volumeId: 'V' }, { path: 'C:\\ok.jpg' }]),
    [{ path: 'C:\\ok.jpg', volumeId: undefined }]
  )
  assert.deepEqual(safePathRefs('not an array'), [])
  assert.deepEqual(safePathRefs([{ volumeId: 'V' }, 42, null]), [])
})

test('safePathRefs caps like safePathList', () => {
  assert.equal(safePathRefs(Array(500).fill('C:\\a.jpg'), 200).length, 200)
})

// Regression: files with no readable capture date were being stamped with
// new Date(), which filed 24k files under the current month.
test('isUsableCaptureDate accepts a real capture date', () => {
  assert.ok(isUsableCaptureDate(new Date('2019-07-04T11:30:00Z')))
  assert.ok(isUsableCaptureDate(new Date('1999-12-31T23:59:59Z')))
})

test('isUsableCaptureDate rejects fabricated and degenerate dates', () => {
  assert.ok(!isUsableCaptureDate(null), 'missing')
  assert.ok(!isUsableCaptureDate(undefined), 'undefined')
  assert.ok(!isUsableCaptureDate(new Date('not a date')), 'unparseable')
  assert.ok(!isUsableCaptureDate(new Date(0)), 'unix epoch')
  assert.ok(!isUsableCaptureDate(new Date('1970-01-01T00:00:00Z')), '1970')
  assert.ok(!isUsableCaptureDate(new Date(Date.now() + 7 * 86400000)), 'future')
})

test('isUsableCaptureDate tolerates small clock skew around now', () => {
  assert.ok(isUsableCaptureDate(new Date(Date.now() - 60000)), 'a minute ago')
  assert.ok(isUsableCaptureDate(new Date(Date.now() + 3600000)), 'an hour ahead')
})

// Regression: an unplugged or swapped drive made every stat fail, so the sync
// reported the whole index as removed and deleted it.
test('isMassRemoval flags a whole-volume disappearance', () => {
  assert.ok(isMassRemoval(40803, 40803), 'entire drive vanished')
  assert.ok(isMassRemoval(30000, 40803), 'most of the drive vanished')
})

test('isMassRemoval allows genuine deletions through', () => {
  assert.ok(!isMassRemoval(1, 40803), 'one file deleted')
  assert.ok(!isMassRemoval(500, 40803), 'a folder deleted')
  assert.ok(!isMassRemoval(100, 120), 'small index, under the absolute floor')
  assert.ok(!isMassRemoval(0, 40803), 'nothing removed')
})

test('isIndexableMedia accepts the formats the app is for', () => {
  assert.ok(isIndexableMedia('E:\\trip\\IMG_4614.MOV'), 'uppercase video')
  assert.ok(isIndexableMedia('C:\\Users\\me\\Pictures\\a.jpg'))
  assert.ok(isIndexableMedia('C:\\x\\b.HEIC'))
  assert.ok(isIndexableMedia('C:\\x\\notes.pdf'))
})

// Regression: the watcher indexed whatever changed on disk, so ordinary
// desktop activity filed source files, databases and browser state into a
// media index - and then spawned ffmpeg on each of them.
test('isIndexableMedia rejects the junk that polluted the index', () => {
  assert.ok(!isIndexableMedia('C:\\Users\\me\\diskframe\\src\\main\\index.ts'), 'source file')
  assert.ok(!isIndexableMedia('C:\\Users\\me\\AppData\\Roaming\\diskframe\\diskframe.db'), 'the app database')
  assert.ok(!isIndexableMedia('C:\\Users\\me\\AppData\\Local\\Brave\\User Data\\Local State'), 'no extension')
  assert.ok(!isIndexableMedia('C:\\x\\settings.dat'))
  assert.ok(!isIndexableMedia('C:\\x\\cache-break-state.json'))
  assert.ok(!isIndexableMedia('C:\\x\\HxStore.hxd'))
  assert.ok(!isIndexableMedia('C:\\x\\a.customDestinations-ms'))
})

test('isIndexableMedia does not mistake a dotfile for an extension', () => {
  assert.ok(!isIndexableMedia('C:\\Users\\me\\.gitignore'))
  assert.ok(!isIndexableMedia('C:\\Users\\me\\.jpg'), 'dotfile that looks like an extension')
})

test('isIndexableMedia is not fooled by dots in directory names', () => {
  assert.ok(isIndexableMedia('C:\\my.photos.2024\\shot.jpg'))
  assert.ok(!isIndexableMedia('C:\\my.photos.2024\\README'))
})

test('canHaveThumbnail excludes documents that reach the index legitimately', () => {
  assert.ok(canHaveThumbnail('C:\\x\\a.jpg'))
  assert.ok(canHaveThumbnail('C:\\x\\a.mov'))
  assert.ok(!canHaveThumbnail('C:\\x\\a.pdf'), 'indexed, but no thumbnail pipeline')
  assert.ok(!canHaveThumbnail('C:\\x\\a.txt'))
})

// Regression: the app's own generated thumbnails were indexed as photos, so
// every video and photo appeared a second time as a tile of its own thumbnail.
// Measured on a real library: 25,974 such rows, 25,873 of them exactly some
// other row's `thumb`.
test('isGeneratedAsset catches the app own output', () => {
  assert.ok(isGeneratedAsset('C:\\Users\\me\\AppData\\Roaming\\diskframe\\thumbs\\a257529c.jpg'))
  assert.ok(isGeneratedAsset('C:\\Users\\me\\AppData\\Roaming\\diskframe\\heic_cache\\x.jpg'))
  assert.ok(isGeneratedAsset('C:\\Users\\me\\AppData\\Roaming\\diskframe\\transcoded\\x.mp4'))
  assert.ok(isGeneratedAsset('C:\\Users\\me\\AppData\\Local\\DiskFrame-Diagnostics\\thumbs\\x.jpg'))
  assert.ok(isGeneratedAsset('C:\\Temp\\df_raw_1c5d198e_1789.png'), 'temp extraction frame')
  assert.ok(isGeneratedAsset('C:\\proj\\node_modules\\pkg\\demo.jpg'))
})

test('isGeneratedAsset handles forward slashes too', () => {
  assert.ok(isGeneratedAsset('C:/Users/me/AppData/Roaming/diskframe/thumbs/a.jpg'))
})

// The vault holds real user media the app relocated. Those rows are genuine.
test('isGeneratedAsset does not touch the vault or real media', () => {
  assert.ok(!isGeneratedAsset('C:\\Users\\me\\AppData\\Roaming\\diskframe\\vault\\abc.jpg'), 'vault is real media')
  assert.ok(!isGeneratedAsset('C:\\Users\\me\\Pictures\\thumbs of my trip\\a.jpg'), 'user folder merely named thumbs')
  assert.ok(!isGeneratedAsset('E:\\Camera Roll\\IMG_1131.mov'))
  assert.ok(!isGeneratedAsset(''))
})

test('isIndexableUserMedia combines both rules', () => {
  assert.ok(isIndexableUserMedia('E:\\trip\\IMG_1131.mov'))
  assert.ok(!isIndexableUserMedia('C:\\x\\AppData\\Roaming\\diskframe\\thumbs\\a.jpg'), 'generated')
  assert.ok(!isIndexableUserMedia('C:\\x\\notes.ts'), 'not media at all')
})

test('isGeneratedAsset excludes the app own build output', () => {
  assert.ok(isGeneratedAsset('C:\\Users\\me\\diskframe\\out\\renderer\\assets\\earth-dark.jpg'))
  assert.ok(isGeneratedAsset('C:\\Users\\me\\diskframe\\dist\\win-unpacked\\x.png'))
  assert.ok(!isGeneratedAsset('C:\\Users\\me\\Pictures\\out\\holiday.jpg'), 'a user folder named out')
})

test('a read is not a change: same size and mtime means the same file version', () => {
  // Windows updates last-access time when a file is read, and the watcher is
  // told. Generating a thumbnail therefore came back as a "change" that
  // deleted that thumbnail, regenerated it and overwrote the capture date.
  const row = { size: 2_000_000, mtime: 1_700_000_000_123 }
  assert.ok(isSameFileVersion(row, { size: 2_000_000, mtimeMs: 1_700_000_000_123.4 }))
  assert.ok(!isSameFileVersion(row, { size: 2_000_001, mtimeMs: 1_700_000_000_123 }), 'size changed')
  assert.ok(!isSameFileVersion(row, { size: 2_000_000, mtimeMs: 1_700_000_005_000 }), 'rewritten')
  assert.ok(!isSameFileVersion({ size: 2_000_000, mtime: null }, { size: 2_000_000, mtimeMs: 1 }), 'never recorded')
})
