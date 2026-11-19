import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modeFromPref, prefFromMode, releaseUrl, parseSnooze, shouldAnnounce, statusLine, updateFacts, updateChip, releaseNotesText, NOTES_MAX, SNOOZE_MS, type UpdateState } from './updateState.ts'

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

test('the settings facts: installed and latest version and the last check, all from the state', () => {
  const now = 10 * 60 * 60 * 1000
  const facts = (s: Partial<UpdateState>): ReturnType<typeof updateFacts> =>
    updateFacts({ ...base, ...s }, now)
  // Up to date: the latest is the one installed.
  assert.deepEqual(facts({ phase: 'current', checkedAt: now - 2 * 3600_000 }), {
    installed: '1.1.0',
    latest: '1.1.0',
    lastChecked: '2 hours ago'
  })
  // A newer version is the latest through available, downloading, ready and a failed download.
  for (const phase of ['available', 'downloading', 'ready', 'error'] as const) {
    assert.equal(facts({ phase, version: '1.2.0', checkedAt: now }).latest, '1.2.0', phase)
  }
  assert.equal(facts({ phase: 'idle' }).latest, 'Not checked yet')
  assert.equal(facts({ phase: 'idle' }).lastChecked, 'Never')
  assert.equal(facts({ phase: 'checking' }).latest, 'Checking…')
  // A failed check does not know the latest version; it never invents one.
  const failedCheck = facts({ phase: 'error', error: 'offline', checkedAt: now - 60_000 })
  assert.equal(failedCheck.latest, 'Unknown')
  assert.equal(facts({ phase: 'unsupported', reason: 'development' }).latest, 'Not checked')
  assert.equal(facts({ phase: 'current', checkedAt: now - 10_000 }).lastChecked, 'just now')
  // The phase wins over a version left over from an earlier failed download or check:
  // "up to date" never sits beside a newer Latest, and a re-check reads as checking.
  assert.equal(facts({ phase: 'current', version: '1.2.0' }).latest, '1.1.0')
  assert.equal(facts({ phase: 'checking', version: '1.2.0' }).latest, 'Checking…')
})

test('the Updates card chip names the phase, and only a real problem is shown as one', () => {
  const chip = (s: Partial<UpdateState>): string => {
    const c = updateChip({ ...base, ...s })
    return `${c.label} / ${c.tone}`
  }
  assert.equal(chip({ phase: 'current' }), 'Up to date / ok')
  assert.equal(chip({ phase: 'available', version: '1.2.0' }), 'Update available / warn')
  const halfway = chip({ phase: 'downloading', version: '1.2.0', percent: 41.6 })
  assert.equal(halfway, 'Downloading 42% / neutral')
  assert.equal(chip({ phase: 'ready', version: '1.2.0' }), 'Ready to install / ok')
  assert.equal(chip({ phase: 'error', error: 'offline' }), 'Check failed / danger')
  const badDownload = chip({ phase: 'error', version: '1.2.0', error: 'checksum' })
  assert.equal(badDownload, 'Download failed / danger')
  assert.equal(chip({ phase: 'checking' }), 'Checking… / neutral')
  assert.equal(chip({ phase: 'idle' }), 'Not checked / neutral')
  assert.equal(chip({ phase: 'unsupported', reason: 'development' }), 'Development build / neutral')
  assert.equal(chip({ phase: 'unsupported', reason: 'safe-mode' }), 'Off / neutral')
})

test('release notes become plain text: no markup or script, bullets kept, length capped', () => {
  const html =
    "<h2>What&#39;s new</h2><ul><li>MPG &amp; VOB videos</li><li>Updates</li></ul><script>alert(1)</script><p>Thanks</p>"
  assert.equal(releaseNotesText(html), "What's new\n\n• MPG & VOB videos\n• Updates\n\nThanks")
  assert.equal(releaseNotesText([{ version: '1.2.0', note: '<p>Faster</p>' }]), '1.2.0\n\nFaster')
  assert.equal(releaseNotesText(null), '')
  assert.equal(releaseNotesText(undefined), '')
  const long = releaseNotesText('<p>' + 'x'.repeat(5000) + '</p>')
  assert.equal(long.length, NOTES_MAX)
  assert.ok(long.endsWith('…'))
})
