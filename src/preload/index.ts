import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  getDrives: () => ipcRenderer.send('get-drives'),
  onDrivesUpdated: (callback: (drives: unknown[]) => void) => {
    ipcRenderer.on('drives-updated', (_event, drives) => callback(drives))
  },
  scanDrive: (drivePath: string) => ipcRenderer.send('scan-drive', drivePath),
  rescanDrive: (drivePath: string) => ipcRenderer.send('rescan-drive', drivePath),
  getFiles: (drivePath: string) => ipcRenderer.send('get-files', drivePath),
  onScanProgress: (callback: (data: { count: number; drive: string }) => void) => {
    ipcRenderer.on('scan-progress', (_event, data) => callback(data))
  },
  onScanComplete: (callback: (data: { count: number; drive: string; cached: boolean }) => void) => {
    ipcRenderer.on('scan-complete', (_event, data) => callback(data))
  },
  onFilesUpdated: (callback: (grouped: Record<string, unknown[]>) => void) => {
    ipcRenderer.on('files-updated', (_event, grouped) => callback(grouped))
  },
  getThumb: (filePath: string) => ipcRenderer.invoke('get-thumb', filePath),
  deleteFiles: (paths: string[]) => ipcRenderer.send('delete-files', paths),
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}