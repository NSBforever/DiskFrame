import { parentPort, workerData } from 'worker_threads'
import Database from 'better-sqlite3'
import { LibraryReads, type ReadDb } from './libraryReads'
import type { LibraryQuery } from './libraryQuery'

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

const run = db.transaction((m: Request) => {
  if (m.kind === 'summary') return reads.summary(m.query)
  if (m.kind === 'page') return reads.page(m.query, m.offset, m.limit)
  return reads.clusters(m.query, m.zoom)
})

parentPort?.on('message', (m: Request) => {
  const t = Date.now()
  try {
    parentPort?.postMessage({ id: m.id, ok: true, result: run(m), ms: Date.now() - t })
  } catch (err) {
    parentPort?.postMessage({ id: m.id, ok: false, error: String(err) })
  }
})
