import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importDropped, dropSummary, type DropImportDeps } from './dropImport.ts'

function deps(over: Partial<DropImportDeps> & { indexed?: Set<string> } = {}): DropImportDeps & { calls: string[] } {
  const calls: string[] = []
  const indexed = over.indexed ?? new Set<string>()
  return {
    calls,
    stat: async (p) => (p.includes('gone') ? null : { isDirectory: p.endsWith('\\Folder') }),
    isMedia: (p) => /\.(jpg|mp4|mpg)$/i.test(p),
    isIndexed: async (p) => indexed.has(p),
    indexFile: async (p) => {
      calls.push('file ' + p)
      indexed.add(p)
      return !p.includes('icon')
    },
    indexFolder: async (p) => {
      calls.push('folder ' + p)
      return { added: 4, seen: 6, capped: false }
    },
    yieldNow: async () => {},
    ...over
  }
}

test('a mixed drop is counted: new, already there, unsupported, missing, folders', async () => {
  const d = deps({ indexed: new Set(['C:\\a\\old.jpg']) })
  const r = await importDropped(
    ['C:\\a\\1.jpg', 'C:\\a\\2.MP4', 'C:\\a\\old.jpg', 'C:\\a\\notes.txt', 'C:\\a\\gone.jpg', 'D:\\Folder', 'C:\\a\\icon.jpg'],
    d
  )
  assert.deepEqual(
    { added: r.added, already: r.already, unsupported: r.unsupported, missing: r.missing, folders: r.folders },
    { added: 2 + 4, already: 1 + 2, unsupported: 2, missing: 1, folders: 1 }
  )
  assert.deepEqual(r.drives.sort(), ['C:', 'D:'])
  assert.equal(dropSummary(r), 'Added 6 files · 3 already in DiskFrame · 2 not supported · 1 could not be read')
})

test('the same file twice in one drop, or dropped again, is never indexed twice', async () => {
  const d = deps()
  await importDropped(['C:\\a\\1.jpg', 'c:\\A\\1.JPG', 'C:\\a\\1.jpg'], d)
  const again = await importDropped(['C:\\a\\1.jpg'], d)
  assert.deepEqual(d.calls, ['file C:\\a\\1.jpg'])
  assert.equal(again.added, 0)
  assert.equal(again.already, 1)
  assert.equal(dropSummary(again), 'Nothing new to add · 1 already in DiskFrame')
})

test('only supported media reaches the indexer, and long drops yield', async () => {
  let yields = 0
  const d = deps({ yieldNow: async () => void yields++ })
  const paths = Array.from({ length: 100 }, (_, i) => `C:\\x\\${i}.${i % 2 ? 'jpg' : 'exe'}`)
  const r = await importDropped(paths, d)
  assert.equal(r.added, 50)
  assert.equal(r.unsupported, 50)
  assert.ok(d.calls.every((c) => c.endsWith('.jpg')))
  assert.equal(yields, 4)
})
