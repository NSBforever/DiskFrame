import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { parseExifOffset, wallAtOffset, fsEarliest } from './captureTime.ts'
import { readPhotoMeta } from './photoGps.ts'

test('EXIF offsets parse to minutes east of UTC', () => {
  assert.equal(parseExifOffset('+05:30'), 330)
  assert.equal(parseExifOffset('-08:00'), -480)
  assert.equal(parseExifOffset('+0900'), 540)
  assert.equal(parseExifOffset('+00:00'), 0)
  for (const bad of [undefined, null, '', 'Z', '5:30', '+25:00', 330]) assert.equal(parseExifOffset(bad), null, String(bad))
})

test('a wall-clock time is placed at its own offset, whatever zone this runs in', () => {
  const wall = new Date(2026, 10, 18, 10, 15, 0) // 10:15 on the clock that took it
  assert.equal(wallAtOffset(wall, 540).toISOString(), '2026-11-18T01:15:00.000Z', 'Tokyo')
  assert.equal(wallAtOffset(wall, 330).toISOString(), '2026-11-18T04:45:00.000Z', 'India')
  assert.equal(wallAtOffset(wall, -480).toISOString(), '2026-11-18T18:15:00.000Z', 'California')
})

test('the filesystem date is the earlier of creation and modification', () => {
  const t = Date.parse('2026-11-18T05:00:00Z')
  assert.deepEqual(fsEarliest(t, t + 86_400_000), { ms: t, source: 'mtime' }, 'a copy: created later than modified')
  assert.deepEqual(fsEarliest(t, t - 600_000), { ms: t - 600_000, source: 'birthtime' }, 'a recording: created when it started')
  assert.deepEqual(fsEarliest(t, t - 1000), { ms: t, source: 'mtime' }, 'within rounding slack')
  assert.deepEqual(fsEarliest(t, 0), { ms: t, source: 'mtime' }, 'no creation time')
  assert.deepEqual(fsEarliest(t, null), { ms: t, source: 'mtime' })
})

async function jpegWithExif(exif: Record<string, string>): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).jpeg().withExif({ IFD2: exif }).toBuffer()
}

test('a photo taken in Tokyo is stored at its real instant, not this machine\'s', async () => {
  // Regression: exifr ignores OffsetTimeOriginal, so this came out as 10:15
  // in whatever zone DiskFrame ran in (04:45Z at UTC+5:30).
  const m = await readPhotoMeta(await jpegWithExif({ DateTimeOriginal: '2026:11:18 10:15:00', OffsetTimeOriginal: '+09:00' }))
  assert.equal(m.date?.toISOString(), '2026-11-18T01:15:00.000Z')
  assert.equal(m.offsetMin, 540)
})

test('a photo with no recorded offset keeps the old local reading', async () => {
  const m = await readPhotoMeta(await jpegWithExif({ DateTimeOriginal: '2026:11:18 10:15:00' }))
  assert.equal(m.date?.getTime(), new Date(2026, 10, 18, 10, 15, 0).getTime())
  assert.equal(m.offsetMin, null)
})
