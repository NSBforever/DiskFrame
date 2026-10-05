import { Worker } from 'worker_threads'
import { join } from 'path'

/**
 * Sends library reads to libraryWorker.ts. Any failure - the worker not
 * starting, crashing, or rejecting a request - answers that request from
 * `fallback` (the same reads on the main thread) instead: a page that never
 * arrives leaves tiles as skeletons for good, because the grid only asks again
 * when its visible range changes. A worker that errors is not restarted for the
 * rest of the session.
 */
let worker: Worker | null = null
let broken = false
let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function ensureWorker(dbPath: string): Worker | null {
  if (worker || broken) return worker
  try {
    const w = new Worker(join(__dirname, 'libraryWorker.js'), { workerData: { dbPath } })
    w.on('message', (m: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      if (m.ok) p.resolve(m.result)
      else p.reject(new Error(m.error))
    })
    const failAll = (why: string): void => {
      if (worker === w) worker = null
      for (const p of pending.values()) p.reject(new Error(why))
      pending.clear()
    }
    w.on('error', (err) => {
      console.error('[library-worker] error, using the main thread from now on:', err)
      broken = true
      failAll(String(err))
    })
    w.on('exit', (code) => failAll(`exited (${code})`))
    worker = w
  } catch (err) {
    console.error('[library-worker] could not start, using the main thread:', err)
    broken = true
  }
  return worker
}

export async function readLibrary<T>(dbPath: string, request: Record<string, unknown>, fallback: () => T): Promise<T> {
  const w = ensureWorker(dbPath)
  if (!w) return fallback()
  const id = nextId++
  try {
    return await new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      w.postMessage({ ...request, id })
    })
  } catch (err) {
    console.warn('[library-worker] request failed, answering on the main thread:', String(err))
    return fallback()
  }
}

export function stopLibraryWorker(): void {
  const w = worker
  worker = null
  broken = true
  void w?.terminate()
}
