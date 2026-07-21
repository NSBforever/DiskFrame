import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  getDrives: () => ipcRenderer.send('get-drives'),
  onDrivesUpdated: (cb: (drives: unknown[]) => void) => {
    const listener = (_e: unknown, d: any) => cb(d)
    ipcRenderer.on('drives-updated', listener)
    return () => {
      ipcRenderer.removeListener('drives-updated', listener)
    }
  },
  scanDrive: (p: string) => ipcRenderer.send('scan-drive', p),
  getFiles: (p: string) => ipcRenderer.send('get-files', p),
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
  onFilesUpdated: (cb: (g: Record<string, unknown[]>) => void) => {
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
