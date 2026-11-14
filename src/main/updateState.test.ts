import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modeFromPref, prefFromMode, releaseUrl, parseSnooze, shouldAnnounce, statusLine, SNOOZE_MS, type UpdateState } from './updateState.ts'

const base: UpdateState = { phase: 'idle', currentVersion: '1.1.0', canInstall: true }
const quiet = { busy: false, snooze: null, now: 1_000_000, dismissed: false }

test('the old boolean preference keeps its meaning', () => {
  assert.equal(modeFromPref(1), 'auto')
  assert.equal(modeFromPref(0), 'off')
  assert.equal(modeFromPref(2), 'notify')
  // A missing row, NULL, or junk is the default.
  assert.equal(modeFromPref(undefined), 'auto')
  assert.equal(modeFromPref(null), 'auto')
  assert.equal(modeFromPref(7), 'auto')
  for (const m of ['auto', 'notify', 'off'] as const) assert.equal(modeFromPref(prefFromMode(m)), m)
})

test('release notes open the release for that exact version, or the list', () => {
  assert.equal(releaseUrl('1.2.0'), 'https://github.com/NSBforever/DiskFrame/releases/tag/v1.2.0')
  assert.equal(releaseUrl('2.0.0-beta.1'), 'https://github.com/NSBforever/DiskFrame/releases/tag/v2.0.0-beta.1')
  assert.equal(releaseUrl(undefined), 'https://github.com/NSBforever/DiskFrame/releases')
  // Never a URL built from something that is not a version.
  assert.equal(releaseUrl('../../evil'), 'https://github.com/NSBforever/DiskFrame/releases')
  assert.equal(releaseUrl('1.2.0?x=1'), 'https://github.com/NSBforever/DiskFrame/releases')
})

test('only things the user can act on are announced', () => {
  for (const phase of ['unsupported', 'idle', 'checking', 'current'] as const) {
    assert.equal(shouldAnnounce({ ...base, phase }, quiet), false, phase)
  }
  for (const phase of ['available', 'downloading', 'ready'] as const) {
    assert.equal(shouldAnnounce({ ...base, phase, version: '1.2.0' }, quiet), true, phase)
  }
})

test('a failed background check is silent; a failed download is not', () => {
  assert.equal(shouldAnnounce({ ...base, phase: 'error', error: 'net::ERR_INTERNET_DISCONNECTED' }, quiet), false)
  assert.equal(shouldAnnounce({ ...base, phase: 'error', version: '1.2.0', error: 'sha512 mismatch' }, quiet), true)
})

test('nothing is shown over a transfer or an open viewer', () => {
  const ready: UpdateState = { ...base, phase: 'ready', version: '1.2.0' }
  assert.equal(shouldAnnounce(ready, { ...quiet, busy: true }), false)
  assert.equal(shouldAnnounce(ready, quiet), true)
})

test('remind me later hides that version for a day, and only that version', () => {
  const avail: UpdateState = { ...base, phase: 'available', version: '1.2.0' }
  const snooze = { version: '1.2.0', until: quiet.now + SNOOZE_MS }
  assert.equal(shouldAnnounce(avail, { ...quiet, snooze }), false)
  assert.equal(shouldAnnounce(avail, { ...quiet, snooze, now: snooze.until + 1 }), true)
  assert.equal(shouldAnnounce({ ...avail, version: '1.3.0' }, { ...quiet, snooze }), true)
  // A snooze never hides a download the user started or an update ready to install.
  assert.equal(shouldAnnounce({ ...avail, phase: 'ready' }, { ...quiet, snooze }), true)
})

test('a stored snooze that is not one is ignored', () => {
  assert.equal(parseSnooze(null), null)
  assert.equal(parseSnooze('not json'), null)
  assert.equal(parseSnooze('{"version":5}'), null)
  assert.deepEqual(parseSnooze('{"version":"1.2.0","until":5}'), { version: '1.2.0', until: 5 })
})

test('the settings line says what happened, with both versions when they differ', () => {
  const now = 10 * 60 * 60 * 1000
  assert.match(statusLine({ ...base, phase: 'current', checkedAt: now - 5 * 60000 }, now), /1\.1\.0 is the latest version\. Checked 5 minutes ago\./)
  assert.match(statusLine({ ...base, phase: 'available', version: '1.2.0' }, now), /1\.2\.0 is available\. You have 1\.1\.0\./)
  assert.match(statusLine({ ...base, phase: 'downloading', version: '1.2.0', percent: 41.6 }, now), /42%/)
  assert.match(statusLine({ ...base, phase: 'error', error: 'offline' }, now), /Could not check for updates: offline/)
  assert.match(statusLine({ ...base, phase: 'error', version: '1.2.0', error: 'checksum' }, now), /Could not download the update: checksum/)
  assert.match(statusLine({ ...base, phase: 'ready', version: '1.2.0' }, now), /installs when you close/)
})
