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
  /** The volume this row was verified to come from; null/absent for a
   *  pre-identity legacy row. Passed back on single-file actions so a path
   *  shared by two different volumes can never be acted on ambiguously. */
  volume_id?: string | null
}

/**
 * The library query as it crosses the bridge. Loose on purpose: the renderer
 * assembles it from state, and the main process re-validates every field.
 */
type LibraryQueryLike = {
  drive: string
  nav: string
  search: string
  groupBy: string
  order: string
  /** Optional geographic box, used by the map and the place panel. */
  bbox?: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null
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
        appVersion: string
        buildCommit: string
      }>
      onDrivesUpdated: (callback: (drives: DriveInfo[]) => void) => () => void
      scanDrive: (drivePath: string) => void
      openDrive: (drivePath: string) => void
      reconcileDrive: (drivePath: string) => void
      /** Stops an in-flight drive scan. Rows already found are kept. */
      cancelScan: (drivePath: string) => Promise<{ cancelled: boolean }>
      onDriveOpened: (
        callback: (data: {
          drive: string
          indexed: number
          needsInitialScan: boolean
          identityUnresolved: boolean
        }) => void
      ) => () => void
      getFiles: (drivePath: string) => void
      librarySummary: (query: LibraryQueryLike) => Promise<{
        total: number
        groups: {
          key: string
          count: number
          compactCount: number
          minDate: string
          maxDate: string
          offset: number
        }[]
        /**
         * Fingerprint of the catalogue these groups were read from. Pages
         * carry it too; the renderer keeps only pages that agree, so a file
         * cannot end up resident at two indices while discovery is committing.
         */
        version: string
      }>
      /** Folders the index expects that are not on the drive right now. */
      listUnresolvedRoots: (drive: string) => Promise<{
        roots: { root: string; count: number; sample: string }[]
      }>
      /** Opens a folder picker for a missing folder and records a verified relink. */
      locateFolder: (root: string) => Promise<{
        saved: boolean
        cancelled?: boolean
        checked: number
        found: number
        sizeMatches: number
        reason?: string
        target?: string
      }>
      /** Verifies and records a relink for an already-chosen folder. */
      applyFolderMapping: (
        root: string,
        target: string
      ) => Promise<{
        saved: boolean
        checked: number
        found: number
        sizeMatches: number
        reason?: string
      }>
      listFolderMappings: () => Promise<{ mappings: { from: string; to: string }[] }>
      forgetFolderMapping: (fromPrefix: string) => Promise<{ ok: boolean }>
      onFolderRelinked: (
        callback: (p: { root: string; target: string }) => void
      ) => () => void
      libraryPage: (
        query: LibraryQueryLike,
        offset: number,
        limit: number
      ) => Promise<{ offset: number; rows: ScannedFile[]; version: string }>
      /** Counts and bounds per cluster cell for one map viewport and zoom. */
      mapClusters: (
        query: LibraryQueryLike,
        zoom: number,
        bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number }
      ) => Promise<{
        clusters: {
          cx: number
          cy: number
          count: number
          lat: number
          lng: number
          minLat: number
          maxLat: number
          minLng: number
          maxLng: number
          thumb: string | null
          path: string | null
        }[]
      }>
      onScanProgress: (callback: (data: { count: number; drive: string }) => void) => () => void
      onScanComplete: (callback: (data: { count: number; drive: string }) => void) => () => void
      onFilesUpdated: (
        callback: (payload: {
          drive: string
          /** 'initial' = the user asked for this drive. 'background' = a scan or watcher found changes. */
          reason: 'initial' | 'background'
        }) => void
      ) => () => void
      toggleFavourite: (filePath: string, volumeId?: string | null) => void
      getFavourites: (drive: string) => void
      onFavouritesUpdated: (
        callback: (payload: { drive: string | null; files: ScannedFile[] }) => void
      ) => () => void
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
      getAiSearchButton: () => Promise<boolean>
      setAiSearchButton: (enabled: boolean) => Promise<void>
      setOverlayMeta: (meta: { name?: string; isFav?: boolean; toast?: string; show?: boolean }) => void
      onOverlayMeta: (
        cb: (m: { name?: string; isFav?: boolean; toast?: string; show?: boolean }) => void
      ) => () => void
      overlayAction: (action: string) => void
      setOverlayInteractive: (on: boolean) => void
      onOverlayAction: (cb: (action: string) => void) => () => void
      prioritizeThumbnails: (req: {
        /** Tiles on screen now (plus the mount overscan). Generated first. */
        visible: string[]
        /** A wider band above and below, not mounted. Generated after `visible`. */
        prefetch: string[]
      }) => Promise<string[]>
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
      incrementalSyncDrive: (
        drivePath: string
      ) => Promise<{ fullScanNeeded: boolean; count: number; volumeId: string | null }>
      getVolumeId: (drivePath: string) => Promise<string | null>
      onSafeModeSample: (
        callback: (data: { drive: string; folder: string; count: number }) => void
      ) => () => void
      onElevationStatus: (callback: (status: { isElevated: boolean; message: string }) => void) => () => void
    }
  }
}
