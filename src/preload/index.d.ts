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
      scanDrive: (drivePath: string) => void
      rescanDrive: (drivePath: string) => void
      getFiles: (drivePath: string) => void
      onScanProgress: (callback: (data: { count: number; drive: string }) => void) => void
      onScanComplete: (callback: (data: { count: number; drive: string; cached: boolean }) => void) => void
      onFilesUpdated: (callback: (grouped: Record<string, unknown[]>) => void) => void
    }
  }
}