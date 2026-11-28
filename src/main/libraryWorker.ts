import { parentPort, workerData } from 'worker_threads'
import Database from 'better-sqlite3'
import { LibraryReads, type ReadDb } from './libraryReads'
import type { LibraryQuery } from './libraryQuery'
import { basename } from 'path'
import { sweepOrphans, thumbNames } from './cacheBudget'
import { eventCards } from './calendarEvents'
import type { CalDb } from './calendarStore'
import { listCollections, collectionFiles, type ColDb } from './collections'
import { runDiscovery, type DiscoveryScope } from './discovery'

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
  // With an anchor, also where that file sits in the new ordering - same snapshot.
  | { id: number; kind: 'summary'; query: LibraryQuery; anchor?: { path: string; volumeId: string | null } | null }
  | { id: number; kind: 'page'; query: LibraryQuery; offset: number; limit: number }
  | { id: number; kind: 'clusters'; query: LibraryQuery; zoom: number }
  | { id: number; kind: 'owed'; volumeId: string; exts: string[]; maxAttempts: number; limit: number }
  | { id: number; kind: 'folders'; volumeId: string }
  // The Events list: the Stage 7 matcher over the whole calendar, ~100-350 ms
  // on a 62k-file volume with ~7k events - far too long for the main thread.
  | { id: number; kind: 'events'; volumeId: string | null; bufferMin: number }
  // Every volume with visible files, for the All Drives choices.
  | { id: number; kind: 'volumes' }
  // The Events section: collections joined to their files (~100k members at most).
  | { id: number; kind: 'collections'; volumeIds: string[]; crossDrive: boolean }
  | { id: number; kind: 'collectionFiles'; collectionId: number }

const run = db.transaction((m: Request) => {
  if (m.kind === 'summary') {
    const s = reads.summary(m.query)
    return m.anchor ? { ...s, anchorIndex: reads.indexOf(m.query, m.anchor.path, m.anchor.volumeId) } : s
  }
  if (m.kind === 'page') return reads.page(m.query, m.offset, m.limit)
  if (m.kind === 'owed') return reads.owedThumbnails(m.volumeId, m.exts, m.maxAttempts, m.limit)
  if (m.kind === 'folders') return reads.folders(m.volumeId)
  if (m.kind === 'events') return eventCards(db as unknown as CalDb, m.volumeId, m.bufferMin)
  if (m.kind === 'volumes') return reads.volumes()
  if (m.kind === 'collections') return listCollections(db as unknown as ColDb, m.volumeIds, { crossDrive: m.crossDrive })
  if (m.kind === 'collectionFiles') return collectionFiles(db as unknown as ColDb, m.collectionId)
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

type CheckpointRequest = { id: number; kind: 'checkpoint' }
type DiscoverRequest = { id: number; kind: 'discover'; scopes: DiscoveryScope[]; home: { lat: number; lng: number } | null }

/**
 * The catalogue's WAL checkpoint, which the main connection no longer runs
 * (see scanner.ts). Its own connection: the read one is read-only, and a
 * checkpoint writes the database file.
 */
let checkpointDb: Database.Database | null = null
function writer(): Database.Database {
  checkpointDb ??= new Database(workerData.dbPath as string, { fileMustExist: true })
  return checkpointDb
}
function checkpoint(): unknown {
  return writer().pragma('wal_checkpoint(PASSIVE)')
}

/**
 * Places and Trips discovery: reads on the read-only connection, records
 * suggestions on the writable one - none of it on the main thread. A scope
 * whose files have not changed since its last run (same catalogue epoch, same
 * home) is skipped.
 */
const discoveredAt = new Map<string, string>()
function discover(m: DiscoverRequest): unknown {
  const epoch = reads.version()
  const todo = m.scopes.filter((s) => discoveredAt.get(s.scope) !== JSON.stringify([epoch, s.volumeIds, m.home]))
  if (!todo.length) return []
  const read = db.transaction(() =>
    runDiscovery(db as unknown as ColDb, writer() as unknown as ColDb, todo, { home: m.home }, new Date().toISOString(), (t) => -new Date(t).getTimezoneOffset())
  )
  const out = read()
  for (const s of todo) discoveredAt.set(s.scope, JSON.stringify([epoch, s.volumeIds, m.home]))
  return out
}

parentPort?.on('message', async (m: Request | SweepRequest | CheckpointRequest | DiscoverRequest) => {
  const t = Date.now()
  try {
    const result =
      m.kind === 'thumbOrphans'
        ? await sweepThumbOrphans(m)
        : m.kind === 'checkpoint'
          ? checkpoint()
          : m.kind === 'discover'
            ? discover(m)
            : run(m)
    parentPort?.postMessage({ id: m.id, ok: true, result, ms: Date.now() - t })
  } catch (err) {
    parentPort?.postMessage({ id: m.id, ok: false, error: String(err) })
  }
})
