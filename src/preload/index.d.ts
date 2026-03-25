import { ElectronAPI } from '@electron-toolkit/preload'

interface DriveInfo {
  name: string
  filesystem: string
  total: number
  used: number
  free: number
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      getDrives: () => void
      onDrivesUpdated: (callback: (drives: DriveInfo[]) => void) => void
    }
  }
}