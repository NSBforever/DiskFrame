import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  getDrives: () => ipcRenderer.send('get-drives'),
  onDrivesUpdated: (cb: (drives: unknown[]) => void) => {
    ipcRenderer.removeAllListeners('drives-updated')
    ipcRenderer.on('drives-updated', (_e, d) => cb(d))
  },
  scanDrive: (p: string) => ipcRenderer.send('scan-drive', p),
  getFiles: (p: string) => ipcRenderer.send('get-files', p),
  onScanProgress: (cb: (d: { count: number; drive: string }) => void) => {
    ipcRenderer.removeAllListeners('scan-progress')
    ipcRenderer.on('scan-progress', (_e, d) => cb(d))
  },
  onScanComplete: (cb: (d: { count: number; drive: string }) => void) => {
    ipcRenderer.removeAllListeners('scan-complete')
    ipcRenderer.on('scan-complete', (_e, d) => cb(d))
  },
  onFilesUpdated: (cb: (g: Record<string, unknown[]>) => void) => {
    ipcRenderer.removeAllListeners('files-updated')
    ipcRenderer.on('files-updated', (_e, g) => cb(g))
  },
  toggleFavourite: (p: string) => ipcRenderer.send('toggle-favourite', p),
  getFavourites: () => ipcRenderer.send('get-favourites'),
  onFavouritesUpdated: (cb: (files: unknown[]) => void) => {
    ipcRenderer.removeAllListeners('favourites-updated')
    ipcRenderer.on('favourites-updated', (_e, f) => cb(f))
  },
  onFavouriteToggled: (cb: (p: string) => void) => {
    ipcRenderer.removeAllListeners('favourite-toggled')
    ipcRenderer.on('favourite-toggled', (_e, p) => cb(p))
  },
  openFile: (p: string) => ipcRenderer.send('open-file', p),
  readFileBase64: (p: string) => ipcRenderer.invoke('read-file-base64', p),
  onThumbReady: (cb: (d: { filePath: string; thumbPath: string }) => void) => {
    ipcRenderer.removeAllListeners('thumb-ready')
    ipcRenderer.on('thumb-ready', (_e, d) => cb(d))
  },
  transcodeVideo: (path: string) => ipcRenderer.send('transcode-video', path),
  onTranscodeDone: (cb: (d: { inputPath: string; outPath: string }) => void) =>
    ipcRenderer.on('transcode-done', (_e, d) => cb(d)),
  onTranscodeProgress: (cb: (d: { inputPath: string; secs: number }) => void) =>
    ipcRenderer.on('transcode-progress', (_e, d) => cb(d)),
  onTranscodeError: (cb: (d: { inputPath: string }) => void) =>
    ipcRenderer.on('transcode-error', (_e, d) => cb(d))
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
