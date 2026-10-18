import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pruneToBudget, sweepOrphans, freeBytes, thumbNames } from './cacheBudget.ts'

const roots: string[] = []
after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true })
})

const hex = (i: number): string => i.toString(16).padStart(32, '0')

/** A cache folder of `n` 1KB files named like the app's own, oldest first. */
function cache(n: number, ext = 'jpg'): { dir: string; names: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-cache-'))
  roots.push(dir)
  const names: string[] = []
  for (let i = 0; i < n; i++) {
    const name = `${hex(i)}.${ext}`
    const p = path.join(dir, name)
    fs.writeFileSync(p, Buffer.alloc(1000))
    const t = new Date(Date.now() - (n - i) * 60_000)
    fs.utimesSync(p, t, t)
    names.push(name)
  }
  return { dir, names }
}

const bytesIn = (dir: string): number =>
  fs.readdirSync(dir).reduce((n, f) => n + fs.lstatSync(path.join(dir, f)).size, 0)

test('a cache over budget is cut to the budget, oldest files first', () => {
  const { dir, names } = cache(10)
  const r = pruneToBudget(dir, 4000)
  assert.equal(r.removed, 6)
  assert.ok(bytesIn(dir) <= 4000)
  assert.deepEqual(fs.readdirSync(dir).sort(), names.slice(6))
})

test('pruning again changes nothing - repeated runs never multiply or churn', () => {
  const { dir } = cache(5)
  pruneToBudget(dir, 3000)
  const before = fs.readdirSync(dir).sort()
  assert.deepEqual(pruneToBudget(dir, 3000), { removed: 0, freed: 0 })
  assert.deepEqual(fs.readdirSync(dir).sort(), before)
})

test('the file just written is kept even when it is the oldest', () => {
  const { dir, names } = cache(3)
  const keep = path.join(dir, names[0])
  pruneToBudget(dir, 0, keep)
  assert.deepEqual(fs.readdirSync(dir), [names[0]])
})

test('only names the app writes are ever deleted - user files and folders are not', () => {
  const { dir } = cache(2)
  fs.writeFileSync(path.join(dir, 'IMG_0001.JPG'), Buffer.alloc(5000))
  fs.writeFileSync(path.join(dir, 'notes.txt'), Buffer.alloc(5000))
  fs.mkdirSync(path.join(dir, hex(99) + '.jpg')) // a folder wearing a cache name
  pruneToBudget(dir, 0)
  assert.deepEqual(fs.readdirSync(dir).sort(), [hex(99) + '.jpg', 'IMG_0001.JPG', 'notes.txt'])
})

test('a junction inside a cache folder is neither deleted nor followed', () => {
  const { dir } = cache(1)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'df-cache-outside-'))
  roots.push(outside)
  const victim = path.join(outside, hex(7) + '.jpg')
  fs.writeFileSync(victim, Buffer.alloc(1000))
  const link = path.join(dir, hex(8) + '.jpg')
  fs.symlinkSync(outside, link, 'junction')
  pruneToBudget(dir, 0)
  assert.ok(fs.existsSync(victim))
  assert.ok(fs.lstatSync(link).isSymbolicLink())
  fs.unlinkSync(link) // the link only, before the temp folders are removed
})

test('the orphan sweep removes only unreferenced files older than the cut-off', async () => {
  const { dir, names } = cache(4)
  const fresh = path.join(dir, hex(50) + '.jpg')
  fs.writeFileSync(fresh, Buffer.alloc(1000)) // written "after" the catalogue was read
  const live = new Set([names[1], names[3]])
  const r = await sweepOrphans(dir, live, Date.now() - 1000)
  assert.equal(r.removed, 2)
  assert.deepEqual(fs.readdirSync(dir).sort(), [names[1], names[3], hex(50) + '.jpg'].sort())
})

test('free space is reported, and an unreadable volume never blocks', () => {
  const free = freeBytes(os.tmpdir())
  assert.ok(Number.isFinite(free) && free > 0)
  assert.equal(freeBytes(path.join(os.tmpdir(), 'df-no-such-dir', 'x')), Infinity)
})

test('a file has one thumbnail name without a volume and two with one', () => {
  assert.equal(thumbNames('C:\\a.jpg').length, 1)
  assert.equal(thumbNames('C:\\a.jpg', 'vol')[0], thumbNames('C:\\a.jpg')[0])
  assert.notEqual(thumbNames('C:\\a.jpg', 'vol')[1], thumbNames('C:\\a.jpg', 'other')[1])
})
