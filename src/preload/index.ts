import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  getDrives: () => ipcRenderer.send('get-drives'),
  onDrivesUpdated: (callback: (drives: unknown[]) => void) => {
    ipcRenderer.on('drives-updated', (_event, drives) => callback(drives))
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
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}