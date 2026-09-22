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
      getDriveFileCounts: () => Promise<Record<string, number>>
      getRuntimeMode: () => Promise<{
        safeMode: boolean
        allowed: string[]
        sampleFolder: string | null
        userDataPath: string
        isDefaultUserData: boolean
      }>
      onDrivesUpdated: (callback: (drives: DriveInfo[]) => void) => () => void
      scanDrive: (drivePath: string) => void
      openDrive: (drivePath: string) => void
      reconcileDrive: (drivePath: string) => void
      onDriveOpened: (
        callback: (data: { drive: string; indexed: number; needsInitialScan: boolean }) => void
      ) => () => void
      getFiles: (drivePath: string) => void
      librarySummary: (query: {
        drive: string; nav: string; search: string; groupBy: string; order: string
      }) => Promise<{
        total: number
        groups: { key: string; count: number; minDate: string; maxDate: string; offset: number }[]
      }>
      libraryPage: (
        query: { drive: string; nav: string; search: string; groupBy: string; order: string },
        offset: number,
        limit: number
      ) => Promise<{ offset: number; rows: ScannedFile[] }>
      onScanProgress: (callback: (data: { count: number; drive: string }) => void) => () => void
      onScanComplete: (callback: (data: { count: number; drive: string }) => void) => () => void
      onFilesUpdated: (
        callback: (payload: {
          drive: string
          groups: Record<string, ScannedFile[]>
          /** 'initial' = the user asked for this drive. 'background' = a scan or watcher found changes. */
          reason: 'initial' | 'background'
        }) => void
      ) => () => void
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
      getViewOrder: () => Promise<'default' | 'reverse'>
      setViewOrder: (order: 'default' | 'reverse') => Promise<void>
      getHoverPreviews: () => Promise<boolean>
      setHoverPreviews: (enabled: boolean) => Promise<void>
      prioritizeThumbnails: (filePaths: string[]) => Promise<(string | null)[]>
      pickFolder: () => Promise<string | null>
      indexFolder: (
        folder: string,
        maxFiles?: number
      ) => Promise<{
        ok: boolean
        error?: string
        added?: number
        seen?: number
        visited?: number
        skipped?: number
        stoppedBy?: 'files' | 'entries' | 'cancelled' | null
        complete?: boolean
        drive?: string
        volumeId?: string | null
        truncated?: boolean
      }>
      driveAvailability: () => Promise<
        {
          drive: string
          rows: number
          mounted: boolean
          currentVolumeId: string | null
          recordedVolumeIds: string[]
          volumeMatches: boolean | null
        }[]
      >
      cancelIndexFolder: () => Promise<boolean>
      favouritePaths: () => Promise<string[]>
      playMpv: (filePath: string, relativeBounds: { left: number; top: number; width: number; height: number }) => Promise<void>
      sendMpvCommand: (command: string, args: any[]) => void
      resizeMpv: (bounds: { left: number; top: number; width: number; height: number }) => void
      closeMpv: () => void
      onMpvPropertyChange: (callback: (data: { name: string; value: any }) => void) => () => void
      onMpvError: (callback: (data: { error: string }) => void) => () => void
      startNativeDrag: (filePaths: string[]) => void
      onNativeDragError: (callback: (data: { error: string }) => void) => () => void
      incrementalSyncDrive: (drivePath: string) => Promise<{ fullScanNeeded: boolean; count: number }>
      getVolumeId: (drivePath: string) => Promise<string | null>
      onSafeModeSample: (
        callback: (data: { drive: string; folder: string; count: number }) => void
      ) => () => void
      onElevationStatus: (callback: (status: { isElevated: boolean; message: string }) => void) => () => void
    }
  }
}
