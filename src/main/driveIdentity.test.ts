import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveDriveLetters,
  independentLetters,
  type RawDriveLetter
} from './driveIdentity.ts'

const C: RawDriveLetter = { letter: 'C:', volumeId: '\\\\?\\Volume{fd2dcab2}\\', fsSerial: 'C8570EC9' }
const D: RawDriveLetter = { letter: 'D:', volumeId: '\\\\?\\Volume{8b027a84}\\', fsSerial: '887E7591' }
// The real reported case: `subst T: C:\Users\...\diskframe-test\media`. Windows
// enumerates T: in Win32_LogicalDisk with C:'s volume name, C:'s serial and C:'s
// capacity, but Win32_Volume has no entry for it at all.
const T_SUBST: RawDriveLetter = { letter: 'T:', volumeId: null, fsSerial: 'C8570EC9' }

test('a SUBST alias resolves to its backing volume instead of being shown as storage', () => {
  const r = resolveDriveLetters([C, D, T_SUBST])
  assert.deepEqual(independentLetters(r), ['C:', 'D:'])
  const t = r.find((x) => x.letter === 'T:')!
  assert.equal(t.aliasOf, 'C:', 'T: must be resolved to the volume that actually backs it')
  assert.equal(t.independent, false)
  assert.equal(t.identityUnverified, false, 'it is not unverified - it is verifiably C:')
})

test('the backing volume itself is unaffected by having an alias', () => {
  const r = resolveDriveLetters([C, D, T_SUBST])
  const c = r.find((x) => x.letter === 'C:')!
  assert.equal(c.independent, true)
  assert.equal(c.aliasOf, null)
  assert.equal(c.volumeId, C.volumeId)
})

test('two genuine partitions of identical size are both kept', () => {
  // Capacity and free space are never consulted, so a disk split into two equal
  // halves keeps both halves. Each has its own volume identity and serial.
  const p1: RawDriveLetter = { letter: 'E:', volumeId: '\\\\?\\Volume{aaaa}\\', fsSerial: 'AAAA1111' }
  const p2: RawDriveLetter = { letter: 'F:', volumeId: '\\\\?\\Volume{bbbb}\\', fsSerial: 'BBBB2222' }
  assert.deepEqual(independentLetters(resolveDriveLetters([p1, p2])), ['E:', 'F:'])
})

test('two genuine volumes sharing a serial are both kept rather than collapsed', () => {
  // A serial collision between two real volumes must not make one disappear.
  const a: RawDriveLetter = { letter: 'E:', volumeId: '\\\\?\\Volume{aaaa}\\', fsSerial: 'DUPSERIAL' }
  const b: RawDriveLetter = { letter: 'F:', volumeId: '\\\\?\\Volume{bbbb}\\', fsSerial: 'DUPSERIAL' }
  const r = resolveDriveLetters([a, b])
  assert.deepEqual(independentLetters(r), ['E:', 'F:'])
  assert.ok(r.every((x) => x.aliasOf === null))
})

test('an alias of an ambiguous serial is left visible rather than guessed', () => {
  // If two real volumes claim the serial, there is no single backing volume to
  // resolve to, so the aliased letter is shown and marked unverified instead of
  // being attached to an arbitrary one.
  const a: RawDriveLetter = { letter: 'E:', volumeId: '\\\\?\\Volume{aaaa}\\', fsSerial: 'DUP' }
  const b: RawDriveLetter = { letter: 'F:', volumeId: '\\\\?\\Volume{bbbb}\\', fsSerial: 'DUP' }
  const alias: RawDriveLetter = { letter: 'T:', volumeId: null, fsSerial: 'DUP' }
  const r = resolveDriveLetters([a, b, alias])
  const t = r.find((x) => x.letter === 'T:')!
  assert.equal(t.aliasOf, null)
  assert.equal(t.independent, true)
  assert.equal(t.identityUnverified, true)
})

test('a letter whose identity could not be read stays visible, marked unverified', () => {
  // getVolumeId does fail in the wild - no PowerShell, WMI down. Hiding the
  // drive would lose access to it; the rule everywhere else in the app is to
  // say it cannot be verified rather than to hide or to borrow an identity.
  const unknown: RawDriveLetter = { letter: 'X:', volumeId: null, fsSerial: 'UNIQUE99' }
  const r = resolveDriveLetters([C, unknown])
  const x = r.find((v) => v.letter === 'X:')!
  assert.equal(x.independent, true)
  assert.equal(x.identityUnverified, true)
  assert.equal(x.aliasOf, null)
  assert.deepEqual(independentLetters(r), ['C:', 'X:'])
})

test('a null or all-zero serial never makes two letters look like one filesystem', () => {
  // Some drivers report '0' for "no serial". That must not collapse unrelated
  // letters into each other.
  const noSerialVol: RawDriveLetter = { letter: 'C:', volumeId: '\\\\?\\Volume{cc}\\', fsSerial: '0' }
  const noSerialAlias: RawDriveLetter = { letter: 'T:', volumeId: null, fsSerial: '00000000' }
  const nullSerial: RawDriveLetter = { letter: 'U:', volumeId: null, fsSerial: null }
  const r = resolveDriveLetters([noSerialVol, noSerialAlias, nullSerial])
  assert.deepEqual(independentLetters(r), ['C:', 'T:', 'U:'])
  assert.ok(r.every((x) => x.aliasOf === null))
})

test('serial comparison ignores case and surrounding whitespace', () => {
  const alias: RawDriveLetter = { letter: 'T:', volumeId: null, fsSerial: ' c8570ec9 ' }
  const r = resolveDriveLetters([C, alias])
  assert.equal(r.find((x) => x.letter === 'T:')!.aliasOf, 'C:')
})

test('repeated enumeration of the same letters gives the same answer', () => {
  // The drive list is polled every 3 seconds. A resolution that drifted between
  // identical polls would make cards appear and disappear on their own.
  const input = [C, D, T_SUBST]
  const first = resolveDriveLetters(input)
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(resolveDriveLetters(input), first)
  }
  // Order of enumeration must not matter either.
  const shuffled = resolveDriveLetters([T_SUBST, D, C])
  assert.deepEqual(
    independentLetters(shuffled).sort(),
    independentLetters(first).sort()
  )
})

test('a drive disconnecting and reconnecting resolves the same way both times', () => {
  const connected = resolveDriveLetters([C, D])
  const unplugged = resolveDriveLetters([C])
  const reconnected = resolveDriveLetters([C, D])
  assert.deepEqual(independentLetters(connected), ['C:', 'D:'])
  assert.deepEqual(independentLetters(unplugged), ['C:'])
  assert.deepEqual(reconnected, connected)
})

test('a different device reusing a drive letter is a different volume, not the old one', () => {
  // D: has held two different volumes on this machine (volume_drives records
  // both). The letter carries no identity of its own, so the resolution must
  // follow volumeId and nothing else.
  const oldD: RawDriveLetter = { letter: 'D:', volumeId: '\\\\?\\Volume{c82f5a3b}\\', fsSerial: 'OLD11111' }
  const newD: RawDriveLetter = { letter: 'D:', volumeId: '\\\\?\\Volume{8b027a84}\\', fsSerial: '887E7591' }
  const before = resolveDriveLetters([C, oldD])
  const after = resolveDriveLetters([C, newD])
  assert.equal(before.find((x) => x.letter === 'D:')!.volumeId, oldD.volumeId)
  assert.equal(after.find((x) => x.letter === 'D:')!.volumeId, newD.volumeId)
  assert.notEqual(
    before.find((x) => x.letter === 'D:')!.volumeId,
    after.find((x) => x.letter === 'D:')!.volumeId
  )
  // Both are independent storage - reusing a letter does not make either an alias.
  assert.deepEqual(independentLetters(before), ['C:', 'D:'])
  assert.deepEqual(independentLetters(after), ['C:', 'D:'])
})

test('an alias pointing at a volume that is not currently listed stays visible', () => {
  // The backing drive is gone (unplugged) but the mapping lingers. There is
  // nothing to resolve to, so the letter is shown and marked unverified rather
  // than silently dropped.
  const orphanAlias: RawDriveLetter = { letter: 'T:', volumeId: null, fsSerial: '887E7591' }
  const r = resolveDriveLetters([C, orphanAlias])
  const t = r.find((x) => x.letter === 'T:')!
  assert.equal(t.aliasOf, null)
  assert.equal(t.independent, true)
  assert.equal(t.identityUnverified, true)
})

test('an empty enumeration resolves to nothing rather than inventing a drive', () => {
  // "We have not asked Windows yet" must never be fed in as "we asked and found
  // nothing". The caller filters to letters that actually have a hardware
  // answer; with none, there is nothing to resolve. Passing unanswered letters
  // in here is what briefly labelled an ordinary C: as unverifiable.
  assert.deepEqual(resolveDriveLetters([]), [])
  assert.deepEqual(independentLetters(resolveDriveLetters([])), [])
})

test('no letter is ever special-cased', () => {
  // The same shape of input gives the same answer whatever the letters are, so
  // nothing here can be a hard-coded C:/D: rule.
  const asCDT = resolveDriveLetters([
    { letter: 'C:', volumeId: 'VOL-1', fsSerial: 'S1' },
    { letter: 'D:', volumeId: 'VOL-2', fsSerial: 'S2' },
    { letter: 'T:', volumeId: null, fsSerial: 'S1' }
  ])
  const asXYZ = resolveDriveLetters([
    { letter: 'X:', volumeId: 'VOL-1', fsSerial: 'S1' },
    { letter: 'Y:', volumeId: 'VOL-2', fsSerial: 'S2' },
    { letter: 'Z:', volumeId: null, fsSerial: 'S1' }
  ])
  assert.deepEqual(
    asCDT.map((r) => [r.independent, r.aliasOf === null ? null : 'first']),
    asXYZ.map((r) => [r.independent, r.aliasOf === null ? null : 'first'])
  )
})
