import chokidar, { FSWatcher } from 'chokidar'
import * as fs from 'fs'
import { BrowserWindow } from 'electron'
import { updateFileInPlace, removeFileRecord, getGroupedFiles, getFileIno, relinkMovedFile } from './scanner'

// How long a removed file's inode is remembered as a "possible move" before
// being treated as a genuine delete. Windows reports a move/rename as a plain
// unlink+add pair (chokidar has no native rename event), so this is the
// correlation window used to recognize them as the same file.
const MOVE_CORRELATION_WINDOW_MS = 2000

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

  public watchDrive(drivePath: string): void {
    const driveKey = drivePath.slice(0, 2).toUpperCase()
    if (this.watchers.has(driveKey)) return

    console.log(`[WatcherManager] Starting chokidar watcher for drive: ${drivePath}`)

    const watcher = chokidar.watch(drivePath, {
      ignored: [
        /(^|[\/\\])\../, // ignore dotfiles
        '**/node_modules/**',
        '**/$Recycle.Bin/**',
        '**/System Volume Information/**',
        '**/Windows/**',
        '**/Program Files/**'
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
    console.log(`[WatcherManager] Unlink event captured for: "${filePath}". Holding in 250ms debounce window...`)

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

  private notifyFilesUpdated(driveKey: string): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const grouped = getGroupedFiles(driveKey)
      this.mainWindow.webContents.send('files-updated', grouped)
    }
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
    this.recentRemovalsByIno.clear()
  }
}
