import { Worker } from 'worker_threads'
import { join } from 'path'
import { homedir } from 'os'
import * as fs from 'fs'
import {
  applyReconcileBatch,
  applyReconcileRemovals,
  getCachedVolumeId,
  catalogueDbPath,
  getVolumeId
} from './scanner'
import { invalidateMountedVolumes } from './driveEnum'
import { allExts, photoExts, MIN_PHOTO_SIZE, SKIP_DIRS, isMassRemoval } from './validation'
import type { ReconcileEvent, ReconcileDone } from './reconcile'

/** The folder a drive's catalogue is scoped to - the same one the scan walks. */
export function catalogueRoot(drive: string): string {
  return drive === 'C:' ? homedir() : `${drive}\\`
}

export interface SyncHooks {
  /** Rows changed for this drive; the renderer should re-read it. */
  onChanged(drive: string): void
  /** A run finished (or gave up). `reason` is what asked for it. */
  onFinished(drive: string, reason: string, outcome: { ok: boolean; removed: number; message: string }): void
  log(message: string): void
}

interface Running {
  worker: Worker
  volumeId: string
  reason: string
  startedAt: number
  lastMessageAt: number
  watchdog: NodeJS.Timeout
  totals: { added: number; moved: number; changed: number }
  /** Records the worker is judging, from its first message. */
  knownCount: number
  finishing?: boolean
}

/** A worker that has said nothing for this long is treated as stuck on a
 *  device that stopped answering, and stopped. Nothing it found is removed. */
const STALL_MS = 120_000
/** Reconciliation requests closer together than this are folded into one. */
const MIN_GAP_MS = 2_000

/**
 * Background reconciliation for the open drive.
 *
 * One run per drive at a time; a request while one is running is remembered
 * and run once it finishes. Cancelling terminates the worker. Every batch is
 * applied only while the letter still resolves to the volume the run started
 * against, and removals - which only a finished run reports - additionally
 * need a fresh mountvol read to agree, the volume root to be present, and the
 * count to be believable for the size of the catalogue.
 */
export class SyncService {
  private running = new Map<string, Running>()
  private pending = new Map<string, { full: boolean; reason: string }>()
  private timers = new Map<string, NodeJS.Timeout>()
  private lastRunAt = new Map<string, number>()

  constructor(private hooks: SyncHooks) {}

  isRunning(drive: string): boolean {
    return this.running.has(drive)
  }

  request(drive: string, opts: { reason: string; full?: boolean; delayMs?: number; minGapMs?: number }): void {
    const prev = this.pending.get(drive)
    this.pending.set(drive, { full: !!opts.full || !!prev?.full, reason: prev && !opts.full ? prev.reason : opts.reason })
    if (this.running.has(drive)) return // picked up when the current run ends
    const sinceLast = Date.now() - (this.lastRunAt.get(drive) ?? 0)
    const delay = Math.max(opts.delayMs ?? 0, opts.full ? 0 : (opts.minGapMs ?? MIN_GAP_MS) - sinceLast)
    const existing = this.timers.get(drive)
    if (existing) clearTimeout(existing)
    this.timers.set(
      drive,
      setTimeout(() => {
        this.timers.delete(drive)
        void this.start(drive)
      }, Math.max(0, delay))
    )
  }

  cancel(drive?: string): void {
    for (const [d, t] of this.timers) {
      if (drive && d !== drive) continue
      clearTimeout(t)
      this.timers.delete(d)
      this.pending.delete(d)
    }
    for (const [d, r] of this.running) {
      if (drive && d !== drive) continue
      this.pending.delete(d)
      this.stop(d, r, 'cancelled')
    }
  }

  private stop(drive: string, r: Running, why: string): void {
    clearInterval(r.watchdog)
    this.running.delete(drive)
    void r.worker.terminate()
    this.hooks.log(`${drive}: reconcile stopped (${why}) - nothing removed`)
    this.hooks.onFinished(drive, r.reason, { ok: false, removed: 0, message: why })
  }

  private async start(drive: string): Promise<void> {
    const req = this.pending.get(drive)
    if (!req || this.running.has(drive)) return
    this.pending.delete(drive)
    this.lastRunAt.set(drive, Date.now())
    const volumeId = await getVolumeId(drive)
    const root = catalogueRoot(drive)
    if (!volumeId || !fs.existsSync(root)) {
      this.hooks.log(`${drive}: reconcile skipped - ${volumeId ? 'root not present' : 'volume identity not verified'}`)
      this.hooks.onFinished(drive, req.reason, { ok: false, removed: 0, message: 'drive not verified' })
      return
    }
    // The worker reads the catalogue itself (see reconcileWorker.ts) and says
    // how many records it is judging in its first message.
    const worker = new Worker(join(__dirname, 'reconcileWorker.js'), {
      workerData: {
        dbPath: catalogueDbPath,
        volumeId,
        root,
        full: req.full,
        exts: allExts,
        photoExts,
        minPhotoSize: MIN_PHOTO_SIZE,
        skipDirs: SKIP_DIRS,
        maxNewEntries: 200_000
      }
    })
    const r: Running = {
      worker,
      volumeId,
      reason: req.reason,
      startedAt: Date.now(),
      lastMessageAt: Date.now(),
      watchdog: setInterval(() => {
        if (Date.now() - r.lastMessageAt > STALL_MS) this.stop(drive, r, 'device stopped answering')
      }, 10_000),
      totals: { added: 0, moved: 0, changed: 0 },
      knownCount: 0
    }
    this.running.set(drive, r)

    worker.on('message', (e: ReconcileEvent | { type: 'started'; files: number; folders: number }) => {
      if (this.running.get(drive) !== r) return
      r.lastMessageAt = Date.now()
      if (e.type === 'started') {
        r.knownCount = e.files
        this.hooks.log(`${drive}: reconcile started (${req.reason}${req.full ? ', full' : ''}) - ${e.files} records, ${e.folders} folders on record`)
      } else if (e.type === 'batch') {
        // The letter must still be this volume. A drive swapped at the same
        // letter mid-run stops the run before any of its results land.
        if (getCachedVolumeId(drive) !== volumeId) return this.stop(drive, r, 'volume at this letter changed')
        const res = applyReconcileBatch(volumeId, drive, e)
        r.totals.added += res.added
        r.totals.moved += res.moved
        r.totals.changed += res.changed
        if (res.added || res.moved || res.changed) this.hooks.onChanged(drive)
      } else if (e.type === 'aborted') {
        this.stop(drive, r, e.reason)
      } else {
        // Claimed synchronously: finish() awaits a fresh identity read, and the
        // worker's 'exit' arrives during that await - without this it took the
        // run for a crash and threw away a completed result.
        r.finishing = true
        void this.finish(drive, r, e, r.knownCount)
      }
    })
    worker.on('error', (err) => {
      if (this.running.get(drive) === r) this.stop(drive, r, `worker error: ${err.message}`)
    })
    worker.on('exit', () => {
      if (this.running.get(drive) === r && !r.finishing) this.stop(drive, r, 'worker exited early')
      if (this.pending.has(drive)) this.request(drive, { ...this.pending.get(drive)!, delayMs: 0 })
    })
  }

  private async finish(drive: string, r: Running, done: ReconcileDone, knownCount: number): Promise<void> {
    clearInterval(r.watchdog)
    // Fresh, not cached: removals are the one thing that cannot be undone.
    invalidateMountedVolumes()
    const now = await getVolumeId(drive)
    let removed = 0
    let note = ''
    if (now !== r.volumeId || !fs.existsSync(catalogueRoot(drive))) {
      note = ` - ${done.removed.length} removals NOT applied: the volume is no longer the one checked`
    } else if (isMassRemoval(done.removed.length, knownCount)) {
      note = ` - ${done.removed.length} of ${knownCount} removals NOT applied: too many to believe without an explicit rescan`
    } else {
      removed = applyReconcileRemovals(r.volumeId, done.removed, done.folders, done.goneFolders)
    }
    this.running.delete(drive)
    void r.worker.terminate()
    const s = done.stats
    this.hooks.log(
      `${drive}: reconcile done in ${Date.now() - r.startedAt}ms - +${r.totals.added} added, ${r.totals.moved} moved, ` +
        `${r.totals.changed} changed, -${removed} removed; folders ${s.foldersChecked} checked, ${s.foldersListed} listed, ` +
        `${s.foldersSkippedUnchanged} unchanged, ${s.unreadable} unreadable, ${s.newEntriesVisited} new entries${note}`
    )
    if (removed > 0) this.hooks.onChanged(drive)
    this.hooks.onFinished(drive, r.reason, { ok: !note, removed, message: note.trim() })
    if (this.pending.has(drive)) this.request(drive, { ...this.pending.get(drive)!, delayMs: 0 })
  }
}
