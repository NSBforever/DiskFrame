// Regression: ISSUE-001 — photos west of Greenwich or south of the equator were
// stored in the opposite hemisphere (GPS reference tags were never read).
// Found by /qa on 2026-11-16
// Report: .gstack/qa-reports/run-20261116T0900Z/qa-report-diskframe-map-2026-11-16.md
import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { readPhotoMeta } from './photoGps.ts'

/** A tiny JPEG carrying only the GPS tags given. */
async function jpegWithGps(gps: Record<string, string>): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } })
    .jpeg()
    .withExif({ IFD3: gps })
    .toBuffer()
}

const close = (a: number | null, b: number): boolean => a !== null && Math.abs(a - b) < 1e-6

test('a photo taken in Mountain View (N, W) keeps its western longitude', async () => {
  const buf = await jpegWithGps({
    GPSLatitudeRef: 'N',
    GPSLatitude: '37/1 25/1 9984/1000',
    GPSLongitudeRef: 'W',
    GPSLongitude: '122/1 4/1 43166/1000'
  })
  const m = await readPhotoMeta(buf)
  assert.ok(close(m.lat, 37 + 25 / 60 + 9.984 / 3600), `lat ${m.lat}`)
  assert.ok(close(m.lng, -(122 + 4 / 60 + 43.166 / 3600)), `lng ${m.lng} should be west (negative)`)
})

test('a photo taken in Sydney (S, E) keeps its southern latitude', async () => {
  const buf = await jpegWithGps({
    GPSLatitudeRef: 'S',
    GPSLatitude: '33/1 52/1 0/1',
    GPSLongitudeRef: 'E',
    GPSLongitude: '151/1 12/1 0/1'
  })
  const m = await readPhotoMeta(buf)
  assert.ok(close(m.lat, -(33 + 52 / 60)), `lat ${m.lat} should be south (negative)`)
  assert.ok(close(m.lng, 151.2), `lng ${m.lng}`)
})

test('a photo taken in India (N, E) is unchanged', async () => {
  const buf = await jpegWithGps({
    GPSLatitudeRef: 'N',
    GPSLatitude: '12/1 58/1 12/1',
    GPSLongitudeRef: 'E',
    GPSLongitude: '77/1 35/1 24/1'
  })
  const m = await readPhotoMeta(buf)
  assert.ok(close(m.lat, 12 + 58 / 60 + 12 / 3600), `lat ${m.lat}`)
  assert.ok(close(m.lng, 77 + 35 / 60 + 24 / 3600), `lng ${m.lng}`)
})

test('a photo with no GPS has no position', async () => {
  const buf = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).jpeg().toBuffer()
  const m = await readPhotoMeta(buf)
  assert.equal(m.lat, null)
  assert.equal(m.lng, null)
})
