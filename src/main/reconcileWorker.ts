import { parentPort, workerData } from 'worker_threads'
import * as fs from 'fs'
import { runReconcile, nodeFs, type ReconcileInput } from './reconcile'
import { isGeneratedAsset, isWatchIgnoredPath } from './validation'

/**
 * Runs reconcile.ts off the main thread. Paced: every few folders it sleeps
 * briefly, so a reconciliation of a large external disk shares the spindle
 * with browsing instead of saturating it. Terminating the worker is the
 * cancel; nothing it found is applied until the main process gets its events.
 */
const input = workerData as ReconcileInput
const sleeper = new Int32Array(new SharedArrayBuffer(4))
let sincePause = 0
let busySince = Date.now()
const real = nodeFs(fs)
runReconcile(
  // Nothing is added from where the scan and the watcher never look (AppData,
  // dot-folders, Program Files...) - a known file there can still be found
  // gone and removed, but Temp and cache churn never becomes gallery content.
  { ...input, isExcluded: (p: string) => isGeneratedAsset(p) || isWatchIgnoredPath(p) },
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
