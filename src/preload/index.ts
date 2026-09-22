import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  getDrives: () => ipcRenderer.send('get-drives'),
  getDriveFileCounts: () => ipcRenderer.invoke('get-drive-file-counts'),
  getRuntimeMode: () => ipcRenderer.invoke('get-runtime-mode'),
  onDrivesUpdated: (cb: (drives: unknown[]) => void) => {
    const listener = (_e: unknown, d: any) => cb(d)
    ipcRenderer.on('drives-updated', listener)
    return () => {
      ipcRenderer.removeListener('drives-updated', listener)
    }
  },
  scanDrive: (p: string) => ipcRenderer.send('scan-drive', p),
  /** Cached-only open: reads the index, never scans or stats the drive. */
  openDrive: (p: string) => ipcRenderer.send('open-drive', p),
  /** Explicit reconciliation, separate from opening. */
  reconcileDrive: (p: string) => ipcRenderer.send('reconcile-drive', p),
  onDriveOpened: (cb: (d: { drive: string; indexed: number; needsInitialScan: boolean }) => void) => {
    const listener = (_e: unknown, d: any) => cb(d)
    ipcRenderer.on('drive-opened', listener)
    return () => {
      ipcRenderer.removeListener('drive-opened', listener)
    }
  },
  getFiles: (p: string) => ipcRenderer.send('get-files', p),
  /** Group counts + total for a query. Small: one row per group, no file rows. */
  librarySummary: (query: unknown) => ipcRenderer.invoke('library-summary', query),
  /** One bounded window of rows for a query. */
  libraryPage: (query: unknown, offset: number, limit: number) =>
    ipcRenderer.invoke('library-page', { query, offset, limit }),
  onScanProgress: (cb: (d: { count: number; drive: string }) => void) => {
    const listener = (_e: unknown, d: any) => cb(d)
    ipcRenderer.on('scan-progress', listener)
    return () => {
      ipcRenderer.removeListener('scan-progress', listener)
    }
  },
  onScanComplete: (cb: (d: { count: number; drive: string }) => void) => {
    const listener = (_e: unknown, d: any) => cb(d)
    ipcRenderer.on('scan-complete', listener)
    return () => {
      ipcRenderer.removeListener('scan-complete', listener)
    }
  },
  onFilesUpdated: (cb: (payload: { drive: string; groups: Record<string, unknown[]>; reason: string }) => void) => {
    const listener = (_e: unknown, g: any) => cb(g)
    ipcRenderer.on('files-updated', listener)
    return () => {
      ipcRenderer.removeListener('files-updated', listener)
    }
  },
  toggleFavourite: (p: string) => ipcRenderer.send('toggle-favourite', p),
  getFavourites: () => ipcRenderer.send('get-favourites'),
  onFavouritesUpdated: (cb: (files: unknown[]) => void) => {
    const listener = (_e: unknown, f: any) => cb(f)
    ipcRenderer.on('favourites-updated', listener)
    return () => {
      ipcRenderer.removeListener('favourites-updated', listener)
    }
  },
  onFavouriteToggled: (cb: (d: { filePath: string; isFav: boolean }) => void) => {
    const listener = (_e: unknown, d: any) => cb(d)
    ipcRenderer.on('favourite-toggled', listener)
    return () => {
      ipcRenderer.removeListener('favourite-toggled', listener)
    }
  },
  openFile: (p: string) => ipcRenderer.send('open-file', p),
  readFileBase64: (p: string) => ipcRenderer.invoke('read-file-base64', p),
  onThumbReady: (cb: (d: { filePath: string; thumbPath: string }) => void) => {
    const listener = (_e: unknown, d: any) => cb(d)
    ipcRenderer.on('thumb-ready', listener)
    return () => {
      ipcRenderer.removeListener('thumb-ready', listener)
    }
  },
  transcodeVideo: (path: string) => ipcRenderer.send('transcode-video', path),
  onTranscodeDone: (cb: (d: { inputPath: string; outPath: string }) => void) => {
    const listener = (_e: unknown, d: any) => cb(d)
    ipcRenderer.on('transcode-done', listener)
    return () => {
      ipcRenderer.removeListener('transcode-done', listener)
    }
  },
  onTranscodeProgress: (cb: (d: { inputPath: string; secs: number }) => void) => {
    const listener = (_e: unknown, d: any) => cb(d)
    ipcRenderer.on('transcode-progress', listener)
    return () => {
      ipcRenderer.removeListener('transcode-progress', listener)
    }
  },
  onTranscodeError: (cb: (d: { inputPath: string }) => void) => {
    const listener = (_e: unknown, d: any) => cb(d)
    ipcRenderer.on('transcode-error', listener)
    return () => {
      ipcRenderer.removeListener('transcode-error', listener)
    }
  },
  fsCopyPaste: (filePaths: string[], destDrive: string) =>
    ipcRenderer.invoke('fs-copy-paste', { filePaths, destDrive }),
  fsCutPaste: (filePaths: string[], destDrive: string) =>
    ipcRenderer.invoke('fs-cut-paste', { filePaths, destDrive }),
  onFsIoProgress: (cb: (d: { completed: number; total: number; currentFile: string }) => void) => {
    const listener = (_e: unknown, d: any) => cb(d)
    ipcRenderer.on('fs-io-progress', listener)
    return () => {
      ipcRenderer.removeListener('fs-io-progress', listener)
    }
  },
  getVideoPlayInfo: (filePath: string, startSecs?: number) =>
    ipcRenderer.invoke('get-video-play-info', { filePath, startSecs }),
  stopVideoStream: () => ipcRenderer.invoke('stop-video-stream'),
  getTileSize: () => ipcRenderer.invoke('get-tile-size'),
  setTileSize: (size: number) => ipcRenderer.invoke('set-tile-size', size),
  getViewOrder: () => ipcRenderer.invoke('get-view-order'),
  setViewOrder: (order: 'default' | 'reverse') => ipcRenderer.invoke('set-view-order', order),
  getHoverPreviews: () => ipcRenderer.invoke('get-hover-previews'),
  setHoverPreviews: (enabled: boolean) => ipcRenderer.invoke('set-hover-previews', enabled),
  prioritizeThumbnails: (filePaths: string[]) => ipcRenderer.invoke('prioritize-thumbnails', filePaths),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  indexFolder: (folder: string, maxFiles?: number) => ipcRenderer.invoke('index-folder', folder, maxFiles),
  driveAvailability: () => ipcRenderer.invoke('drive-availability'),
  favouritePaths: () => ipcRenderer.invoke('favourite-paths'),
  playMpv: (filePath: string, relativeBounds: { left: number; top: number; width: number; height: number }) =>
    ipcRenderer.invoke('start-mpv', { filePath, relativeBounds }),
  sendMpvCommand: (command: string, args: any[]) =>
    ipcRenderer.send('mpv-command', { command, args }),
  resizeMpv: (bounds: { left: number; top: number; width: number; height: number }) =>
    ipcRenderer.send('mpv-resize', bounds),
  closeMpv: () =>
    ipcRenderer.send('mpv-close'),
  onMpvPropertyChange: (cb: (d: { name: string; value: any }) => void) => {
    const listener = (_e: unknown, d: any) => cb(d)
    ipcRenderer.on('mpv-property-change', listener)
    return () => {
      ipcRenderer.removeListener('mpv-property-change', listener)
    }
  },
  onMpvError: (cb: (d: { error: string }) => void) => {
    const listener = (_e: unknown, d: any) => cb(d)
    ipcRenderer.on('mpv-error', listener)
    return () => {
      ipcRenderer.removeListener('mpv-error', listener)
    }
  },
  startNativeDrag: (filePaths: string[]) =>
    ipcRenderer.send('start-native-drag', filePaths),
  onNativeDragError: (cb: (d: { error: string }) => void) => {
    const listener = (_e: unknown, d: any) => cb(d)
    ipcRenderer.on('native-drag-error', listener)
    return () => {
      ipcRenderer.removeListener('native-drag-error', listener)
    }
  },
  incrementalSyncDrive: (drivePath: string) => ipcRenderer.invoke('incremental-sync-drive', drivePath),
  getVolumeId: (drivePath: string) => ipcRenderer.invoke('get-volume-id', drivePath),
  onSafeModeSample: (cb: (d: { drive: string; folder: string; count: number }) => void) => {
    const listener = (_e: unknown, d: any) => cb(d)
    ipcRenderer.on('safe-mode-sample', listener)
    return () => {
      ipcRenderer.removeListener('safe-mode-sample', listener)
    }
  },
  onElevationStatus: (cb: (d: { isElevated: boolean; message: string }) => void) => {
    const listener = (_e: unknown, d: any) => cb(d)
    ipcRenderer.on('elevation-status', listener)
    return () => {
      ipcRenderer.removeListener('elevation-status', listener)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error window globals mapped in dts
  window.electron = electronAPI
  // @ts-expect-error window globals mapped in dts
  window.api = api
}
