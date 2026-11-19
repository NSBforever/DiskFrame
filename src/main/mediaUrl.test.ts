import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mediaUrl, mediaUrlPath, mediaUrlVolume, withQuery } from './mediaUrl.ts'

const VOL = '\\\\?\\Volume{0f3c2a8e-1111-2222-3333-444455556666}\\'

test('a media URL can name the volume of the row it shows, and both read back exactly', () => {
  const u = mediaUrl('E:\\DCIM\\clip #2 100%.mp4', VOL)
  assert.equal(mediaUrlPath(u), 'E:\\DCIM\\clip #2 100%.mp4')
  assert.equal(mediaUrlVolume(u), VOL)
})

test('without a volume the URL is exactly the old form', () => {
  assert.equal(mediaUrl('C:\\a b.jpg'), 'media://local/C%3A/a%20b.jpg')
  assert.equal(mediaUrl('C:\\a b.jpg', null), 'media://local/C%3A/a%20b.jpg')
  assert.equal(mediaUrlVolume(mediaUrl('C:\\a.jpg')), null)
})

test("the viewer's retry parameter does not corrupt the volume", () => {
  const u = withQuery(mediaUrl('E:\\a.jpg', VOL), 'retry=2')
  assert.equal(mediaUrlVolume(u), VOL)
  assert.equal(mediaUrlPath(u), 'E:\\a.jpg')
  assert.equal(withQuery(mediaUrl('E:\\a.jpg'), 'retry=1'), 'media://local/E%3A/a.jpg?retry=1')
})

test('two volumes that share a literal path get different URLs', () => {
  assert.notEqual(mediaUrl('E:\\DCIM\\IMG_0001.JPG', 'A'), mediaUrl('E:\\DCIM\\IMG_0001.JPG', 'B'))
})
