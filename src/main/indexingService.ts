import * as fs from 'fs'
import { BrowserWindow } from 'electron'
import { incrementalSyncDrive, getAllKnownDrives, getGroupedFiles } from './scanner'

const RESCAN_INTERVAL_MS = 30 * 60 * 1000

/**
 * Runs a periodic incremental sync across every previously-indexed drive,
 * independent of whether that drive is currently open in the UI or has a
 * live chokidar watcher. Real-time changes are still caught by WatcherManager
 * for the open drive; this is the fallback that keeps the index correct for
 * drives the user isn't actively looking at, and for changes made while the
 * app wasn't running.
 */
export class IndexingService {
  private timer: NodeJS.Timeout | null = null
  private mainWindow: BrowserWindow | null = null
  private running = false

  constructor(mainWindow: BrowserWindow | null = null) {
    this.mainWindow = mainWindow
  }

  public setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  public start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.runBackgroundSync().catch((err) => console.error('[IndexingService] Background sync error:', err))
    }, RESCAN_INTERVAL_MS)
    console.log(`[IndexingService] Background rescan scheduled every ${RESCAN_INTERVAL_MS / 60000} min`)
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async runBackgroundSync(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const drives = getAllKnownDrives()
      for (const drive of drives) {
        if (!fs.existsSync(`${drive}\\`)) continue // drive not currently mounted - skip silently

        try {
          const result = await incrementalSyncDrive(drive)
          if (!result.fullScanNeeded && this.mainWindow && !this.mainWindow.isDestroyed()) {
            // Tagged with the drive it belongs to. Without that the renderer
            // filed whichever payload arrived last under the drive currently
            // on screen, so a background sync of another volume replaced the
            // open gallery with a different drive's contents.
            this.mainWindow.webContents.send('files-updated', {
              drive,
              groups: getGroupedFiles(drive),
              reason: 'background'
            })
          }
        } catch (err) {
          console.error(`[IndexingService] Background sync failed for drive ${drive}:`, err)
        }
      }
    } finally {
      this.running = false
    }
  }
}
