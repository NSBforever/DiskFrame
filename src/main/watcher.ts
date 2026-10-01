import * as fs from 'fs'
import { join, isAbsolute } from 'path'
import { BrowserWindow } from 'electron'
import {
  updateFileInPlace,
  removeFileRecord,
  getFileIno,
  relinkMovedFile,
  getCachedVolumeId
} from './scanner'
import { isIndexableUserMedia, isWatchIgnoredPath } from './validation'

// How long a removed file's inode is remembered as a "possible move" before
// being treated as a genuine delete. Windows reports a move/rename as a plain
// unlink+add pair, so this is the correlation window used to recognize them as
// the same file.
const MOVE_CORRELATION_WINDOW_MS = 2000

// Quiet period before a batch of file events turns into one renderer broadcast.
const NOTIFY_COALESCE_MS = 1500

/**
 * Quiet period per path before an add/change is acted on.
 *
 * chokidar supplied this as `awaitWriteFinish`. The OS reports every write to a
 * file as its own notification, so copying a 2 GB video in produces hundreds of
 * them - and each one would otherwise mean a statSync, a database write and
 * possibly a thumbnail spawn, on the main process. Waiting for the writes to
 * stop collapses those into one, and incidentally means the file is finished
 * before its size and thumbnail are recorded.
 */
const WRITE_SETTLE_MS = 400

/** Ceiling on paths being debounced at once, so a pathological burst of
 *  notifications cannot grow this map without bound. Past it, further paths are
 *  dropped - reconciliation, not this watcher, is what guarantees completeness. */
const MAX_SETTLING = 5000

interface PendingRemoval {
  path: string
  driveKey: string
  expiresAt: number
}

export class WatcherManager {
  private watchers: Map<string, fs.FSWatcher> = new Map()
  private pendingUnlinks: Map<string, NodeJS.Timeout> = new Map()
  private recentRemovalsByIno: Map<number, PendingRemoval> = new Map()
  private settling: Map<string, NodeJS.Timeout> = new Map()
  private mainWindow: BrowserWindow | null = null

  constructor(mainWindow: BrowserWindow | null = null) {
    this.mainWindow = mainWindow
  }

  public setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  /**
   * Watches one drive for live changes, using the OS's own recursive directory
   * notifications.
   *
   * This used to be a recursive chokidar watch. chokidar has no way to attach
   * without first walking the tree: it readdir+stat's every directory under the
   * root to build its own state (ignoreInitial only suppresses the *events*,
   * not the walk), and it does that in the main process. On a cold 2 TB
   * external HDD that walk is minutes of filesystem I/O on the main process -
   * started, by runScan(), at the same moment the scan utility is already
   * saturating the same spindle. That is the confirmed cause of
   * "DiskFrame (Not Responding)" on a first-time drive: nothing was wrong with
   * the scan, the window simply had no event loop left to answer with.
   *
   * fs.watch with `recursive` maps to ReadDirectoryChangesW on Windows: the
   * kernel reports changes under the root with no traversal and one handle, so
   * attaching is O(1) whatever the size of the volume. Dropped events (the
   * kernel buffer can overflow during a bulk copy) are not a correctness
   * problem here - explicit "Check for changes" and the periodic
   * IndexingService are the reconcilers, as they already were.
   */
  public watchDrive(drivePath: string): void {
    const driveKey = drivePath.slice(0, 2).toUpperCase()
    if (this.watchers.has(driveKey)) return

    // Only the drive currently being browsed is watched.
    for (const [key, watcher] of this.watchers.entries()) {
      if (key === driveKey) continue
      console.log(`[WatcherManager] Releasing watcher for inactive drive: ${key}`)
      watcher.close()
      this.watchers.delete(key)
      const timer = this.notifyTimers.get(key)
      if (timer) {
        clearTimeout(timer)
        this.notifyTimers.delete(key)
      }
    }

    console.log(`[WatcherManager] Watching ${drivePath} (native recursive)`)

    let watcher: fs.FSWatcher
    try {
      watcher = fs.watch(drivePath, { recursive: true, persistent: true })
    } catch (err) {
      // A volume that disappears between the scan starting and the watch
      // attaching, or a filesystem with no change notifications. Browsing the
      // cached index does not depend on this, so it is not fatal.
      console.warn(`[WatcherManager] Could not watch ${drivePath}:`, err)
      return
    }

    watcher.on('change', (_eventType, filename) => {
      if (!filename) return
      const rel = typeof filename === 'string' ? filename : filename.toString()
      const fullPath = isAbsolute(rel) ? rel : join(drivePath, rel)
      // Cheap reject before any stat or database work. Most notification
      // traffic on a real machine is not media, and this is also what keeps
      // the app's own thumbnail/cache churn out of the index.
      if (isWatchIgnoredPath(rel) || !isIndexableUserMedia(fullPath)) return
      this.settle(fullPath, driveKey)
    })

    watcher.on('error', (err) => {
      console.warn(`[WatcherManager] Watch error on ${driveKey}:`, err)
      try {
        watcher.close()
      } catch {
        /* already gone */
      }
      // Deliberately not re-attached in a loop: a drive that was unplugged
      // would spin here forever. Re-opening the drive re-attaches.
      this.watchers.delete(driveKey)
    })

    this.watchers.set(driveKey, watcher)
  }

  /**
   * Holds a path until its notifications stop arriving, then decides what
   * happened once. "rename" from the OS covers create, delete and rename
   * alike, so the decision is simply whether the path exists when the dust
   * settles - which is also the only point at which a file's final size is
   * worth recording.
   */
  private settle(fullPath: string, driveKey: string): void {
    const existing = this.settling.get(fullPath)
    if (existing) {
      clearTimeout(existing)
    } else if (this.settling.size >= MAX_SETTLING) {
      return
    }
    this.settling.set(
      fullPath,
      setTimeout(() => {
        this.settling.delete(fullPath)
        if (fs.existsSync(fullPath)) {
          void this.handleAddOrChange(fullPath, driveKey)
        } else {
          this.handleUnlink(fullPath, driveKey)
        }
      }, WRITE_SETTLE_MS)
    )
  }

  private handleUnlink(filePath: string, driveKey: string): void {
    if (this.pendingUnlinks.has(filePath)) {
      clearTimeout(this.pendingUnlinks.get(filePath)!)
    }

    // Remember this file's last-known inode so a matching add elsewhere
    // (same volume) within the correlation window can be recognized as a
    // move/rename instead of a delete + new file.
    const ino = getFileIno(filePath)
    if (ino) {
      this.recentRemovalsByIno.set(ino, {
        path: filePath,
        driveKey,
        expiresAt: Date.now() + MOVE_CORRELATION_WINDOW_MS
      })
    }

    const timer = setTimeout(() => {
      this.pendingUnlinks.delete(filePath)
      if (ino) this.recentRemovalsByIno.delete(ino)

      if (!fs.existsSync(filePath)) {
        removeFileRecord(filePath, getCachedVolumeId(driveKey))
        this.notifyFilesUpdated(driveKey)
      } else {
        // Atomic replace: the file came back during the debounce.
        updateFileInPlace(filePath).then(() => this.notifyFilesUpdated(driveKey))
      }
    }, 250)

    this.pendingUnlinks.set(filePath, timer)
  }

  private async handleAddOrChange(filePath: string, driveKey: string): Promise<void> {
    // If a pending unlink existed for this path, cancel it (coalesced replacement)
    if (this.pendingUnlinks.has(filePath)) {
      clearTimeout(this.pendingUnlinks.get(filePath)!)
      this.pendingUnlinks.delete(filePath)
    }

    try {
      const stat = fs.statSync(filePath)
      if (!stat.isFile()) return
      const ino = stat.ino ? Number(stat.ino) : null

      // Does this add's inode match a file removed elsewhere in the last
      // couple of seconds? That is a move/rename, not a new file.
      if (ino) {
        const removal = this.recentRemovalsByIno.get(ino)
        if (removal && removal.expiresAt > Date.now() && removal.path !== filePath) {
          this.recentRemovalsByIno.delete(ino)
          if (this.pendingUnlinks.has(removal.path)) {
            clearTimeout(this.pendingUnlinks.get(removal.path)!)
            this.pendingUnlinks.delete(removal.path)
          }
          const relinked = relinkMovedFile(removal.path, filePath, stat)
          if (relinked) {
            this.notifyFilesUpdated(removal.driveKey)
            if (driveKey !== removal.driveKey) this.notifyFilesUpdated(driveKey)
            return
          }
        }
      }

      const updated = await updateFileInPlace(filePath, stat)
      if (updated) {
        if (this.mainWindow && !this.mainWindow.isDestroyed() && updated.thumb) {
          this.mainWindow.webContents.send('thumb-ready', {
            filePath: updated.path,
            thumbPath: updated.thumb
          })
        }
        this.notifyFilesUpdated(driveKey)
      }
    } catch {
      /* vanished again, or unreadable - nothing to record */
    }
  }

  // Every add/change/unlink used to re-query and re-broadcast the drive's
  // entire index (measured: 682ms of synchronous SQLite + ~40k objects
  // structured-cloned across IPC for a 41k-file drive) - per file event.
  // Events are coalesced into one notification per quiet period, and that
  // notification now carries no rows at all: the renderer re-reads the small
  // group summary and only the pages it is actually showing.
  private notifyTimers: Map<string, NodeJS.Timeout> = new Map()

  private notifyFilesUpdated(driveKey: string): void {
    const existing = this.notifyTimers.get(driveKey)
    if (existing) clearTimeout(existing)
    this.notifyTimers.set(
      driveKey,
      setTimeout(() => {
        this.notifyTimers.delete(driveKey)
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('files-updated', {
            drive: driveKey,
            reason: 'background'
          })
        }
      }, NOTIFY_COALESCE_MS)
    )
  }

  public unwatchDrive(drivePath: string): void {
    const driveKey = drivePath.slice(0, 2).toUpperCase()
    const watcher = this.watchers.get(driveKey)
    if (watcher) {
      watcher.close()
      this.watchers.delete(driveKey)
      console.log(`[WatcherManager] Stopped watcher for drive: ${driveKey}`)
    }
  }

  public closeAll(): void {
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    for (const timer of this.settling.values()) clearTimeout(timer)
    this.settling.clear()
    for (const timer of this.pendingUnlinks.values()) clearTimeout(timer)
    this.pendingUnlinks.clear()
    for (const timer of this.notifyTimers.values()) clearTimeout(timer)
    this.notifyTimers.clear()
    this.recentRemovalsByIno.clear()
  }
}
