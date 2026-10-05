import { parentPort, workerData } from 'worker_threads'
import * as fs from 'fs'
import Database from 'better-sqlite3'
import { runReconcile, nodeFs, type ReconcileInput } from './reconcile'
import { isGeneratedAsset, isWatchIgnoredPath } from './validation'

/**
 * Runs reconcile.ts off the main thread. Paced: every few folders it sleeps
 * briefly, so a reconciliation of a large external disk shares the spindle
 * with browsing instead of saturating it. Terminating the worker is the
 * cancel; nothing it found is applied until the main process gets its events.
 *
 * It reads what the catalogue knows about the volume itself, on its own
 * read-only connection. The main process used to read every row (41k here)
 * and hand them over as workerData, which is a synchronous query plus a
 * structured clone on the main thread - measured at 350-380ms per run, on
 * every open, every periodic run and every watcher-triggered one.
 */
const { dbPath, volumeId, ...options } = workerData as Omit<ReconcileInput, 'files' | 'ignorePaths' | 'folders'> & {
  dbPath: string
  volumeId: string
}

function readCatalogue(): Pick<ReconcileInput, 'files' | 'ignorePaths' | 'folders'> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    return db.transaction(() => {
      const files = db
        .prepare('SELECT path, size, mtime, ino FROM files WHERE volume_id = ? AND hidden = 0 AND trashed_at IS NULL')
        .all(volumeId) as ReconcileInput['files']
      const ignorePaths = (
        db.prepare('SELECT path FROM files WHERE volume_id = ? AND (hidden = 1 OR trashed_at IS NOT NULL)').all(volumeId) as {
          path: string
        }[]
      ).map((r) => r.path)
      const folders: ReconcileInput['folders'] = {}
      for (const r of db.prepare('SELECT path, mtime, children FROM folder_snapshot WHERE volume_id = ?').all(volumeId) as {
        path: string
        mtime: number
        children: string | null
      }[]) {
        let children: string[] | null = null
        try {
          children = r.children ? (JSON.parse(r.children) as string[]) : null
        } catch {
          children = null // re-listed next run
        }
        folders[r.path] = { mtime: r.mtime, children }
      }
      return { files, ignorePaths, folders }
    })()
  } finally {
    db.close()
  }
}

const catalogue = readCatalogue()
parentPort?.postMessage({ type: 'started', files: catalogue.files.length, folders: Object.keys(catalogue.folders).length })

const sleeper = new Int32Array(new SharedArrayBuffer(4))
let sincePause = 0
let busySince = Date.now()
const real = nodeFs(fs)
runReconcile(
  // Nothing is added from where the scan and the watcher never look (AppData,
  // dot-folders, Program Files...) - a known file there can still be found
  // gone and removed, but Temp and cache churn never becomes gallery content.
  { ...options, ...catalogue, isExcluded: (p: string) => isGeneratedAsset(p) || isWatchIgnoredPath(p) },
  {
    ...real,
    pace() {
      // ~80% duty cycle at most: after 40ms of work, step aside for 10ms.
      if (++sincePause < 10 && Date.now() - busySince < 40) return
      sincePause = 0
      Atomics.wait(sleeper, 0, 0, 10)
      busySince = Date.now()
    }
  },
  (e) => parentPort?.postMessage(e)
)
