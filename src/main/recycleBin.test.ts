import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseDriveTypes, recycleRefusal, recycle } from './recycleBin.ts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-recycle-'))
after(() => fs.rmSync(dir, { recursive: true, force: true }))

/** A real file on the temp drive, plus that drive's letter. */
function file(name: string): { p: string; letter: string } {
  const p = path.join(dir, name)
  fs.writeFileSync(p, 'x')
  return { p, letter: p.slice(0, 2).toUpperCase() }
}

test('parses DriveInfo output, CRLF and noise included', () => {
  const t = parseDriveTypes('C:\\|Fixed\r\nE:\\|Fixed\r\nG:\\|Removable\r\nZ:\\|Network\r\n\r\nWARNING: junk\r\n')
  assert.deepEqual([...t], [['C:', 'Fixed'], ['E:', 'Fixed'], ['G:', 'Removable'], ['Z:', 'Network']])
})

test('only a fixed local disk is handed to trash', () => {
  const t = parseDriveTypes('C:\\|Fixed\nG:\\|Removable\nZ:\\|Network\nD:\\|CDRom')
  assert.equal(recycleRefusal('C:\\Users\\a.jpg', t), null)
  assert.equal(recycleRefusal('c:\\Users\\a.jpg', t), null)
  assert.match(recycleRefusal('G:\\DCIM\\IMG_0001.JPG', t)!, /G: is a Removable drive/)
  assert.match(recycleRefusal('Z:\\share\\v.mp4', t)!, /Network/)
  assert.match(recycleRefusal('D:\\v.mp4', t)!, /CDRom/)
})

test('anything unverifiable is refused, never guessed', () => {
  const t = parseDriveTypes('C:\\|Fixed')
  // Letter not in the listing, PowerShell failed outright, and a UNC share.
  assert.match(recycleRefusal('H:\\a.jpg', t)!, /could not read the drive type of H:/)
  assert.match(recycleRefusal('C:\\a.jpg', null)!, /could not read/)
  assert.match(recycleRefusal('\\\\nas\\photos\\a.jpg', t)!, /no Recycle Bin/)
})

test('a drive with no Recycle Bin: trash is never called and the file stays', async () => {
  const { p, letter } = file('removable.jpg')
  let called = false
  await assert.rejects(
    recycle(p, new Map([[letter, 'Removable']]), async () => { called = true }),
    /not sent to the Recycle Bin/
  )
  assert.equal(called, false)
  assert.ok(fs.existsSync(p))
})

test('trash failing does not fall back to a permanent delete', async () => {
  // The old safeDelete caught this and unlinked the file.
  const { p, letter } = file('busy.jpg')
  await assert.rejects(
    recycle(p, new Map([[letter, 'Fixed']]), async () => { throw new Error('recycle-bin exited 1') }),
    /recycle-bin exited 1/
  )
  assert.ok(fs.existsSync(p))
})

test('a fixed drive goes to trash once; a missing file is a no-op', async () => {
  const { p, letter } = file('ok.jpg')
  const sent: string[] = []
  const types = new Map([[letter, 'Fixed']])
  await recycle(p, types, async (q) => { sent.push(q) })
  await recycle(path.join(dir, 'gone.jpg'), types, async (q) => { sent.push(q) })
  assert.deepEqual(sent, [p])
})
