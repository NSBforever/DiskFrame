import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReleases, noteSections, compareVersions, shouldShowWhatsNew, cachedReleases } from './releaseHistory.ts'

const api = [
  { tag_name: 'v1.4.1', name: 'DiskFrame 1.4.1', draft: false, prerelease: false, published_at: '2026-11-19T04:55:33Z', html_url: 'https://github.com/x/y/releases/tag/v1.4.1', body: '## DiskFrame 1.4.1\n\n### A redesigned Settings page\n- **Two balanced columns** that use the width\n- Theme control\n\n### Updating\n- From 1.1.0 or later: automatic\n' },
  { tag_name: 'v1.5.0', name: 'DiskFrame 1.5.0', draft: false, prerelease: false, published_at: '2026-11-19T16:12:09Z', html_url: 'https://github.com/x/y/releases/tag/v1.5.0', body: '### All Drives\n- Browse several drives\r\n### Places and Trips\n- Found on this PC\n' },
  { tag_name: 'v1.2.1', name: 'DiskFrame 1.2.1', draft: true, prerelease: false, published_at: null, body: 'draft' },
  { tag_name: 'build-deps', name: 'Build dependencies', draft: false, prerelease: true, published_at: '2026-11-17T10:11:10Z', body: '' },
  { tag_name: 'v1.10.0', name: 'DiskFrame 1.10.0', draft: false, prerelease: false, published_at: '2027-01-01T00:00:00Z', body: null }
]

test('only published, versioned releases, newest version first', () => {
  const r = parseReleases(api)
  assert.deepEqual(r.map((x) => x.version), ['1.10.0', '1.5.0', '1.4.1'])
  assert.equal(r[1].date, '2026-11-19T16:12:09Z')
  assert.equal(r[1].url, 'https://github.com/x/y/releases/tag/v1.5.0')
})

test('anything that is not an array of release objects is an empty history, never a throw', () => {
  assert.deepEqual(parseReleases(null), [])
  assert.deepEqual(parseReleases({ message: 'API rate limit exceeded' }), [])
  assert.deepEqual(parseReleases([null, 7, { tag_name: 42 }]), [])
})

test('release notes become titled sections of plain items (bold markers dropped, CRLF tolerated)', () => {
  const r = parseReleases(api)
  assert.deepEqual(r[2].sections, [
    { title: 'A redesigned Settings page', items: ['Two balanced columns that use the width', 'Theme control'] },
    { title: 'Updating', items: ['From 1.1.0 or later: automatic'] }
  ])
  assert.deepEqual(r[1].sections.map((s) => s.title), ['All Drives', 'Places and Trips'])
  assert.deepEqual(r[0].sections, [])
})

test('notes without headings are one untitled section', () => {
  assert.deepEqual(noteSections('- one\n- two'), [{ title: '', items: ['one', 'two'] }])
})

test('versions compare numerically, not as text', () => {
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0)
  assert.ok(compareVersions('1.5.0', '1.5.0') === 0)
  assert.ok(compareVersions('1.4.1', '1.5.0') < 0)
})

test("What's New shows once after an update, never on a first install or a downgrade", () => {
  assert.equal(shouldShowWhatsNew(null, '1.6.0'), false, 'first run: nothing changed for this user')
  assert.equal(shouldShowWhatsNew('1.5.0', '1.6.0'), true)
  assert.equal(shouldShowWhatsNew('1.6.0', '1.6.0'), false, 'already seen')
  assert.equal(shouldShowWhatsNew('1.7.0', '1.6.0'), false, 'downgrade')
  assert.equal(shouldShowWhatsNew('garbage', '1.6.0'), false)
})

test('a release with an unreadable date keeps its notes and loses only the date', () => {
  const r = parseReleases([{ tag_name: 'v1.6.0', draft: false, prerelease: false, published_at: 'soon', body: '- one' }])
  assert.equal(r.length, 1)
  assert.equal(r[0].date, '')
})

test('the saved list is trusted only in the shape DiskFrame writes it', () => {
  const good = parseReleases(api)
  assert.deepEqual(cachedReleases(JSON.parse(JSON.stringify(good))), good)
  assert.deepEqual(cachedReleases({ not: 'a list' }), [])
  const bad = [
    { version: '1.0.0', name: 'x', date: '', url: '' },
    { version: '<b>', name: 'x', date: '', url: '', sections: [] },
    { version: '1.0.1', name: 'x', date: '', url: '', sections: [{ title: '', items: [7] }] },
    { version: '1.0.2', name: 'x', date: 'not a date', url: '', sections: [{ title: 'A', items: ['ok'] }] }
  ]
  assert.deepEqual(cachedReleases(bad), [{ version: '1.0.2', name: 'x', date: '', url: '', sections: [{ title: 'A', items: ['ok'] }] }])
})
