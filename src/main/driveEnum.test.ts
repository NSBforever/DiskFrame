import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMountvol, serialFromDev } from './driveEnum.ts'

// Captured from this machine (Windows 11, en-GB), trimmed.
const SAMPLE = [
  'Creates, deletes, or lists a volume mount point.',
  '',
  'MOUNTVOL [drive:]path VolumeName',
  '',
  'Possible values for VolumeName along with current mount points are:',
  '',
  '    \\\\?\\Volume{fd2dcab2-4c85-44b7-bb48-efefa6550fdb}\\',
  '        C:\\',
  '',
  '    \\\\?\\Volume{3eec4ee4-5f65-4b33-a90d-f5e96a0ff2e3}\\',
  '        *** NO MOUNT POINTS ***',
  '',
  '    \\\\?\\Volume{8b027a84-8a98-4d30-9576-af50adcdfa93}\\',
  '        d:\\',
  '        D:\\Mounted\\Elsewhere\\',
  ''
].join('\r\n')

test('mountvol: each letter maps to the volume GUID path the catalogue stores', () => {
  const m = parseMountvol(SAMPLE)
  assert.equal(m.get('C:'), '\\\\?\\Volume{fd2dcab2-4c85-44b7-bb48-efefa6550fdb}\\')
  // Letters are normalised; folder mount points are not drive letters.
  assert.equal(m.get('D:'), '\\\\?\\Volume{8b027a84-8a98-4d30-9576-af50adcdfa93}\\')
  assert.equal(m.size, 2)
})

test('mountvol: a volume with no mount point produces no letter', () => {
  const m = parseMountvol(SAMPLE)
  assert.ok(![...m.values()].includes('\\\\?\\Volume{3eec4ee4-5f65-4b33-a90d-f5e96a0ff2e3}\\'))
})

test('mountvol: garbage or empty output is an empty map, not a throw', () => {
  assert.equal(parseMountvol('').size, 0)
  assert.equal(parseMountvol('C:\\\n').size, 0) // a path with no volume line before it
})

test('serialFromDev matches Win32_LogicalDisk.VolumeSerialNumber formatting', () => {
  // C: on this machine: stat.dev 0xC8570EC9, LogicalDisk reported "C8570EC9".
  assert.equal(serialFromDev(0xc8570ec9), 'C8570EC9')
  assert.equal(serialFromDev(0x1a2b), '00001A2B')
  assert.equal(serialFromDev(0n + 0xc8570ec9n), 'C8570EC9')
  assert.equal(serialFromDev(0), null)
})
