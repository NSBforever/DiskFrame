import { parentPort, workerData } from 'worker_threads'
import Database from 'better-sqlite3'
import { LibraryReads, type ReadDb } from './libraryReads'
import type { LibraryQuery } from './libraryQuery'
import { basename } from 'path'
import { sweepOrphans, thumbNames } from './cacheBudget'

/**
 * Library reads on their own connection, off the main thread.
 *
 * The main thread is Electron's browser UI thread: while it runs a query it
 * cannot route input, serve thumbnails over media:, or pump window messages.
 * A summary is ~100-250ms and a cold ordering ~100ms on a 41k-file volume -
 * fine here, a visible stall there. WAL lets this read alongside the main
 * connection's writes; each request is one read transaction, so the version
 * and the rows it describes come from the same snapshot.
 */
const db = new Database(workerData.dbPath as string, { readonly: true, fileMustExist: true })
const reads = new LibraryReads(db as unknown as ReadDb)

type Request =
  | { id: number; kind: 'summary'; query: LibraryQuery }
  | { id: number; kind: 'page'; query: LibraryQuery; offset: number; limit: number }
  | { id: number; kind: 'clusters'; query: LibraryQuery; zoom: number }
  | { id: number; kind: 'owed'; volumeId: string; exts: string[]; maxAttempts: number; limit: number }
  | { id: number; kind: 'folders'; volumeId: string }

const run = db.transaction((m: Request) => {
  if (m.kind === 'summary') return reads.summary(m.query)
  if (m.kind === 'page') return reads.page(m.query, m.offset, m.limit)
  if (m.kind === 'owed') return reads.owedThumbnails(m.volumeId, m.exts, m.maxAttempts, m.limit)
  if (m.kind === 'folders') return reads.folders(m.volumeId)
  return reads.clusters(m.query, m.zoom)
})

type SweepRequest = { id: number; kind: 'thumbOrphans'; thumbDir: string; before: number }

/**
 * Deletes thumbnails no catalogue row can use again: neither of a row's keys,
 * nor the file its `thumb` column names. Rows are read in chunks with a yield
 * between them, so library reads queued meanwhile are answered (one pass over
 * 144k rows was a 1.9s block). Chunks are not one snapshot; the `before`
 * cut-off is what protects a thumbnail written for a row added meanwhile.
 */
async function sweepThumbOrphans(m: SweepRequest): Promise<{ removed: number; freed: number }> {
  type Row = {
    id: number
    path: string
    volume_id: string | null
    thumb: string | null
    vault_path: string | null
  }
  const chunk = db.prepare(
    'SELECT id, path, volume_id, thumb, vault_path FROM files WHERE id > ? ORDER BY id LIMIT 5000'
  )
  const live = new Set<string>()
  for (let last = 0; ; ) {
    const rows = chunk.all(last) as Row[]
    if (rows.length === 0) break
    for (const r of rows) {
      for (const n of thumbNames(r.path, r.volume_id)) live.add(n)
      if (r.vault_path) for (const n of thumbNames(r.vault_path, r.volume_id)) live.add(n)
      if (r.thumb) live.add(basename(r.thumb).toLowerCase())
    }
    last = rows[rows.length - 1].id
    await new Promise((resolve) => setImmediate(resolve))
  }
  return sweepOrphans(m.thumbDir, live, m.before)
}

parentPort?.on('message', async (m: Request | SweepRequest) => {
  const t = Date.now()
  try {
    const result = m.kind === 'thumbOrphans' ? await sweepThumbOrphans(m) : run(m)
    parentPort?.postMessage({ id: m.id, ok: true, result, ms: Date.now() - t })
  } catch (err) {
    parentPort?.postMessage({ id: m.id, ok: false, error: String(err) })
  }
})
