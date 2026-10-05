import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { runReconcile, nodeFs, type ReconcileEvent, type ReconcileInput, type KnownFile, type FsAdapter } from './reconcile.ts'

// Real files in a disposable temp tree: the move detection depends on genuine
// NTFS file ids, which a fake filesystem would only pretend to have.
function tree(files: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-reconcile-'))
  for (const f of files) {
    const p = path.join(root, f)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, Buffer.alloc(60 * 1024, f.length))
  }
  return root
}

function known(root: string, rels: string[]): KnownFile[] {
  return rels.map((r) => {
    const p = path.join(root, r)
    const s = fs.statSync(p)
    return { path: p, size: s.size, mtime: Math.round(s.mtimeMs), ino: Number(s.ino) }
  })
}

function input(root: string, files: KnownFile[], extra: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    root,
    files,
    ignorePaths: [],
    folders: {},
    full: false,
    exts: ['.jpg', '.mp4', '.pdf'],
    photoExts: ['.jpg'],
    minPhotoSize: 50 * 1024,
    skipDirs: ['node_modules', 'appdata'],
    maxNewEntries: 10000,
    ...extra
  }
}

function run(inp: ReconcileInput, fsx: FsAdapter = nodeFs(fs)) {
  const events: ReconcileEvent[] = []
  runReconcile(inp, fsx, (e) => events.push(e))
  const batches = events.filter((e) => e.type === 'batch')
  const done = events.find((e) => e.type === 'done')
  const aborted = events.find((e) => e.type === 'aborted')
  return {
    added: batches.flatMap((b) => b.added.map((a) => path.relative(inp.root, a.path))),
    moved: batches.flatMap((b) => b.moved.map((m) => `${path.relative(inp.root, m.from)} -> ${path.relative(inp.root, m.to.path)}`)),
    folders: Object.fromEntries(
      [...batches.flatMap((b) => b.folders), ...(done?.folders ?? [])].map(([p, m, c]) => [p, { mtime: m, children: c }])
    ),
    removed: (done?.removed ?? []).map((p) => path.relative(inp.root, p)).sort(),
    done,
    aborted
  }
}

test('a deleted file in a folder that still exists is removed', () => {
  const root = tree(['a\\one.jpg', 'a\\two.jpg'])
  const k = known(root, ['a\\one.jpg', 'a\\two.jpg'])
  fs.unlinkSync(path.join(root, 'a', 'two.jpg'))
  const r = run(input(root, k))
  assert.deepEqual(r.removed, ['a\\two.jpg'])
  assert.deepEqual(r.added, [])
})

test('a deleted folder removes the files under it, nested ones included', () => {
  const root = tree(['keep\\k.jpg', 'gone\\g1.jpg', 'gone\\sub\\g2.pdf'])
  const k = known(root, ['keep\\k.jpg', 'gone\\g1.jpg', 'gone\\sub\\g2.pdf'])
  fs.rmSync(path.join(root, 'gone'), { recursive: true })
  const r = run(input(root, k))
  assert.deepEqual(r.removed, ['gone\\g1.jpg', 'gone\\sub\\g2.pdf'])
  assert.deepEqual(r.done?.type === 'done' && r.done.goneFolders.map((g) => path.relative(root, g)).sort(), ['gone']) // the nested folder is covered by its parent
})

test('a renamed file is a move, not a removal plus a new file', () => {
  const root = tree(['a\\old.jpg'])
  const k = known(root, ['a\\old.jpg'])
  fs.renameSync(path.join(root, 'a', 'old.jpg'), path.join(root, 'a', 'new.jpg'))
  const r = run(input(root, k))
  assert.deepEqual(r.moved, ['a\\old.jpg -> a\\new.jpg'])
  assert.deepEqual(r.removed, [])
  assert.deepEqual(r.added, [])
})

test('a renamed folder moves every file in it', () => {
  const root = tree(['Trip\\1.jpg', 'Trip\\2.mp4', 'other\\x.jpg'])
  const k = known(root, ['Trip\\1.jpg', 'Trip\\2.mp4', 'other\\x.jpg'])
  fs.renameSync(path.join(root, 'Trip'), path.join(root, 'Trip 2025'))
  const r = run(input(root, k))
  assert.deepEqual(r.moved.sort(), ['Trip\\1.jpg -> Trip 2025\\1.jpg', 'Trip\\2.mp4 -> Trip 2025\\2.mp4'])
  assert.deepEqual(r.removed, [])
})

test('a file moved into a brand new folder elsewhere under the root is followed', () => {
  const root = tree(['a\\f.jpg', 'b\\keep.jpg'])
  const k = known(root, ['a\\f.jpg', 'b\\keep.jpg'])
  const base = run(input(root, k)).folders // the record a previous open left behind
  fs.mkdirSync(path.join(root, 'b', 'new'))
  fs.renameSync(path.join(root, 'a', 'f.jpg'), path.join(root, 'b', 'new', 'f.jpg'))
  const r = run(input(root, k, { folders: base }))
  assert.deepEqual(r.moved, ['a\\f.jpg -> b\\new\\f.jpg'])
  assert.deepEqual(r.removed, [])
})

test('new files are added, small photos and skipped folders are not', () => {
  const root = tree(['a\\k.jpg'])
  const k = known(root, ['a\\k.jpg'])
  const base = run(input(root, k)).folders
  fs.writeFileSync(path.join(root, 'a', 'new.mp4'), Buffer.alloc(1000))
  fs.writeFileSync(path.join(root, 'a', 'tiny.jpg'), Buffer.alloc(100))
  fs.mkdirSync(path.join(root, 'node_modules'))
  fs.writeFileSync(path.join(root, 'node_modules', 'x.jpg'), Buffer.alloc(60 * 1024))
  fs.mkdirSync(path.join(root, 'fresh'))
  fs.writeFileSync(path.join(root, 'fresh', 'p.jpg'), Buffer.alloc(60 * 1024))
  const r = run(input(root, k, { folders: base }))
  assert.deepEqual(r.added.sort(), ['a\\new.mp4', 'fresh\\p.jpg'])
})

test('an unchanged folder is skipped with one stat once it has been recorded', () => {
  const root = tree(['a\\k.jpg', 'b\\k.jpg'])
  const k = known(root, ['a\\k.jpg', 'b\\k.jpg'])
  const first = run(input(root, k))
  const second = run(input(root, k, { folders: first.folders }))
  assert.equal(second.done?.type === 'done' && second.done.stats.foldersListed, 0)
  assert.ok(second.done?.type === 'done' && second.done.stats.foldersSkippedUnchanged >= 2)
  // A deletion moves that folder's mtime, so only it is listed next time.
  fs.unlinkSync(path.join(root, 'b', 'k.jpg'))
  const third = run(input(root, k, { folders: first.folders }))
  assert.deepEqual(third.removed, ['b\\k.jpg'])
  assert.equal(third.done?.type === 'done' && third.done.stats.foldersListed, 1) // only b: a file deletion moves its own folder's mtime
})

test('a missing volume root is a disconnect: nothing is removed', () => {
  const root = tree(['a\\k.jpg'])
  const k = known(root, ['a\\k.jpg'])
  const real = nodeFs(fs)
  const unplugged: FsAdapter = {
    stat: () => ({ ok: false, code: 'ENOENT' }),
    list: () => ({ ok: false, code: 'ENOENT' })
  }
  const r = run(input(root, k), unplugged)
  assert.ok(r.aborted)
  assert.deepEqual(r.removed, [])
  // And a root that vanishes part-way through: still no removals reported.
  let calls = 0
  const flaky: FsAdapter = {
    stat: (p) => (++calls > 3 ? { ok: false, code: 'ENOENT' } : real.stat(p)),
    list: (p) => (calls > 3 ? { ok: false, code: 'ENOENT' } : real.list(p))
  }
  const r2 = run(input(root, k), flaky)
  assert.ok(r2.aborted)
  assert.deepEqual(r2.removed, [])
})

test('a permission error on a folder proves nothing about its files', () => {
  const root = tree(['locked\\a.jpg', 'locked\\b.jpg'])
  const k = known(root, ['locked\\a.jpg', 'locked\\b.jpg'])
  const real = nodeFs(fs)
  const denied: FsAdapter = {
    stat: real.stat,
    list: (p) => (p.toLowerCase().endsWith('locked') ? { ok: false, code: 'EPERM' } : real.list(p))
  }
  const r = run(input(root, k, { full: true }), denied)
  assert.deepEqual(r.removed, [])
  // A folder whose parent cannot be listed is not believed gone either.
  fs.rmSync(path.join(root, 'locked'), { recursive: true })
  const parentDenied: FsAdapter = {
    stat: real.stat,
    list: (p) => (p.toLowerCase() === root.toLowerCase() ? { ok: false, code: 'EACCES' } : real.list(p))
  }
  assert.deepEqual(run(input(root, k), parentDenied).removed, [])
})

test('trashed or vaulted rows still on disk are neither re-added nor removed', () => {
  const root = tree(['a\\live.jpg', 'a\\trashed.jpg'])
  const k = known(root, ['a\\live.jpg'])
  const r = run(input(root, k, { ignorePaths: [path.join(root, 'a', 'trashed.jpg')] }))
  assert.deepEqual(r.added, [])
  assert.deepEqual(r.removed, [])
})

test('folders with a pending removal are only recorded with the removal', () => {
  const root = tree(['a\\x.jpg', 'a\\y.jpg', 'b\\z.jpg'])
  const k = known(root, ['a\\x.jpg', 'a\\y.jpg', 'b\\z.jpg'])
  fs.unlinkSync(path.join(root, 'a', 'x.jpg'))
  const events: ReconcileEvent[] = []
  runReconcile(input(root, k), nodeFs(fs), (e) => events.push(e))
  const early = events.filter((e) => e.type === 'batch').flatMap((e) => (e.type === 'batch' ? e.folders.map(([p]) => path.relative(root, p)) : []))
  assert.ok(!early.includes('a'), 'a must not be marked unchanged before its removal is applied')
  const done = events.find((e) => e.type === 'done')
  assert.ok(done?.type === 'done' && done.folders.some(([p]) => path.relative(root, p) === 'a'))
})

test('the first run does not walk folders the catalogue never tracked', () => {
  // Media the scan never indexed (a build output, say) is not swept in just
  // because reconciliation started keeping records - only what appears later.
  const root = tree(['a\\k.jpg', 'project\\out\\icon.jpg'])
  const k = known(root, ['a\\k.jpg'])
  const first = run(input(root, k))
  assert.deepEqual(first.added, [])
  fs.mkdirSync(path.join(root, 'later'))
  fs.writeFileSync(path.join(root, 'later', 'new.jpg'), Buffer.alloc(60 * 1024))
  const second = run(input(root, k, { folders: first.folders }))
  assert.deepEqual(second.added, ['later\\new.jpg'])
  // An explicit full check does walk everything.
  assert.deepEqual(run(input(root, k, { full: true })).added.sort(), ['later\\new.jpg', 'project\\out\\icon.jpg'])
})
