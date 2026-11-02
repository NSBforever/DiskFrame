import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import { parseRange, fileResponse } from './mediaRange.ts'
import { mediaUrl, mediaUrlPath } from './mediaUrl.ts'

test('parseRange: absent or malformed headers serve the whole file', () => {
  assert.equal(parseRange(null, 100), null)
  assert.equal(parseRange('items=0-5', 100), null)
  assert.equal(parseRange('bytes=-', 100), null)
})

test('parseRange: open, closed, clamped and suffix ranges', () => {
  assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 })
  assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 })
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=-30', 100), { start: 70, end: 99 })
  assert.deepEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 })
  assert.deepEqual(parseRange('bytes=0-1, 5-6', 100), { start: 0, end: 1 })
})

test('parseRange: ranges outside the file are unsatisfiable', () => {
  assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable')
  assert.equal(parseRange('bytes=20-10', 100), 'unsatisfiable')
  assert.equal(parseRange('bytes=-0', 100), 'unsatisfiable')
})

test('fileResponse: 206 with Content-Range for a range, 200 without one, 416 past the end', async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'df-range-'))
  const file = join(dir, 'clip.mp4')
  fs.writeFileSync(file, Buffer.from('0123456789'))
  try {
    const part = await fileResponse(file, 'bytes=2-5')
    assert.equal(part.status, 206)
    assert.equal(part.headers.get('content-range'), 'bytes 2-5/10')
    assert.equal(part.headers.get('content-length'), '4')
    assert.equal(part.headers.get('content-type'), 'video/mp4')
    assert.equal(await part.text(), '2345')

    const whole = await fileResponse(file, null)
    assert.equal(whole.status, 200)
    assert.equal(whole.headers.get('accept-ranges'), 'bytes')
    assert.equal(await whole.text(), '0123456789')

    const past = await fileResponse(file, 'bytes=10-')
    assert.equal(past.status, 416)
    assert.equal(past.headers.get('content-range'), 'bytes */10')

    assert.equal((await fileResponse(join(dir, 'missing.mp4'), null)).status, 404)
    assert.equal((await fileResponse(dir, null)).status, 404)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('mediaUrl round-trips names with #, %, spaces and non-ASCII', () => {
  for (const p of [
    'C:\\DCIM\\clip #2 100%.mp4',
    'D:\\Fotos\\Año nuevo\\IMG 1.HEIC',
    'E:\\a&b=c?.jpg'
  ]) {
    const url = mediaUrl(p)
    assert.ok(url.startsWith('media://local/') && !url.includes('#'), url)
    assert.equal(mediaUrlPath(url), p)
  }
  // The viewer's Retry appends a query; it is not part of the path.
  assert.equal(mediaUrlPath(mediaUrl('C:\\x.jpg') + '?retry=1'), 'C:\\x.jpg')
  assert.equal(mediaUrlPath('media://local/C%3A/bad%E0%A4%A.jpg'), null)
  assert.equal(mediaUrlPath('media:///C:/old-form.jpg'), null)
})
