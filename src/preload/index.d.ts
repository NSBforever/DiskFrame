import { ElectronAPI } from '@electron-toolkit/preload'

interface DriveInfo {
  name: string
  filesystem: string
  total: number
  used: number
  free: number
}

interface ScannedFile {
  path: string
  name: string
  ext: string
  size: number
  date: string
  year: string
  month: string
  lat: number | null
  lng: number | null
  drive: string
  favourited: number
  thumb: string | null
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      getDrives: () => void
      onDrivesUpdated: (callback: (drives: DriveInfo[]) => void) => () => void
      scanDrive: (drivePath: string) => void
      getFiles: (drivePath: string) => void
      onScanProgress: (callback: (data: { count: number; drive: string }) => void) => () => void
      onScanComplete: (callback: (data: { count: number; drive: string }) => void) => () => void
      onFilesUpdated: (callback: (grouped: Record<string, ScannedFile[]>) => void) => () => void
      toggleFavourite: (filePath: string) => void
      getFavourites: () => void
      onFavouritesUpdated: (callback: (files: ScannedFile[]) => void) => () => void
      onFavouriteToggled: (callback: (data: { filePath: string; isFav: boolean }) => void) => () => void
      openFile: (filePath: string) => void
      readFileBase64: (filePath: string) => Promise<string>
      onThumbReady: (callback: (data: { filePath: string; thumbPath: string }) => void) => () => void
      transcodeVideo: (inputPath: string) => Promise<string>
      onTranscodeDone: (callback: (data: { inputPath: string; outPath: string }) => void) => () => void
      onTranscodeProgress: (
        callback: (data: { inputPath: string; secs: number; totalSecs?: number }) => void
      ) => () => void
      onTranscodeError: (callback: (data: { inputPath: string }) => void) => () => void
      fsCopyPaste: (filePaths: string[], destDrive: string) => Promise<{ success: string[]; failed: { path: string; error: string }[] }>
      fsCutPaste: (filePaths: string[], destDrive: string) => Promise<{ success: string[]; failed: { path: string; error: string }[] }>
      onFsIoProgress: (
        callback: (data: { completed: number; total: number; currentFile: string }) => void
      ) => () => void
      getVideoPlayInfo: (
        filePath: string,
        startSecs?: number
      ) => Promise<{ mode: 'native' | 'stream'; url: string; duration: number; isRemux?: boolean }>
      stopVideoStream: () => Promise<boolean>
      getTileSize: () => Promise<number>
      setTileSize: (size: number) => Promise<void>
    }
  }
}
