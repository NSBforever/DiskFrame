// Regression: MPG, VOB, MTS, 3GP and other common video containers were never
// indexed (the extension list knew 7 types), and .ts/.mts must not pull in
// TypeScript sources once transport streams are supported.
// Found by /qa on 2026-11-17
// Report: .gstack/qa-reports/run-20261117-video/
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { isIndexableMedia, hasMediaExtension, looksLikeMpegTs, videoExts, allExts, thumbnailExts, SNIFFED_VIDEO_EXTS } from './validation.ts'
import { passesContentCheck, isIndexableMediaFile } from './mediaSniff.ts'
import { runReconcile, nodeFs, type ReconcileEvent, type ReconcileInput } from './reconcile.ts'
import { needsFullWalk, parseIndexFormats, withFormat, INDEX_FORMAT } from './indexFormat.ts'

const roots: string[] = []
after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true })
})
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'df-video-'))
  roots.push(d)
  return d
}

/** A transport stream head: 0x47 every `packet` bytes, after `prefix` bytes. */
function tsHead(packet: 188 | 192, packets = 4): Buffer {
  const b = Buffer.alloc(packet * packets, 0xff)
  for (let i = 0; i < packets; i++) b[i * packet + (packet === 192 ? 4 : 0)] = 0x47
  return b
}
const TYPESCRIPT = Buffer.from('export const answer: number = 42\n'.repeat(20))

const REQUESTED = ['mp4', 'm4v', 'mov', 'mpg', 'mpeg', 'avi', 'mkv', 'wmv', 'webm', 'flv', '3gp', '3g2', 'mts', 'm2ts', 'ts', 'vob', 'ogv', 'asf']

test('every requested video container is indexed, whatever the case of its extension', () => {
  for (const e of REQUESTED) {
    assert.ok(videoExts.includes('.' + e), `.${e} in videoExts`)
    assert.ok(allExts.includes('.' + e), `.${e} is scanned`)
    assert.ok(thumbnailExts.includes('.' + e), `.${e} gets a thumbnail`)
    assert.ok(hasMediaExtension(`D:\\Camera\\CLIP.${e.toUpperCase()}`), `CLIP.${e.toUpperCase()} is a known media type`)
    // By name alone: every type except .ts/.mts, which must be read first.
    const byName = !SNIFFED_VIDEO_EXTS.includes('.' + e)
    assert.equal(isIndexableMedia(`D:\\Camera\\CLIP.${e.toUpperCase()}`), byName, `CLIP.${e.toUpperCase()}`)
    assert.equal(isIndexableMedia(`D:\\Camera\\clip.${e}`), byName, `clip.${e}`)
  }
})

test('a transport stream is recognised from its sync bytes, 188- and 192-byte packets', () => {
  assert.equal(looksLikeMpegTs(tsHead(188)), true)
  assert.equal(looksLikeMpegTs(tsHead(192)), true)
  assert.equal(looksLikeMpegTs(TYPESCRIPT), false, 'TypeScript source')
  assert.equal(looksLikeMpegTs(Buffer.from([0x47])), false, 'one byte is not three packets')
  const broken = tsHead(188)
  broken[376] = 0
  assert.equal(looksLikeMpegTs(broken), false, 'packets must line up')
})

test('.ts/.mts files are indexed only when they really are video', () => {
  const d = tmp()
  const write = (name: string, data: Buffer): string => {
    const p = path.join(d, name)
    fs.writeFileSync(p, data)
    return p
  }
  assert.equal(passesContentCheck(write('broadcast.ts', tsHead(188)), '.ts'), true)
  assert.equal(passesContentCheck(write('camcorder.MTS', tsHead(192)), '.MTS'), true)
  assert.equal(passesContentCheck(write('module.ts', TYPESCRIPT), '.ts'), false)
  assert.equal(passesContentCheck(write('entry.mts', TYPESCRIPT), '.mts'), false)
  assert.equal(passesContentCheck(path.join(d, 'missing.ts'), '.ts'), false, 'unreadable: not now')
  // The watcher's and single-file paths' decision, which reads .ts/.mts.
  assert.equal(isIndexableMediaFile(path.join(d, 'broadcast.ts')), true)
  assert.equal(isIndexableMediaFile(path.join(d, 'camcorder.MTS')), true)
  assert.equal(isIndexableMediaFile(path.join(d, 'module.ts')), false)
  assert.equal(isIndexableMediaFile(path.join(d, 'entry.mts')), false)
  assert.equal(isIndexableMediaFile(path.join(d, 'holiday.MPG')), true, 'decided by name, not read')
  // Other extensions are never read.
  assert.equal(passesContentCheck(path.join(d, 'not-even-there.mpg'), '.mpg'), true)
})

function run(inp: ReconcileInput): string[] {
  const events: ReconcileEvent[] = []
  runReconcile(inp, { ...nodeFs(fs), contentCheck: passesContentCheck }, (e) => events.push(e))
  return events.flatMap((e) => (e.type === 'batch' ? e.added.map((a) => path.basename(a.path)) : [])).sort()
}
function base(root: string, extra: Partial<ReconcileInput>): ReconcileInput {
  return {
    root,
    files: [],
    ignorePaths: [],
    folders: {},
    full: false,
    exts: allExts,
    photoExts: ['.jpg'],
    minPhotoSize: 50 * 1024,
    skipDirs: ['node_modules'],
    maxNewEntries: 10000,
    ...extra
  }
}

test('sync adds new video containers and transport streams, never TypeScript', () => {
  const root = tmp()
  fs.mkdirSync(path.join(root, 'clips'))
  // The folder is known to the index through one photo already in it.
  fs.writeFileSync(path.join(root, 'clips', 'kept.jpg'), Buffer.alloc(60 * 1024))
  const k = fs.statSync(path.join(root, 'clips', 'kept.jpg'))
  const files = [{ path: path.join(root, 'clips', 'kept.jpg'), size: k.size, mtime: Math.round(k.mtimeMs), ino: Number(k.ino) }]
  fs.writeFileSync(path.join(root, 'clips', 'party.MPG'), Buffer.alloc(4000))
  fs.writeFileSync(path.join(root, 'clips', 'dvd.vob'), Buffer.alloc(4000))
  fs.writeFileSync(path.join(root, 'clips', 'cam.mts'), tsHead(192))
  fs.writeFileSync(path.join(root, 'clips', 'tool.ts'), TYPESCRIPT)
  assert.deepEqual(run(base(root, { files })), ['cam.mts', 'dvd.vob', 'party.MPG'])
})

test('a full walk finds a newly supported format in a folder the incremental sync skips', () => {
  const root = tmp()
  fs.mkdirSync(path.join(root, 'old'))
  fs.writeFileSync(path.join(root, 'old', 'kept.jpg'), Buffer.alloc(60 * 1024))
  fs.writeFileSync(path.join(root, 'old', 'party.mpg'), Buffer.alloc(4000))
  const kept = fs.statSync(path.join(root, 'old', 'kept.jpg'))
  const files = [{ path: path.join(root, 'old', 'kept.jpg'), size: kept.size, mtime: Math.round(kept.mtimeMs), ino: Number(kept.ino) }]
  // The library as a 1.1 index left it: MPG unknown, folders recorded.
  const v1Exts = allExts.filter((e) => e !== '.mpg')
  const events: ReconcileEvent[] = []
  runReconcile(base(root, { exts: v1Exts, files }), nodeFs(fs), (e) => events.push(e))
  const folders = Object.fromEntries(
    events.flatMap((e) => (e.type === 'batch' || e.type === 'done' ? e.folders : [])).map(([p, m, c]) => [p, { mtime: m, children: c }])
  ) as ReconcileInput['folders']
  // Upgraded, the incremental sync still skips the unchanged folder...
  assert.deepEqual(run(base(root, { files, folders })), [])
  // ...which is why the first open after the upgrade walks everything once.
  assert.deepEqual(run(base(root, { files, folders, full: true })), ['party.mpg'])
})

test('a volume walks fully once per index format', () => {
  assert.equal(needsFullWalk({}, 'vol-A'), true, 'never recorded = indexed by 1.1')
  const after1 = withFormat({}, 'vol-A')
  assert.equal(after1['vol-A'], INDEX_FORMAT)
  assert.equal(needsFullWalk(after1, 'vol-A'), false)
  assert.equal(needsFullWalk(after1, 'vol-B'), true, 'other volumes are separate')
  assert.deepEqual(parseIndexFormats('not json'), {})
  assert.deepEqual(parseIndexFormats('{"vol-A":2,"bad":"x"}'), { 'vol-A': 2 })
  assert.deepEqual(parseIndexFormats(null), {})
})
