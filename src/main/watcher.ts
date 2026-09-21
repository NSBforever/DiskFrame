import chokidar, { FSWatcher } from 'chokidar'
import * as fs from 'fs'
import { BrowserWindow } from 'electron'
import { updateFileInPlace, removeFileRecord, getGroupedFiles, getFileIno, relinkMovedFile } from './scanner'
import { isIndexableMedia } from './validation'

// How long a removed file's inode is remembered as a "possible move" before
// being treated as a genuine delete. Windows reports a move/rename as a plain
// unlink+add pair (chokidar has no native rename event), so this is the
// correlation window used to recognize them as the same file.
const MOVE_CORRELATION_WINDOW_MS = 2000

// Quiet period before a batch of file events turns into one renderer broadcast.
const NOTIFY_COALESCE_MS = 1500

interface PendingRemoval {
  path: string
  driveKey: string
  expiresAt: number
}

export class WatcherManager {
  private watchers: Map<string, FSWatcher> = new Map()
  private pendingUnlinks: Map<string, NodeJS.Timeout> = new Map()
  private recentRemovalsByIno: Map<number, PendingRemoval> = new Map()
  private mainWindow: BrowserWindow | null = null

  constructor(mainWindow: BrowserWindow | null = null) {
    this.mainWindow = mainWindow
  }

  public setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  // Only the drive currently being browsed is watched. Watchers used to
  // accumulate for every drive opened during a session, and a recursive
  // chokidar watch over a whole volume holds an OS handle per directory - three
  // of them left hundreds of thousands of handles live in the main process for
  // drives nobody was looking at.
  public watchDrive(drivePath: string): void {
    const driveKey = drivePath.slice(0, 2).toUpperCase()
    if (this.watchers.has(driveKey)) return

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

    console.log(`[WatcherManager] Starting chokidar watcher for drive: ${drivePath}`)

    const watcher = chokidar.watch(drivePath, {
      ignored: [
        /(^|[\/\\])\../, // ignore dotfiles
        '**/node_modules/**',
        '**/$Recycle.Bin/**',
        '**/System Volume Information/**',
        '**/Windows/**',
        '**/Program Files/**',
        // AppData is where browsers, mail and the app's own database churn
        // constantly. Watching it produced a stream of events for files that
        // are never media, and is what filled the index with things like
        // "Local State", settings.dat and diskframe.db itself.
        '**/AppData/**',
        '**/ProgramData/**'
      ],
      persistent: true,
      ignoreInitial: true,
      depth: 6,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100
      }
    })

    watcher.on('unlink', (filePath) => this.handleUnlink(filePath, driveKey))
    watcher.on('add', (filePath) => this.handleAddOrChange(filePath, driveKey))
    watcher.on('change', (filePath) => this.handleAddOrChange(filePath, driveKey))

    this.watchers.set(driveKey, watcher)
  }

  private handleUnlink(filePath: string, driveKey: string): void {
    if (!isIndexableMedia(filePath)) return

    if (this.pendingUnlinks.has(filePath)) {
      clearTimeout(this.pendingUnlinks.get(filePath)!)
    }

    // Remember this file's last-known inode so a matching 'add' elsewhere
    // (same volume) within the correlation window can be recognized as a
    // move/rename instead of a delete + new file.
    const ino = getFileIno(filePath)
    if (ino) {
      this.recentRemovalsByIno.set(ino, { path: filePath, driveKey, expiresAt: Date.now() + MOVE_CORRELATION_WINDOW_MS })
    }

    const timer = setTimeout(() => {
      this.pendingUnlinks.delete(filePath)
      if (ino) this.recentRemovalsByIno.delete(ino)

      // Verify if file truly does not exist on disk
      if (!fs.existsSync(filePath)) {
        console.log(`[WatcherManager] File genuinely removed from disk after debounce: "${filePath}"`)
        removeFileRecord(filePath)
        this.notifyFilesUpdated(driveKey)
      } else {
        console.log(`[WatcherManager] File re-appeared during unlink timer (atomic replace): "${filePath}"`)
        updateFileInPlace(filePath).then(() => this.notifyFilesUpdated(driveKey))
      }
    }, 250)

    this.pendingUnlinks.set(filePath, timer)
  }

  private async handleAddOrChange(filePath: string, driveKey: string): Promise<void> {
    // Cheap reject before any stat or database work - most watcher traffic on a
    // real machine is not media.
    if (!isIndexableMedia(filePath)) return

    // If pending unlink existed for this path, cancel it (coalesced replacement)
    if (this.pendingUnlinks.has(filePath)) {
      console.log(`[WatcherManager] Coalescing unlink + add/change event for replaced file: "${filePath}"`)
      clearTimeout(this.pendingUnlinks.get(filePath)!)
      this.pendingUnlinks.delete(filePath)
    }

    if (!fs.existsSync(filePath)) return

    try {
      const stat = fs.statSync(filePath)
      const ino = stat.ino ? Number(stat.ino) : null

      // Check whether this add's inode matches a file removed elsewhere in the
      // last couple seconds - that's a move/rename, not a new file.
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
            console.log(`[WatcherManager] Detected move: "${removal.path}" -> "${filePath}" (matched by inode)`)
            this.notifyFilesUpdated(removal.driveKey)
            if (driveKey !== removal.driveKey) this.notifyFilesUpdated(driveKey)
            return
          }
        }
      }

      const updated = await updateFileInPlace(filePath, stat)
      if (updated) {
        console.log(`[WatcherManager] Successfully updated file record in-place: "${filePath}"`)
        if (this.mainWindow && !this.mainWindow.isDestroyed() && updated.thumb) {
          this.mainWindow.webContents.send('thumb-ready', { filePath: updated.path, thumbPath: updated.thumb })
        }
        this.notifyFilesUpdated(driveKey)
      }
    } catch (err) {
      console.error(`[WatcherManager] Error processing add/change for ${filePath}:`, err)
    }
  }

  // Every add/change/unlink used to re-query and re-broadcast the drive's
  // entire index (measured: ~17MB of JSON for a 40k-file drive) - structured
  // cloned across IPC and then re-grouped and re-sorted by the renderer, per
  // file event. Copying a folder in made that fire hundreds of times back to
  // back. Events are now coalesced into one broadcast per quiet period, and
  // tagged as 'background' so the renderer can offer a refresh instead of
  // rearranging the gallery under the user.
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
            groups: getGroupedFiles(driveKey),
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
    for (const [key, watcher] of this.watchers.entries()) {
      watcher.close()
      console.log(`[WatcherManager] Closed watcher for drive: ${key}`)
    }
    this.watchers.clear()
    for (const timer of this.pendingUnlinks.values()) {
      clearTimeout(timer)
    }
    this.pendingUnlinks.clear()
    for (const timer of this.notifyTimers.values()) {
      clearTimeout(timer)
    }
    this.notifyTimers.clear()
    this.recentRemovalsByIno.clear()
  }
}
