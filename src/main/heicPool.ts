import { Worker } from 'worker_threads'
import { join } from 'path'

/**
 * The one way HEIC gets decoded: a bounded worker pool (see heicWorker.ts).
 *
 * Bounded because each decode is seconds of a full core, and a scroll through
 * a camera roll would otherwise start one per tile. Workers are stopped after
 * a short idle period: the wasm heap grows to fit a 24MP frame (~340MB RSS
 * measured) and never shrinks, so a long-lived worker would hold that for the
 * rest of the session. A decode that hangs is cut off by terminating its worker.
 */
/** Thumbnail decodes at once. Two, matching the thumbnail pump's two generation
 *  slots: with one worker both slots queued here and a screen of iPhone HEICs
 *  decoded strictly one at a time (1.4-4.0s each, measured). */
const THUMB_WORKERS = 2
/** One more is held back for the viewer, so the photo the user just opened
 *  never waits behind a thumbnail decode. */
const WORKERS = THUMB_WORKERS + 1
const IDLE_MS = 20_000
const JOB_TIMEOUT_MS = 60_000

interface Job {
  id: number
  input: string
  output: string
  size?: number
  quality: number
  urgent: boolean
  resolve: (ok: boolean) => void
}

interface Slot {
  worker: Worker
  job: Job | null
  timer: NodeJS.Timeout | null
}

let nextId = 1
const queue: Job[] = []
const slots: Slot[] = []
let idleTimer: NodeJS.Timeout | null = null

function settle(slot: Slot, ok: boolean): void {
  const job = slot.job
  slot.job = null
  if (slot.timer) clearTimeout(slot.timer)
  slot.timer = null
  job?.resolve(ok)
  pump()
}

function spawn(): Slot {
  const slot: Slot = { worker: new Worker(join(__dirname, 'heicWorker.js')), job: null, timer: null }
  slot.worker.on('message', (m: { id: number; ok: boolean; error?: string }) => {
    if (slot.job && m.id === slot.job.id) {
      if (!m.ok) console.warn('[heic]', slot.job.input, m.error)
      settle(slot, m.ok)
    }
  })
  const drop = (): void => {
    const i = slots.indexOf(slot)
    if (i !== -1) slots.splice(i, 1)
    if (slot.job) settle(slot, false)
  }
  slot.worker.on('error', (err) => {
    console.error('[heic] worker error', err)
    drop()
  })
  slot.worker.on('exit', drop)
  slots.push(slot)
  return slot
}

function pump(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  while (queue.length > 0) {
    // Urgent jobs sit at the front of the queue, so only the head can be one.
    if (!queue[0].urgent && slots.filter((s) => s.job).length >= THUMB_WORKERS) break
    const slot = slots.find((s) => !s.job) ?? (slots.length < WORKERS ? spawn() : null)
    if (!slot) break
    const job = queue.shift()!
    slot.job = job
    slot.timer = setTimeout(() => {
      console.warn('[heic] decode timed out, stopping worker:', job.input)
      void slot.worker.terminate()
    }, JOB_TIMEOUT_MS)
    slot.worker.postMessage({ id: job.id, input: job.input, output: job.output, size: job.size, quality: job.quality })
  }
  if (slots.every((s) => !s.job)) {
    idleTimer = setTimeout(() => {
      for (const s of slots.splice(0)) if (!s.job) void s.worker.terminate()
    }, IDLE_MS)
  }
}

/**
 * Converts a HEIC file to a JPEG at `output`. `size` gives a square cover-crop
 * thumbnail; omitted, the full image. `urgent` work (the viewer, which the user
 * is waiting on) goes ahead of queued thumbnails. Resolves false on any failure.
 */
export function heicToJpeg(
  input: string,
  output: string,
  opts: { size?: number; quality: number; urgent?: boolean }
): Promise<boolean> {
  return new Promise((resolve) => {
    const job: Job = { id: nextId++, input, output, size: opts.size, quality: opts.quality, urgent: opts.urgent === true, resolve }
    if (opts.urgent) queue.unshift(job)
    else queue.push(job)
    pump()
  })
}

export function stopHeicWorkers(): void {
  for (const j of queue.splice(0)) j.resolve(false)
  for (const s of slots.splice(0)) void s.worker.terminate()
}
