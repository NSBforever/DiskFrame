import { app, shell, BrowserWindow, ipcMain, protocol, net, crashReporter, Menu, dialog, powerMonitor } from 'electron'
import { join, basename, extname, dirname } from 'path'
import { spawn } from 'child_process'
import * as fs from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { listMountedVolumes, probeDrives, invalidateMountedVolumes } from './driveEnum'
import ffmpegPath from 'ffmpeg-static'
import {
  spawnScanUtilityProcess,
  cancelScanUtilityProcess,
  ScannedFile,
  toggleFavourite,
  getFavourites,
  getFileCount,
  getAllFilesWithoutThumbs,
  recordThumbFailure,
  thumbCacheHit,
  exhaustedThumbPaths,
  THUMB_BACKFILL_BATCH,
  generateThumbForFile,
  updateThumb,
  hideFile,
  unhideFile,
  getPin,
  setPin,
  verifyPin,
  getSkipConfirm,
  setSkipConfirm,
  getTileSizePref,
  setTileSizePref,
  getViewOrderPref,
  setViewOrderPref,
  getHoverPreviewsPref,
  setHoverPreviewsPref,
  getAiSearchButtonPref,
  setAiSearchButtonPref,
  getStartFullscreenPref,
  setStartFullscreenPref,
  getTrashedFiles,
  getTrashCount,
  softDeleteFiles,
  restoreFiles,
  deleteFilesPermanently,
  emptyTrash,
  autoPurgeTrash,
  resolveMediaFile,
  getVolumeId,
  incrementalSyncDrive,
  enrichExifBackfill,
  recordCopiedFile,
  recordMovedFile,
  indexSampleFolder,
  SAMPLE_DRIVE_KEY,
  getLibrarySummary,
  getLibraryPage,
  MAX_PAGE_SIZE,
  purgeGeneratedAssetRows,
  clearThumbSentinels,
  indexFolderBounded,
  cancelFolderIndex,
  getDriveAvailability,
  checkPathAvailability,
  resolveStoredPath,
  listUnresolvedRoots,
  saveFolderMapping,
  removeFolderMapping,
  getFolderMappings,
  clearPathStateCache,
  refreshVolumeCache,
  primeVolumeCache,
  getCachedVolumeId,
  hasCachedVolumeId,
  reconcileDriveLetterForVolume,
  getFavouritePaths
} from './scanner'
import type { LibraryQuery } from './libraryQuery'
import { getMapClusters, getCatalogueVersion } from './scanner'

import { initStreamServer, probeMedia, killActiveStream, closeStreamServer, authorizeStreamPath } from './streamServer'
import { initMpv, sendMpvCommand, updateMpvBounds, closeMpv, refreshMpvBounds, setOverlayInteractive, sendToOverlay } from './mpvManager'
import { WatcherManager } from './watcher'
import { SyncService, catalogueRoot } from './syncService'
import {
  normalizeDrive,
  isSafeLocalPath,
  safePathList,
  safePathRefs,
  THUMB_UNAVAILABLE,
  THUMB_VOLUME_OFFLINE,
  THUMB_FOLDER_MISSING,
  THUMB_NO_ACCESS
} from './validation'
import { parseSafeMode, subsystemEnabled } from './runtimeMode'
import { resolveDriveLetters } from './driveIdentity'
import { ThumbStageStats } from './thumbStages'

/** Which extensions go down the ffmpeg path, so video decode time can be
 *  reported separately from photo decode time - they differ by an order of
 *  magnitude and one mean over both explains neither. */
const VIDEO_THUMB_EXTS = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.wmv', '.webm'])

/** Logical cores, with a floor so a failure to read them cannot yield zero. */
function cpuCount(): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return Math.max(2, require('os').cpus().length)
  } catch {
    return 4
  }
}
import {
  EMPTY_QUEUE,
  mergeThumbRequest,
  nextThumb,
  queuedCount,
  type ThumbQueueState
} from './thumbQueue'

const safeMode = parseSafeMode(process.argv, process.env)

// Diagnostic log goes to a file as well as stdout: an unresponsive window or a
// machine reset loses the console, and the last lines before that are exactly
// what identifies the responsible subsystem.
let diagStream: fs.WriteStream | null = null
function diag(subsystem: string, message: string): void {
  const line = `${new Date().toISOString()} [${subsystem}] ${message}`
  console.log(line)
  try {
    diagStream?.write(line + '\n')
  } catch {
    /* logging must never take the app down */
  }
}

// The scanner module opens and migrates the database as it is imported, so
// this is the cost of everything before Electron is ready, DB included.
diag('startup', `main module loaded at ${uptimeMs()}ms`)

// A second launch (double-click, dev-mode relaunch) must not run alongside the
// first - two instances hold two DB connections, two watchers, two scanners,
// and accumulate as separate multi-GB Electron process trees. app.quit() alone
// isn't enough to stop this: 'ready' can still fire once before quit takes
// effect, so app.whenReady().then() below also checks gotLock and bails.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

// The one confirmed machine-level failure was bugcheck 0x19C
// (WIN32K_POWER_WATCHDOG_TIMEOUT) - the graphics/power stack failing a display
// power transition. Safe mode can take the GPU out of the picture entirely so
// that stack is ruled in or out rather than argued about.
if (safeMode.enabled && safeMode.disableGpu) {
  app.disableHardwareAcceleration()
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

const watcherManager = new WatcherManager()
/**
 * Which drive the user is looking at. Reconciliation, the watcher and the
 * deferred thumbnail pass only ever act for this one; a job started for a
 * drive the user has since left is cancelled or ignored.
 */
let currentOpenDrive: string | null = null

/** Coalesces "something changed" from reconciliation into one renderer re-read. */
const syncNotifyTimers = new Map<string, NodeJS.Timeout>()
const syncService = new SyncService({
  onChanged(drive) {
    if (syncNotifyTimers.has(drive)) return
    syncNotifyTimers.set(
      drive,
      setTimeout(() => {
        syncNotifyTimers.delete(drive)
        sendFilesUpdated(drive, 'sync')
      }, 300)
    )
  },
  onFinished(drive, reason, outcome) {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('sync-finished', { drive, reason, ...outcome })
    // An explicit "Check for changes" is waited on by the status bar.
    if (reason === 'manual') {
      mainWindow.webContents.send('scan-complete', { count: getFileCount(getCachedVolumeId(drive)), drive })
    }
  },
  log: (m) => diag('sync', m)
})

/**
 * Live notifications for the open drive, attached when it is opened (not only
 * after a scan, as before - so changes made in Explorer while browsing a
 * cached drive were never seen). Attaching is O(1): ReadDirectoryChangesW,
 * no traversal.
 */
function attachWatcherFor(drive: string): void {
  if (!subsystemEnabled(safeMode, 'watcher')) return
  const t = Date.now()
  watcherManager.watchDrive(catalogueRoot(drive))
  diag('watcher', `attached to ${catalogueRoot(drive)} in ${Date.now() - t}ms`)
}

/** The open drive, once it is known to have a catalogue worth watching. */
let watchWanted: string | null = null
/** Letters mounted at the previous drive poll, to see the open drive come and go. */
let mountedBefore = new Set<string>()

/**
 * The open drive was unplugged, or came back. Unplugging stops its watcher
 * and any reconciliation in progress (which applies nothing it had not
 * finished); coming back re-attaches the watcher and reconciles, because
 * anything could have changed while it was elsewhere.
 */
function trackOpenDriveMount(mounted: Set<string>): void {
  const d = watchWanted
  if (d && currentOpenDrive === d) {
    const was = mountedBefore.has(d)
    const is = mounted.has(d)
    if (was && !is) {
      diag('sync', `${d}: disconnected - watcher released, nothing removed`)
      syncService.cancel(d)
      watcherManager.unwatchDrive(d)
    } else if (is && (!was || !watcherManager.isWatching(d))) {
      diag('sync', `${d}: ${was ? 'watcher lost' : 'reconnected'} - re-attaching and reconciling`)
      attachWatcherFor(d)
      syncService.request(d, { reason: was ? 'watcher restart' : 'reconnect', delayMs: 1500 })
    }
  }
  mountedBefore = mounted
}

watcherManager.onNeedsReconcile = (driveKey, reason) => {
  // An overflow prompts at most one run per 30s: under heavy churn elsewhere
  // in the watched tree (AppData is inside the home directory) the kernel
  // buffer can overflow over and over, and each overflow alone is not news. A
  // folder event is specific and is acted on promptly.
  if (driveKey === currentOpenDrive && !isQuitting) {
    syncService.request(driveKey, { reason, delayMs: 1500, minGapMs: reason === 'watcher overflow' ? 30_000 : undefined })
  }
}

const ffmpegExe = ffmpegPath ? ffmpegPath.replace('app.asar', 'app.asar.unpacked') : 'ffmpeg'

let mainWindow: BrowserWindow
let driveInterval: ReturnType<typeof setInterval> | null = null
let memoryLogInterval: ReturnType<typeof setInterval> | null = null
// Long-running background passes (thumbnails, capture dates) poll this so they
// stop promptly on quit instead of holding the process alive mid-file.
let isQuitting = false

/**
 * How much on-screen thumbnail work is outstanding.
 *
 * Set once the viewport thumbnail pump is constructed (inside whenReady). The
 * drive-wide backfill polls it and yields, so the two thumbnail slots always go
 * to tiles the user is looking at before they go to the rest of the volume -
 * on a first-time 2 TB drive the backfill otherwise holds both slots for the
 * entire pass and visible tiles stay as placeholders.
 */
let viewportThumbsOutstanding = (): number => 0

/**
 * Worst main-process event-loop delay seen since the last report.
 *
 * "Not Responding" is an event-loop property, not a memory or query-time one:
 * Windows paints that title bar when the window stops pumping messages. A
 * timer that should fire every 250ms and fires late by N tells us directly how
 * long the main process was unavailable, which is the number this fix is
 * actually about - a fast query that blocks for 700ms still freezes the window.
 */
let worstLoopLagMs = 0
let lastLoopTick = Date.now()
const LOOP_TICK_MS = 250
setInterval(() => {
  const now = Date.now()
  const lag = now - lastLoopTick - LOOP_TICK_MS
  lastLoopTick = now
  if (lag > worstLoopLagMs) worstLoopLagMs = lag
}, LOOP_TICK_MS).unref()

// Per-process memory, logged periodically so a reported "app uses N GB" can be
// traced to a specific process (renderer/GPU/main/utility) instead of guessed at.
function logMemoryMetrics(): void {
  const metrics = app.getAppMetrics()
  const parts = metrics
    .map((m) => `${m.type}${m.type === 'Utility' ? `(${m.name ?? m.serviceName ?? '?'})` : ''}=${Math.round(m.memory.workingSetSize / 1024)}MB`)
    .join(' ')
  const total = metrics.reduce((sum, m) => sum + m.memory.workingSetSize, 0)
  const lag = Math.max(0, worstLoopLagMs)
  worstLoopLagMs = 0
  console.log(`[memory] total=${Math.round(total / 1024)}MB | ${parts} | main-loop-worst-stall=${lag}ms`)
}

// Every files-updated payload says which drive it describes and whether the
// user asked for it. The renderer applies 'initial' immediately and offers
// 'background' as a refresh, so an unrelated drive's sync can neither replace
// the open gallery nor rearrange it mid-scroll.
/**
 * Tells the renderer that this drive's catalogue has changed. Carries no rows.
 *
 * It used to carry getGroupedFiles(drive) - every row for the volume, grouped.
 * Measured on the reporter's 2 TB drive (41k indexed files): 682ms of
 * synchronous SQLite work on the main process, then ~41k objects
 * structured-cloned across IPC, then flattened into an array and a Map in the
 * renderer. That fired on every open, every scan completion, every background
 * sync and every watcher quiet period, and it froze both processes for the
 * duration. The renderer reads the library through the paginated
 * library-summary/library-page handlers; this only needs to say "re-read".
 */
function sendFilesUpdated(drive: string, reason: 'initial' | 'background' | 'index-folder' | 'sync'): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('files-updated', {
    drive,
    reason
  })
}

function getUniqueDestPath(destPath: string): string {
  if (!fs.existsSync(destPath)) return destPath
  const dir = dirname(destPath)
  const ext = extname(destPath)
  const base = basename(destPath, ext)
  let counter = 1
  let candidate = join(dir, `${base} (${counter})${ext}`)
  while (fs.existsSync(candidate)) {
    counter++
    candidate = join(dir, `${base} (${counter})${ext}`)
  }
  return candidate
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true,
      corsEnabled: true
    }
  }
])

/**
 * Whether the user wants the window in full screen right now.
 *
 * Kept apart from the viewer's own full screen. The viewer uses the HTML
 * full-screen API on its element, and Chromium's exit from that restores the
 * window to whatever state it entered from - which, if anything goes wrong in
 * that bookkeeping, drops the whole app out of full screen. This is the user's
 * intent for the window, so leaving the viewer's full screen can put it back.
 */
let appFullscreen = false

function sendFullscreenState(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('window-fullscreen-changed', appFullscreen)
  }
}

/** The one way the app's own full screen changes: F11, the menu, the in-app
 *  button and Settings all come here, so the intent above is always current. */
function setAppFullscreen(on: boolean): void {
  appFullscreen = on
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen() !== on) mainWindow.setFullScreen(on)
  sendFullscreenState()
}

function createWindow(): void {
  appFullscreen = getStartFullscreenPref()
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    fullscreen: appFullscreen,
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webSecurity: false,
      webviewTag: true
    }
  })
  diag('startup', `window created at ${uptimeMs()}ms (fullscreen=${appFullscreen})`)
  watcherManager.setMainWindow(mainWindow)
  mainWindow.setBackgroundColor('#00000000')
  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    diag('startup', `window shown at ${uptimeMs()}ms`)
  })
  mainWindow.webContents.once('did-finish-load', () => diag('startup', `renderer loaded at ${uptimeMs()}ms`))
  // Leaving the viewer's (HTML) full screen must leave the app the way it was.
  mainWindow.on('leave-html-full-screen', () => {
    setTimeout(() => {
      if (mainWindow.isDestroyed()) return
      if (mainWindow.isFullScreen() !== appFullscreen) mainWindow.setFullScreen(appFullscreen)
    }, 0)
  })
  mainWindow.on('move', () => refreshMpvBounds())
  mainWindow.on('resize', () => refreshMpvBounds())
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** Letters presented to the user as drives. Aliases are not in here. */
let knownDriveLetters: Set<string> = new Set()

/** Physical medium. Deliberately separate from how the drive is attached:
 *  a USB-attached SSD is external AND an SSD. */
function classifyMediaType(mediaType: string): 'ssd' | 'hdd' | 'unknown' {
  const m = (mediaType || '').trim().toLowerCase()
  if (m === 'ssd' || m === '4') return 'ssd'
  if (m === 'hdd' || m === '3') return 'hdd'
  return 'unknown'
}

function classifyBusType(busType: string): 'internal' | 'external' | 'unknown' {
  const bt = (busType || '').trim().toLowerCase()
  if (bt === 'usb' || bt === 'sd') return 'external'
  // ponytail: bus-type heuristic - an NVMe/SATA drive in a Thunderbolt/USB4
  // external enclosure can still report its native bus here. Add an
  // enclosure-specific check (e.g. Get-Disk .IsBoot for the system disk vs.
  // deeper PNP hardware IDs) if that case matters.
  if (['nvme', 'sata', 'sas', 'raid', 'ata', 'scsi'].includes(bt)) return 'internal'
  return 'unknown'
}

export interface DriveHardware {
  connection: 'internal' | 'external' | 'unknown'
  /** Physical medium, kept separate from how it is attached. */
  media: 'ssd' | 'hdd' | 'unknown'
  model: string | null
}

/**
 * Asks Windows what each drive actually is.
 *
 * The previous query piped Get-Partition | Get-Disk | Get-PhysicalDisk. That
 * pipeline yields nothing for some disks (the USB-attached one here), so
 * `$phys.BusType.ToString()` threw "You cannot call a method on a null-valued
 * expression", the catch reported Unknown, and every drive rendered as
 * "Type unavailable". Get-Disk already carries BusType, so the extra hop was
 * never needed; MediaType is looked up separately and is allowed to be absent.
 *
 * Nothing here keys off a drive letter, and "fixed disk" is not treated as a
 * synonym for internal - a USB-attached drive reports as fixed too.
 */
function queryDriveHardware(letters: string[]): Promise<Record<string, DriveHardware>> {
  return new Promise((resolve) => {
    if (letters.length === 0) return resolve({})
    const { execFile } = require('child_process')
    const list = letters.map((l) => l.replace(/:$/, '')).join(',')

    // Written to a real .ps1 and run with -File. Passing a multi-statement
    // script through -Command means every newline has to become a separator and
    // every quote has to survive two levels of escaping; getting that subtly
    // wrong is what produced "Unexpected token 'foreach'" and left every drive
    // classified as unknown. A script file has none of those failure modes.
    const script = [
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `$out = @()`,
      `foreach ($dl in '${list}'.Split(',')) {`,
      `  $bus = 'Unknown'`,
      `  $media = 'Unknown'`,
      `  $model = ''`,
      `  $vol = ''`,
      `  $err = ''`,
      `  try {`,
      `    $p = Get-Partition -DriveLetter $dl -ErrorAction Stop`,
      `    $d = Get-Disk -Number $p.DiskNumber -ErrorAction Stop`,
      `    if ($d.BusType) { $bus = [string]$d.BusType }`,
      `    if ($d.FriendlyName) { $model = [string]$d.FriendlyName }`,
      `    $pd = Get-PhysicalDisk | Where-Object { $_.DeviceId -eq [string]$p.DiskNumber }`,
      `    if ($pd -and $pd.MediaType) { $media = [string]$pd.MediaType }`,
      `  } catch {`,
      `    $err = $_.Exception.Message`,
      `  }`,
      // Identity (volume GUID, filesystem serial) is no longer asked for here:
      // it comes from mountvol and fs.stat in driveEnum.ts, in milliseconds,
      // before this script has even started.
      `  $out += [PSCustomObject]@{ DriveLetter = $dl; BusType = $bus; MediaType = $media; Model = $model; Err = $err }`,
      `}`,
      `$out | ConvertTo-Json -Compress`
    ].join(String.fromCharCode(13, 10))

    let scriptPath = ''
    try {
      scriptPath = join(app.getPath('temp'), `df-drives-${process.pid}.ps1`)
      fs.writeFileSync(scriptPath, script, 'utf8')
    } catch (e) {
      console.error('[driveHardware] could not write helper script', e)
      return resolve({})
    }

    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { timeout: 15000, windowsHide: true },
      (err: any, stdout: string, stderr: string) => {
        try {
          fs.unlinkSync(scriptPath)
        } catch {
          /* temp file */
        }
        const result: Record<string, DriveHardware> = {}
        if (err) {
          console.error('[driveHardware] failed:', err.message, String(stderr).slice(0, 200))
          return resolve(result)
        }
        try {
          const parsed = JSON.parse(stdout)
          for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
            const letter = `${String(item.DriveLetter).toUpperCase()}:`
            if (item.Err) console.warn(`[driveHardware] ${letter}: ${item.Err}`)
            result[letter] = {
              connection: classifyBusType(String(item.BusType || '')),
              media: classifyMediaType(String(item.MediaType || '')),
              model: item.Model ? String(item.Model) : null
            }
            console.log(`[driveHardware] ${letter} bus=${item.BusType} media=${item.MediaType} model=${item.Model}`)
          }
        } catch (parseErr) {
          console.error('[driveHardware] parse failed:', parseErr, String(stdout).slice(0, 200))
        }
        resolve(result)
      }
    )
  })
}

/**
 * Bus type, medium and model per volume, remembered across launches.
 *
 * They are facts about the physical disk, they cost a PowerShell process to
 * learn, and they never change for a given volume - so a card can show
 * "INTERNAL · SSD" the instant the drive is listed, from last time, while the
 * query that confirms it runs in the background.
 */
const hardwareCachePath = (): string => join(app.getPath('userData'), 'drive-hardware.json')
let hardwareByVolume: Record<string, DriveHardware> = {}
function loadHardwareCache(): void {
  try {
    hardwareByVolume = JSON.parse(fs.readFileSync(hardwareCachePath(), 'utf8')) ?? {}
  } catch {
    hardwareByVolume = {}
  }
}
let hardwareQuery: Promise<void> | null = null
/** Letter set the hardware facts were last asked for, so a plug or unplug asks again. */
let hardwareAskedFor = ''

function refreshHardware(letters: string[], volumes: Map<string, string>): void {
  if (hardwareQuery) return
  hardwareAskedFor = letters.join(',')
  const t = Date.now()
  hardwareQuery = queryDriveHardware(letters)
    .then((byLetter) => {
      let changed = false
      for (const [letter, hw] of Object.entries(byLetter)) {
        const vol = volumes.get(letter)
        // Keyed by the volume, not the letter: letters move between devices.
        if (!vol) continue
        const prev = hardwareByVolume[vol]
        if (!prev || prev.connection !== hw.connection || prev.media !== hw.media || prev.model !== hw.model) {
          hardwareByVolume[vol] = hw
          changed = true
        }
      }
      diag('drives', `hardware facts for ${letters.join(' ')} in ${Date.now() - t}ms${changed ? ' (changed)' : ''}`)
      if (changed) {
        try {
          fs.writeFileSync(hardwareCachePath(), JSON.stringify(hardwareByVolume))
        } catch {
          /* only a cache */
        }
        void sendDrives()
      }
    })
    .finally(() => {
      hardwareQuery = null
    })
}

/** Last list sent, so a renderer that asks again gets an answer immediately. */
let lastDrivesPayload: unknown[] | null = null
let drivesInFlight: Promise<void> | null = null
let drivesSentOnce = false

/**
 * Lists the drives. Never waits on PowerShell: capacity comes from fs.statfs and
 * identity from mountvol (see driveEnum.ts), each letter on its own timeout.
 * Bus/medium/model are filled from the per-volume cache and confirmed in the
 * background, which re-sends the list if anything changed.
 */
function sendDrives(): Promise<void> {
  if (drivesInFlight) return drivesInFlight
  drivesInFlight = sendDrivesNow().finally(() => {
    drivesInFlight = null
  })
  return drivesInFlight
}

async function sendDrivesNow(): Promise<void> {
  try {
    const t0 = Date.now()
    // null means mountvol could not run, which is not the same as "no volumes":
    // every letter is then listed as unverified rather than hidden.
    const volumes = (await listMountedVolumes()) ?? new Map<string, string>()
    const probed = await probeDrives(volumes.keys())
    const letters = probed.map((p) => p.letter)

    // Identity for every mounted letter, and an explicit "nothing here" for a
    // previously indexed letter that is not mounted - so the drive page's
    // counts and an open of this letter both read a verified answer.
    const mounted = new Set(letters)
    for (const l of letters) primeVolumeCache(l, volumes.get(l) ?? null)
    for (const known of knownDriveLetters) if (!mounted.has(known)) primeVolumeCache(known, null)
    trackOpenDriveMount(mounted)

    // Not every drive letter is storage. Windows hands out a letter for a SUBST
    // mapping too, and such a letter answers with the backing volume's capacity
    // and free space - because it IS that volume - while having no volume of
    // its own in mountvol. Presenting it as another drive claims storage the
    // user does not have. Resolution is by verified volume identity, never by
    // capacity, label or letter; see driveIdentity.ts.
    const resolved = resolveDriveLetters(
      probed.map((p) => ({ letter: p.letter, volumeId: volumes.get(p.letter) ?? null, fsSerial: p.fsSerial }))
    )
    const byLetter = new Map(resolved.map((r) => [r.letter, r]))
    for (const r of resolved) {
      if (!r.independent) {
        diag('drives', `${r.letter} is an alias of ${r.aliasOf} (same volume) - not listed as a drive`)
      } else if (r.identityUnverified && !knownDriveLetters.has(r.letter)) {
        diag('drives', `${r.letter} has no verifiable volume identity - listed, but unverified`)
      }
    }

    const GB = 1024 * 1024 * 1024
    const drivesWithType = probed
      .filter((p) => byLetter.get(p.letter)?.independent !== false)
      .map((p) => {
        const volumeId = volumes.get(p.letter) ?? null
        const hw = volumeId ? hardwareByVolume[volumeId] : undefined
        return {
          name: p.letter,
          filesystem: '',
          total: Math.round(p.totalBytes / GB),
          used: Math.round((p.totalBytes - p.freeBytes) / GB),
          free: Math.round(p.freeBytes / GB),
          connectionType: hw?.connection ?? 'unknown',
          mediaType: hw?.media ?? 'unknown',
          model: hw?.model ?? null,
          volumeId,
          // So the card can say "this drive could not be verified" rather than
          // implying its catalogue state is known.
          identityUnverified: byLetter.get(p.letter)?.identityUnverified ?? false,
          // Counted by the verified volume, one indexed COUNT each. Sent with
          // the list so a card never shows "Not indexed yet" while a separate
          // request for its count is still on the way.
          indexedCount: getFileCount(volumeId)
        }
      })

    // Only the letters actually presented as drives. An alias must not get its
    // own file count either - that count belongs to the backing volume's card.
    knownDriveLetters = new Set(drivesWithType.map((d) => d.name))
    lastDrivesPayload = drivesWithType
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('drives-updated', drivesWithType)
    if (!drivesSentOnce) {
      drivesSentOnce = true
      diag('startup', `first drive list (${drivesWithType.map((d) => d.name).join(' ') || 'none'}) at ${uptimeMs()}ms, enumeration ${Date.now() - t0}ms`)
    }

    // Asked once per launch and again only when the set of letters changes -
    // never per poll, even for a disk that will not say what it is.
    if (letters.join(',') !== hardwareAskedFor) refreshHardware(letters, volumes)
  } catch (err) {
    console.error('Error getting disk info:', err)
  }
}

/** Milliseconds since this process started, for startup stage logging. */
function uptimeMs(): number {
  return Math.round(process.uptime() * 1000)
}

/**
 * Guards against stacked backfill passes. Opening a drive schedules one, and
 * opening the same drive twice (or a scan finishing while one is already
 * running) would otherwise start a second pass with its own two sharp/ffmpeg
 * slots - four spawns competing for the same CPU the renderer needs.
 */
let thumbBackfillRunning = false

async function generateThumbsForDrive(drivePath: string): Promise<void> {
  await backfillAllMissingThumbnails(getCachedVolumeId(drivePath))
}

async function backfillAllMissingThumbnails(volumeId?: string | null): Promise<void> {
  if (thumbBackfillRunning) return
  thumbBackfillRunning = true
  try {
    await runThumbBackfill(volumeId)
  } finally {
    thumbBackfillRunning = false
  }
}

async function runThumbBackfill(volumeId?: string | null): Promise<void> {
  let files: ScannedFile[] = []
  try {
    files = getAllFilesWithoutThumbs(volumeId)
  } catch (err) {
    console.error('[thumb:backfill:error] Failed to fetch missing thumbnail rows:', err)
    return
  }

  if (files.length === 0) {
    console.log('[thumb:backfill] No missing thumbnails found in database.')
    return
  }

  console.log(`[thumb:backfill:start] Enqueuing ${files.length} missing thumbnails for processing...`)

  let successCount = 0
  let failCount = 0
  let skipCount = 0
  // Measured: 4 concurrent sharp/ffmpeg spawns was enough to starve the
  // renderer process of CPU during active browsing (main-thread-idle JS
  // evaluation stalling 1-4s+ while this ran). 2 leaves more headroom.
  const CONCURRENCY = 2
  let idx = 0

  async function worker() {
    while (idx < files.length) {
      if (isQuitting) return
      // What is on screen comes first. Without this the backfill holds both
      // thumbnail slots for the whole pass and a tile the user is looking at
      // waits behind tens of thousands of offscreen files.
      while (viewportThumbsOutstanding() > 0) {
        if (isQuitting) return
        await new Promise((r) => setTimeout(r, 150))
      }
      const file = files[idx++]
      if (!file) break

      if (!fs.existsSync(file.path)) {
        // Deliberately leaves `thumb` NULL. This used to write the string
        // 'NO_FILE' into the thumbnail *path* column, which did two kinds of
        // damage: the renderer treated the non-empty value as a usable path and
        // requested media:///NO_FILE, and the backfill's "needs a thumbnail"
        // query (thumb IS NULL OR thumb = '') then skipped the row forever - so
        // a file on a temporarily disconnected drive could never get a
        // thumbnail again even after the drive came back.
        skipCount++
        continue
      }

      try {
        const thumbPath = await generateThumbForFile(file.path, file.ext, file.volume_id ?? null)
        if (thumbPath) {
          updateThumb(file.path, thumbPath)
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('thumb-ready', { filePath: file.path, thumbPath })
          }
          successCount++
        } else {
          failCount++
          console.warn(`[thumb:backfill:fail] Frame/Image conversion returned null for: "${file.path}" (${file.ext})`)
        }
      } catch (err) {
        failCount++
        console.error(`[thumb:backfill:error] Unexpected failure for file "${file.path}":`, err)
      }
      await new Promise((r) => setImmediate(r))
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker())
  await Promise.all(workers)

  console.log(
    `[thumb:backfill:complete] Summary: ${successCount} succeeded, ${failCount} failed, ${skipCount} skipped (file not found on disk).`
  )

  // The query is capped (THUMB_BACKFILL_BATCH) so a large volume cannot pull
  // its whole backlog into memory at once. A full batch means there is more
  // behind it: continue, newest-first again, until a short batch comes back.
  // Nothing progressed (every row skipped or failed) ends the pass instead of
  // re-reading the same rows forever.
  if (files.length >= THUMB_BACKFILL_BATCH && successCount > 0 && !isQuitting) {
    await runThumbBackfill(volumeId)
  }
}

app.whenReady().then(() => {
  if (!gotLock) return
  diag('startup', `electron ready at ${uptimeMs()}ms`)

  // The window first. Everything below this is synchronous registration, so
  // every IPC handler and the media protocol still exist before the renderer
  // can send its first message - but the renderer's 0.5s+ of loading now
  // overlaps all of it instead of starting after it.
  createWindow()
  // Drive enumeration starts now too, in parallel with the renderer loading,
  // so the list is usually ready before the drive page asks for it.
  loadHardwareCache()
  void sendDrives()

  if (safeMode.verboseLog) {
    try {
      const logPath = join(app.getPath('userData'), `diskframe-diagnostic-${Date.now()}.log`)
      diagStream = fs.createWriteStream(logPath, { flags: 'a' })
      diag('safe-mode', `diagnostic log: ${logPath}`)
    } catch (err) {
      console.error('[safe-mode] could not open diagnostic log', err)
    }
  }

  // Without this the app produces no crash dumps of its own: the confirmed
  // sharp native-module crash left nothing behind but a Windows event record.
  try {
    crashReporter.start({ submitURL: '', uploadToServer: false, compress: false })
    diag('startup', `crash dumps: ${app.getPath('crashDumps')}`)
  } catch (err) {
    console.error('[startup] crashReporter unavailable', err)
  }
  // Startup maintenance runs after the first paint, not before the window:
  // purgeGeneratedAssetRows reads every row's path (85k here) and the two of
  // them were ~200ms of synchronous work in front of createWindow().
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (isQuitting) return
      // One-time (idempotent) cleanup of index rows for the app's own generated
      // thumbnails and cache files. Rows only - nothing on disk is removed.
      try {
        clearThumbSentinels()
        const purged = purgeGeneratedAssetRows()
        if (purged.removed > 0) {
          diag('purge', `removed ${purged.removed} generated-asset rows of ${purged.scanned} scanned`)
          if (currentOpenDrive) sendFilesUpdated(currentOpenDrive, 'background')
        }
      } catch (err) {
        console.error('[purge] failed', err)
      }
      // Auto-purge permanently deletes trashed files older than 30 days. A
      // diagnostic session must never destroy anything, so it stays off there.
      if (safeMode.enabled) {
        diag('safe-mode', 'startup trash auto-purge suppressed (no destructive work in diagnostic mode)')
      } else {
        autoPurgeTrash().catch((err) => console.error('Error running auto-purge on startup:', err))
      }
    }, 1500)
  })
  protocol.handle('media', async (request) => {
    // A query string names no part of the file. The viewer's Retry adds one so
    // that Blink stops serving its cached failure for the same URL; without
    // stripping it the '?retry=1' would be decoded as part of the path and
    // every retry would look for a file that does not exist.
    const url = request.url.replace('media:///', '').split('?')[0]
    let filePath: string
    try {
      filePath = decodeURIComponent(url).replace(/\//g, '\\')
    } catch {
      return new Response('Bad request', { status: 400 })
    }

    // The renderer runs with webSecurity disabled so it can paint local media,
    // which means any page content that reaches it could ask this handler for
    // an arbitrary file. Only absolute local paths are served - no UNC shares,
    // no null bytes, nothing relative.
    if (!isSafeLocalPath(filePath)) {
      console.warn('[media protocol] Rejected non-local path request')
      return new Response('Forbidden', { status: 403 })
    }

    // Everything that paints or plays a file comes through here, so this is
    // where volume identity has to be enforced rather than merely recorded.
    // Serving a path whose letter now points at a different volume would show
    // one file under another's record; a distinct status lets the renderer say
    // which of those happened instead of showing a blank tile either way.
    //
    // Thumbnails we generated ourselves live in userData, not on the indexed
    // volume, so they are exempt.
    if (!filePath.toLowerCase().startsWith(app.getPath('userData').toLowerCase())) {
      const availability = checkPathAvailability(filePath)
      if (availability.status === 'drive-offline') {
        return new Response('Drive not connected', { status: 503 })
      }
      if (availability.status === 'volume-mismatch') {
        return new Response('Different volume', { status: 409 })
      }
      // A relinked folder is served from where the user said it is, using the
      // same resolver the thumbnail and playback paths use.
      filePath = availability.resolved
    }

    const lower = filePath.toLowerCase()
    if (lower.endsWith('.heic') || lower.endsWith('.heif')) {
      try {
        const heicCacheDir = join(app.getPath('userData'), 'heic_cache')
        if (!fs.existsSync(heicCacheDir)) {
          fs.mkdirSync(heicCacheDir, { recursive: true })
        }
        const { createHash } = await import('crypto')
        const hash = createHash('md5').update(filePath).digest('hex')
        const cachePath = join(heicCacheDir, `${hash}.jpg`)

        if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) {
          return net.fetch('file:///' + cachePath.replace(/\\/g, '/'))
        }

        if (fs.existsSync(filePath)) {
          let converted = false
          try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const convert = require('heic-convert')
            const inputBuffer = fs.readFileSync(filePath)
            const outputBuffer = await convert({
              buffer: inputBuffer,
              format: 'JPEG',
              quality: 0.92
            })
            fs.writeFileSync(cachePath, outputBuffer)
            converted = true
          } catch (e) {
            console.warn('[HEIC media protocol] heic-convert failed, attempting ffmpeg fallback:', e)
          }

          if (!converted) {
            await new Promise<void>((resolve) => {
              const ff = spawn(ffmpegExe, ['-i', filePath, '-y', cachePath])
              ff.on('close', (code) => {
                if (code === 0 && fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) {
                  converted = true
                }
                resolve()
              })
              ff.on('error', () => resolve())
            })
          }

          if (converted && fs.existsSync(cachePath)) {
            return net.fetch('file:///' + cachePath.replace(/\\/g, '/'))
          }
        }
      } catch (err) {
        console.error('[media protocol HEIC convert error]:', filePath, err)
      }
    }

    return net.fetch('file:///' + filePath.replace(/\\/g, '/'))
  })

  electronApp.setAppUserModelId('com.electron')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // ── DRIVE / SCAN ──
  // Answer at once with the last list (enumeration has usually finished before
  // the renderer mounts), and refresh behind it.
  ipcMain.on('get-drives', () => {
    if (lastDrivesPayload && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('drives-updated', lastDrivesPayload)
    }
    void sendDrives()
  })
  // Per-letter, but the count itself is looked up by the volume currently
  // proven to be at that letter - a stale or foreign catalogue under the same
  // letter is never reported as this drive's count.
  // Async, and it primes identity first.
  //
  // This is what made every card read "Not indexed yet" on a drive that had
  // plainly been browsed. The count for a letter is looked up by the volume
  // proven to be AT that letter, and that identity is resolved by PowerShell
  // shell-outs during sendDrives(). The renderer mounts and asks long before
  // those finish, so the answer was computed against an empty volume cache -
  // every letter resolving to null, every count 0, every card "Not indexed
  // yet". The renderer asked once, so it never corrected itself. A cold start
  // therefore reported an empty library for a full one, which is the one thing
  // the drive screen must never do.
  ipcMain.handle('get-drive-file-counts', async () => {
    const letters = [...knownDriveLetters]
    // Only shell out when something is actually missing, so the 3-second poll
    // does not run PowerShell forever.
    if (letters.some((l) => !hasCachedVolumeId(l))) {
      await refreshVolumeCache(letters)
    }
    const out: Record<string, number> = {}
    for (const letter of letters) {
      out[letter] = getFileCount(getCachedVolumeId(letter))
    }
    diag(
      'drives',
      'file counts: ' +
        (letters.length === 0
          ? '(no drives enumerated yet)'
          : letters.map((l) => `${l}=${out[l]}`).join(' '))
    )
    return out
  })

  // Queried by the renderer on mount rather than pushed once at load time.
  // The push could be missed if the renderer subscribed after it fired, which
  // is how a diagnostic session ended up looking like a normal one showing an
  // empty library.
  ipcMain.handle('get-runtime-mode', () => ({
    safeMode: safeMode.enabled,
    allowed: [...safeMode.allow],
    sampleFolder: safeMode.sampleFolder,
    userDataPath: app.getPath('userData'),
    isDefaultUserData: app.getPath('userData').toLowerCase() === join(app.getPath('appData'), 'diskframe').toLowerCase(),
    // The actual installed version, not a value baked into the renderer bundle -
    // this reads the packaged app's own version in a built install too.
    appVersion: app.getVersion(),
    // Distinguishes two installs that share the same package.json version -
    // baked in at build time (see electron.vite.config.ts), 'unknown' for a
    // build made outside a git checkout.
    buildCommit: __DF_COMMIT__
  }))
  ipcMain.on('reveal-file', (_event, filePath: string) => {
    if (isSafeLocalPath(filePath)) shell.showItemInFolder(resolveStoredPath(filePath))
  })
  ipcMain.on('open-file', (_event, filePath: string) => {
    if (isSafeLocalPath(filePath)) shell.openPath(resolveStoredPath(filePath))
  })

  // ── relinking a moved folder ──
  ipcMain.handle('list-unresolved-roots', (_event, drive: unknown) => {
    const d = normalizeDrive(drive)
    if (!d) return { roots: [] }
    // While reconciliation is still deciding, a missing folder may be one the
    // user deleted on purpose - it is about to be confirmed and dropped, not
    // something to ask them to locate. The banner asks again when it finishes.
    if (syncService.isRunning(d)) return { roots: [], pending: true }
    try {
      return { roots: listUnresolvedRoots(getCachedVolumeId(d)) }
    } catch (err) {
      diag('relink', 'listing failed: ' + String(err))
      return { roots: [] }
    }
  })

  ipcMain.handle('list-folder-mappings', () => ({ mappings: getFolderMappings() }))

  /**
   * Verifies and records a relink for a folder the user has already chosen.
   *
   * Separated from the picker so the decision - does this folder actually hold
   * the files the index expects? - can be exercised without a dialog.
   */
  function applyFolderMapping(
    root: string,
    target: string
  ): ReturnType<typeof saveFolderMapping> {
    const result = saveFolderMapping(root, target)
    if (result.saved) {
      // Anything that failed under the old location must be free to retry.
      thumbFailed.clear()
      clearPathStateCache()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('folder-relinked', { root, target })
      }
    }
    diag(
      'relink',
      `${root} -> ${target}: ${result.saved ? 'saved' : 'refused'} ` +
        `(${result.found}/${result.checked} sampled files found)`
    )
    return result
  }

  ipcMain.handle('apply-folder-mapping', (_event, raw) => {
    const { root, target } = (raw ?? {}) as { root?: unknown; target?: unknown }
    if (typeof root !== 'string' || typeof target !== 'string' || !root || !target) {
      return { saved: false, checked: 0, found: 0, sizeMatches: 0, reason: 'missing paths' }
    }
    return applyFolderMapping(root, target)
  })

  ipcMain.handle('forget-folder-mapping', (_event, fromPrefix: unknown) => {
    if (typeof fromPrefix !== 'string' || !fromPrefix) return { ok: false }
    removeFolderMapping(fromPrefix)
    return { ok: true }
  })

  /**
   * Asks the user where a folder went, then records it only if the files the
   * index expects are actually there. The folder is always their explicit
   * pick - nothing is matched by name or size to find it.
   */
  ipcMain.handle('locate-folder', async (_event, raw) => {
    const { root } = (raw ?? {}) as { root?: unknown }
    if (typeof root !== 'string' || !root) return { saved: false, reason: 'no folder given' }
    if (!mainWindow || mainWindow.isDestroyed()) return { saved: false, reason: 'no window' }
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Locate ' + root,
      message: 'Select the folder that used to be at ' + root,
      properties: ['openDirectory'],
      buttonLabel: 'Use this folder'
    })
    if (picked.canceled || picked.filePaths.length === 0) {
      return { saved: false, cancelled: true }
    }
    const result = applyFolderMapping(root, picked.filePaths[0])
    return { ...result, target: picked.filePaths[0] }
  })

  // Opening the same drive twice (double-click, or a re-open while the first
  // pass is still running) used to start a second full scan alongside the
  // first: two utility processes walking the same volume, two thumbnail
  // backfills, and two sets of progress events fighting over the status bar.
  const scansInFlight = new Set<string>()

  async function runScan(rawDrive: unknown, opts: { forceFull: boolean }): Promise<void> {
    const drivePath = normalizeDrive(rawDrive)
    if (!drivePath) return
    if (!subsystemEnabled(safeMode, 'scan')) {
      diag('safe-mode', `scan request for ${drivePath} refused (scan subsystem off)`)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scan-complete', {
          count: getFileCount(getCachedVolumeId(drivePath)),
          drive: drivePath
        })
      }
      sendFilesUpdated(drivePath, 'initial')
      return
    }
    if (scansInFlight.has(drivePath)) {
      diag('scan', `${drivePath} already scanning - ignoring duplicate request`)
      return
    }
    scansInFlight.add(drivePath)
    try {
      const { homedir } = await import('os')
      // C: is scanned (and watched) from the user's home directory rather than
      // the volume root - watching all of C:\ recursively is enormously more
      // expensive and almost all of it is system files we skip anyway.
      const scanPath = drivePath === 'C:' ? homedir() : `${drivePath}\\`

      // Resolved and cached before anything can record a row for this drive.
      // The scan utility is handed this identity directly, and the watcher
      // (attached further down, after discovery) reads it from this same cache
      // to stamp volume_id on whatever it sees. Priming it first closes the gap
      // where a row could be tagged with a previous device's identity.
      const liveVolumeId = await getVolumeId(drivePath)
      primeVolumeCache(drivePath, liveVolumeId)
      if (liveVolumeId) reconcileDriveLetterForVolume(liveVolumeId, drivePath)

      /**
       * Live change notifications, attached only once discovery is done.
       *
       * Nothing about browsing a drive needs a watcher: opening one has never
       * attached it, and during a first scan the walk that is happening right
       * now is what finds the files, so a watcher would at best duplicate it.
       * Attaching it first was how a minutes-long chokidar traversal of the
       * volume root got in front of the first results; it is cheap now
       * (fs.watch attaches through the kernel in single-digit milliseconds),
       * but "cheap" is not a reason to put anything at all ahead of showing
       * the user their files. It runs after, and never blocks first results.
       */
      const attachWatcher = (): void => {
        if (!subsystemEnabled(safeMode, 'watcher')) {
          diag('safe-mode', `watcher suppressed for ${scanPath}`)
          return
        }
        const t = Date.now()
        watcherManager.watchDrive(scanPath)
        diag('watcher', `attached to ${scanPath} in ${Date.now() - t}ms`)
      }

      // "Check for changes" on a drive that is already indexed is a full
      // reconciliation - every folder listed and every file stat()ed, with the
      // same evidence rules as the background runs - not a stat-everything
      // pass that also re-read every file whose thumbnail happened to be
      // missing. syncService answers with scan-complete when it finishes.
      if (!opts.forceFull && liveVolumeId && getFileCount(liveVolumeId) > 0) {
        attachWatcher()
        syncService.request(drivePath, { reason: 'manual', full: true })
        return
      }

      let count = 0
      await spawnScanUtilityProcess(
        drivePath,
        scanPath,
        liveVolumeId,
        (progress) => {
          count = progress
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('scan-progress', { count, drive: drivePath })
          }
        },
        (status) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('elevation-status', status)
          }
        }
      )
      attachWatcher()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scan-complete', { count, drive: drivePath })
      }
      generateThumbsForDrive(drivePath)
      enrichExifBackfill(() => isQuitting).catch((err) => console.error('[exif backfill]', err))
    } finally {
      scansInFlight.delete(drivePath)
    }
  }

  // ── OPENING A DRIVE IS NOT SCANNING IT ────────────────────────────────────
  // Opening used to fire scan-drive as well, so every click reconciled the
  // whole drive: stat() on every indexed file plus a readdir of every known
  // folder. That is minutes of I/O on a large library and it ran before the
  // user had even decided to stay. Opening now reads the cached index and
  // nothing else; reconciliation is a separate, explicitly requested job.
  // Which drive the user is actually looking at. A deferred job started for one
  // drive must not run after the user has moved to another.

  ipcMain.on('open-drive', (_event, drivePath: string) => {
    const drive = normalizeDrive(drivePath)
    if (!drive) return
    currentOpenDrive = drive
    ;(async () => {
      const t0 = Date.now()
      // The drive-select grid already primed this letter's identity before
      // the user could even see, let alone click, the card (sendDrives()
      // resolves every mounted letter before the next 'drives-updated' tick).
      // Trusting that cache is what makes opening instant; a fresh
      // PowerShell shell-out here on every single click was the one thing
      // still standing between "cached index" and "on screen" - still "no
      // scan" in the sense the comment above means, just not a live WMI
      // round trip when a good answer is already sitting in memory.
      const fromCache = hasCachedVolumeId(drive)
      const liveVolumeId = fromCache ? getCachedVolumeId(drive) : await getVolumeId(drive)
      const tIdentity = Date.now()
      primeVolumeCache(drive, liveVolumeId)
      if (liveVolumeId) reconcileDriveLetterForVolume(liveVolumeId, drive)
      const tReconcile = Date.now()

      const indexed = getFileCount(liveVolumeId)
      const tCount = Date.now()
      sendFilesUpdated(drive, 'initial')
      const tFiles = Date.now()
      diag(
        'open-drive',
        `${drive}: ${indexed} cached records, volume ${liveVolumeId ?? 'unresolved'} ` +
          `(${fromCache ? 'cache' : 'live'}) - identity ${tIdentity - t0}ms, reconcile ${tReconcile - tIdentity}ms, ` +
          `count ${tCount - tReconcile}ms, full fetch ${tFiles - tCount}ms, total ${tFiles - t0}ms`
      )
      // Backfill the rest of this volume's thumbnails, now that we know which
      // volume it is - scoped to it, re-entrancy guarded, yielding to anything
      // the viewport asks for, and delayed so it cannot compete with getting
      // the first page of the gallery on screen. Reading the cached index is
      // still all that opening a drive does to the drive itself.
      if (indexed > 0 && subsystemEnabled(safeMode, 'thumbnails')) {
        setTimeout(() => {
          if (isQuitting || currentOpenDrive !== drive) return
          void generateThumbsForDrive(drive)
        }, 3000)
      }
      // Changes made outside DiskFrame - in Explorer, by another app, or while
      // DiskFrame was closed. Only the open drive is watched and reconciled;
      // a run for a drive just left is cancelled. Delayed so the first page
      // of the gallery is on screen first. After the first run this is one
      // stat per known folder; see reconcile.ts.
      if (liveVolumeId && indexed > 0) {
        syncService.cancel()
        watchWanted = drive
        attachWatcherFor(drive) // releases any other drive's watcher
        if (subsystemEnabled(safeMode, 'scan')) syncService.request(drive, { reason: 'open', delayMs: 1500 })
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('drive-opened', {
          drive,
          indexed,
          // A drive with no records needs a first scan, but the user asks for it.
          needsInitialScan: indexed === 0,
          // Distinct from "not indexed yet": we could not verify what is
          // actually mounted here at all, so even a scan would be a guess.
          identityUnresolved: !liveVolumeId
        })
      }
    })()
  })

  // ── PAGINATED LIBRARY READS ───────────────────────────────────────────────
  // The summary is small (one row per group) and lets the renderer lay out the
  // whole grid without holding any file rows. Pages are fetched only for what
  // is actually on screen.
  function normalizeQuery(raw: unknown): LibraryQuery | null {
    const q = (raw ?? {}) as Partial<LibraryQuery>
    const drive = q.drive === SAMPLE_DRIVE_KEY ? SAMPLE_DRIVE_KEY : normalizeDrive(q.drive)
    if (!drive) return null
    const navs = ['all', 'photos', 'videos', 'docs', 'screenshots', 'places', 'favourites']
    const groups = ['day', 'month', 'year', 'location', 'favorites']
    return {
      drive,
      // Read from the same live cache open-drive/scan primed - never trusted
      // from the renderer, and never re-resolved per page/summary/cluster
      // request (that would mean a PowerShell shell-out per keystroke).
      volumeId: drive === SAMPLE_DRIVE_KEY ? null : getCachedVolumeId(drive),
      nav: (navs.includes(String(q.nav)) ? q.nav : 'all') as LibraryQuery['nav'],
      search: typeof q.search === 'string' ? q.search.slice(0, 200) : '',
      groupBy: (groups.includes(String(q.groupBy)) ? q.groupBy : 'day') as LibraryQuery['groupBy'],
      order: q.order === 'reverse' ? 'reverse' : 'default',
      bbox: normalizeBounds((q as { bbox?: unknown }).bbox)
    }
  }

  /** Four finite edges or nothing - a half-specified box must not widen a query. */
  function normalizeBounds(raw: unknown): {
    minLat: number
    maxLat: number
    minLng: number
    maxLng: number
  } | null {
    const b = raw as Record<string, unknown> | null | undefined
    if (!b || typeof b !== 'object') return null
    const n = (v: unknown): number | null => (Number.isFinite(Number(v)) ? Number(v) : null)
    const minLat = n(b.minLat)
    const maxLat = n(b.maxLat)
    const minLng = n(b.minLng)
    const maxLng = n(b.maxLng)
    if (minLat === null || maxLat === null || minLng === null || maxLng === null) return null
    return { minLat, maxLat, minLng, maxLng }
  }

  ipcMain.handle('library-summary', (_event, raw) => {
    const q = normalizeQuery(raw)
    if (!q) return { total: 0, groups: [], version: getCatalogueVersion() }
    const t0 = Date.now()
    // Read BEFORE the rows it describes, so the version can never be newer than
    // them. A version read afterwards would miss a write that landed during the
    // query, and the renderer would then trust pages it should have dropped.
    const version = getCatalogueVersion()
    const res = getLibrarySummary(q)
    diag('library', `summary ${q.drive}/${q.nav}/${q.groupBy}: ${res.total} files in ${res.groups.length} groups (${Date.now() - t0}ms)`)
    return { ...res, version }
  })

  ipcMain.handle('library-map-clusters', (_event, raw) => {
    const { query, zoom, bounds } = (raw ?? {}) as {
      query?: unknown
      zoom?: number
      bounds?: { minLat: number; maxLat: number; minLng: number; maxLng: number }
    }
    const q = normalizeQuery(query)
    if (!q) return { clusters: [] }
    const num = (v: unknown): number | null => (Number.isFinite(Number(v)) ? Number(v) : null)
    const minLat = num(bounds?.minLat)
    const maxLat = num(bounds?.maxLat)
    const minLng = num(bounds?.minLng)
    const maxLng = num(bounds?.maxLng)
    // A viewport is only applied when all four edges are real numbers -
    // a partial box would silently widen the query to the whole world.
    const bbox =
      minLat !== null && maxLat !== null && minLng !== null && maxLng !== null
        ? { minLat, maxLat, minLng, maxLng }
        : null
    const z = Math.max(0, Math.min(22, Math.floor(Number(zoom) || 2)))
    const t0 = Date.now()
    const clusters = getMapClusters({ ...q, bbox }, z)
    diag('map', `clusters z${z}: ${clusters.length} cells (${Date.now() - t0}ms)`)
    return { clusters }
  })

  ipcMain.handle('library-page', (_event, raw) => {
    const { query, offset, limit } = (raw ?? {}) as { query?: unknown; offset?: number; limit?: number }
    const q = normalizeQuery(query)
    if (!q) return { offset: 0, rows: [], version: getCatalogueVersion() }
    const from = Math.max(0, Math.floor(Number(offset) || 0))
    const size = Math.max(1, Math.min(Math.floor(Number(limit) || 100), MAX_PAGE_SIZE))
    // Same ordering as the summary: the version, then the rows it describes.
    const version = getCatalogueVersion()
    const rows = getLibraryPage(q, from, size)
    return { offset: from, rows, version }
  })

  // Explicit reconciliation. Never triggered by opening a drive.
  ipcMain.on('reconcile-drive', (_event, drivePath: string) => {
    runScan(drivePath, { forceFull: false }).catch((err) => diag('reconcile', String(err)))
  })

  ipcMain.on('scan-drive', (_event, drivePath: string) => {
    runScan(drivePath, { forceFull: false }).catch((err) => console.error('[scan-drive]', err))
  })

  // Discovery has to be stoppable, not just waitable. Rows already committed
  // are kept: they are files that were really found.
  ipcMain.handle('cancel-scan', (_event, drivePath: unknown) => {
    const drive = normalizeDrive(drivePath)
    if (!drive) return { cancelled: false }
    const cancelled = cancelScanUtilityProcess(drive)
    diag('scan', `${drive}: cancel requested (${cancelled ? 'stopped' : 'nothing running'})`)
    return { cancelled }
  })

  ipcMain.on('rescan-drive', (_event, drivePath: string) => {
    runScan(drivePath, { forceFull: true }).catch((err) => console.error('[rescan-drive]', err))
  })

  ipcMain.handle('incremental-sync-drive', async (_event, drivePath: string) => {
    const drive = normalizeDrive(drivePath)
    if (!drive) return { fullScanNeeded: false, count: 0, volumeId: null }
    return incrementalSyncDrive(drive)
  })

  ipcMain.handle('get-volume-id', async (_event, drivePath: string) => {
    const drive = normalizeDrive(drivePath)
    return drive ? getVolumeId(drive) : null
  })

  // The user explicitly asked for this drive, so it applies straight away.
  // The diagnostic sample is addressed by its own key rather than a drive
  // letter, so it has to bypass normalizeDrive (which only accepts "C:" forms).
  ipcMain.on('get-files', (_event, drivePath: string) => {
    if (drivePath === SAMPLE_DRIVE_KEY) {
      sendFilesUpdated(SAMPLE_DRIVE_KEY, 'initial')
      return
    }
    const drive = normalizeDrive(drivePath)
    if (drive) sendFilesUpdated(drive, 'initial')
  })

  ipcMain.on('toggle-favourite', (_event, filePath: string, volumeId?: unknown) => {
    if (!isSafeLocalPath(filePath)) return
    // Reads back through the scanner's existing connection. Opening a second
    // better-sqlite3 handle per toggle meant a fresh WAL attach, page cache and
    // teardown for a single-row read, on the main thread, per click.
    const isFav = toggleFavourite(filePath, typeof volumeId === 'string' ? volumeId : volumeId === null ? null : undefined)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('favourite-toggled', { filePath, isFav })
    }
  })

  // Favourites and trash are scoped per volume, never merged across drives -
  // the renderer always names the drive it means, resolved here to the same
  // live-cached identity every other query uses, and every response is
  // tagged with that drive so a renderer that has since switched drives can
  // tell a late answer apart from a current one instead of briefly showing
  // it.
  ipcMain.on('get-favourites', (_event, drivePath: unknown) => {
    const drive = normalizeDrive(drivePath)
    const volumeId = drive ? getCachedVolumeId(drive) : null
    const files = getFavourites(volumeId)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('favourites-updated', { drive, files })
    }
  })

  // ── SOFT DELETE (TRASH) ──
  /**
   * Re-push the favourites list for one volume. Trashing or restoring a
   * favourited file changes what the badge and the Favourites view should
   * show, and both read this one push - so it has to be resent, not just
   * recomputed on next launch.
   */
  const pushFavourites = (volumeId: string | null): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('favourites-updated', { volumeId, files: getFavourites(volumeId) })
    }
  }

  // The refs a batch operates on all come from one open drive in practice;
  // the first ref that actually carries an identity (set by a single-file
  // action that already knew its row's volume) is trusted, falling back to
  // whatever the ref's own letter currently resolves to for a plain-path
  // batch (multi-select) that never carried one.
  const resolveVolumeIdForRefs = (refs: ReturnType<typeof safePathRefs>): string | null => {
    for (const r of refs) {
      if (typeof r !== 'string' && r.volumeId !== undefined) return r.volumeId
    }
    const first = refs[0]
    if (!first) return null
    const path = typeof first === 'string' ? first : first.path
    return getCachedVolumeId(path.slice(0, 2))
  }

  ipcMain.handle('delete-files', (_event, filePaths: unknown) => {
    const refs = safePathRefs(filePaths)
    softDeleteFiles(refs)
    pushFavourites(resolveVolumeIdForRefs(refs))
    return { success: refs.map((r) => (typeof r === 'string' ? r : r.path)), failed: [] }
  })

  // ── TRASH IPC HANDLERS ──
  ipcMain.handle('restore-files', (_event, filePaths: unknown) => {
    const refs = safePathRefs(filePaths)
    restoreFiles(refs)
    pushFavourites(resolveVolumeIdForRefs(refs))
    return { success: true }
  })

  ipcMain.handle('delete-files-permanently', async (_event, filePaths: unknown) => {
    const refs = safePathRefs(filePaths)
    const r = await deleteFilesPermanently(refs)
    pushFavourites(resolveVolumeIdForRefs(refs))
    return r
  })

  ipcMain.handle('empty-trash', (_event, drivePath: unknown) => {
    const drive = normalizeDrive(drivePath)
    return emptyTrash(drive ? getCachedVolumeId(drive) : null)
  })

  ipcMain.handle('get-trashed-files', (_event, drivePath: unknown) => {
    const drive = normalizeDrive(drivePath)
    return getTrashedFiles(drive ? getCachedVolumeId(drive) : null)
  })

  ipcMain.handle('get-trash-count', (_event, drivePath: unknown) => {
    const drive = normalizeDrive(drivePath)
    return getTrashCount(drive ? getCachedVolumeId(drive) : null)
  })

  // ── SKIP CONFIRM PREF ──
  ipcMain.handle('get-skip-confirm', () => getSkipConfirm())
  ipcMain.handle('set-skip-confirm', (_event, skip: boolean) => {
    setSkipConfirm(skip)
    return true
  })

  ipcMain.handle('get-tile-size', () => getTileSizePref())
  ipcMain.handle('set-tile-size', (_event, size: number) => {
    setTileSizePref(size)
    return true
  })

  ipcMain.handle('get-view-order', () => getViewOrderPref())
  ipcMain.handle('set-view-order', (_event, order: 'default' | 'reverse') => {
    setViewOrderPref(order)
    return true
  })

  ipcMain.handle('get-hover-previews', () => getHoverPreviewsPref())
  ipcMain.handle('set-hover-previews', (_event, enabled: boolean) => {
    setHoverPreviewsPref(enabled)
    return true
  })

  // The app's own full screen: current state, and the preference for launch.
  ipcMain.handle('get-window-fullscreen', () => appFullscreen)
  ipcMain.handle('set-window-fullscreen', (_event, on: unknown) => {
    setAppFullscreen(on === true)
    return appFullscreen
  })
  ipcMain.handle('get-start-fullscreen', () => getStartFullscreenPref())
  ipcMain.handle('set-start-fullscreen', (_event, on: unknown) => {
    setStartFullscreenPref(on === true)
    return true
  })

  ipcMain.handle('get-ai-search-button', () => getAiSearchButtonPref())
  ipcMain.handle('set-ai-search-button', (_event, enabled: boolean) => {
    setAiSearchButtonPref(enabled)
    return true
  })

  // Bumps thumbnail generation for specific (currently-visible) files ahead of
  // the background backfill queue, instead of waiting for the DB-order pass.
  // Bounded concurrency (measured: unbounded Promise.all here could fire 50+
  // simultaneous sharp/ffmpeg spawns for one screen of thumbless tiles,
  // starving the renderer of CPU worse than the startup backfill did).
  // On-demand thumbnails for what is on screen.
  //
  // Scrolling re-asks for overlapping sets constantly, so without these guards
  // the same file is re-generated repeatedly and work for a viewport the user
  // has already left keeps running:
  //   - inFlight dedupes concurrent requests for the same path
  //   - failed remembers paths that could not produce a thumbnail, so a missing
  //     or unreadable file is not retried on every scroll (bounded, and cleared
  //     when the set gets large so a reconnected drive gets a fresh chance)
  //   - each call takes a token; when a newer call arrives the older one stops
  //     between files rather than finishing work nobody is looking at
  const thumbInFlight = new Set<string>()
  const thumbFailed = new Set<string>()
  // Published so the drive-wide backfill can stand aside while any of this is
  // outstanding (see viewportThumbsOutstanding).
  viewportThumbsOutstanding = () => queuedCount(thumbQueue) + thumbInFlight.size
  // Pending viewport work, in two tiers - what is on screen, then the band the
  // user is scrolling towards. See thumbQueue.ts for why they are not one list.
  let thumbQueue: ThumbQueueState = EMPTY_QUEUE
  let thumbPumping = false
  // When each path entered the queue. Queue wait and decode time are different
  // problems with opposite fixes, so they are never added together.
  const thumbEnqueuedAt = new Map<string, number>()
  const thumbStages = new ThumbStageStats()
  let thumbStageTimer: NodeJS.Timeout | null = null
  /** Summarised on a trailing timer rather than per thumbnail: one log line per
   *  burst of scrolling, instead of hundreds. */
  const scheduleStageReport = (): void => {
    if (thumbStageTimer) return
    thumbStageTimer = setTimeout(() => {
      thumbStageTimer = null
      const line = thumbStages.report()
      if (line) diag('thumbs', line)
      thumbStages.reset()
    }, 3000)
  }

  /**
   * Single bounded pump.
   *
   * This replaced a per-request token that aborted the previous batch. That
   * scheme deadlocked: the token was bumped before the in-flight filter ran,
   * so a request whose paths were *all* already in flight did no work of its
   * own yet still cancelled the batch generating exactly those thumbnails.
   * Nothing re-requested them, because the visible set had stopped changing -
   * measured as 107 tiles pending indefinitely while the same files generated
   * in ~1s each when asked for directly.
   */
  async function pumpThumbs(): Promise<void> {
    if (thumbPumping) return
    thumbPumping = true
    try {
      // Two pools over one priority order, because the two kinds of work load
      // the machine in completely different ways.
      //
      // Photo thumbnails run sharp INSIDE this process, on its libuv thread pool,
      // so they compete directly with everything else the main process must do.
      // That is what the earlier measurement was about: four concurrent
      // sharp/ffmpeg operations starved the renderer badly enough to stall
      // main-thread JS for seconds. Their limit stays exactly where it was.
      //
      // Video thumbnails are now a single ffmpeg subprocess with -threads 1 -
      // they used to be ffmpeg plus ffprobe plus an in-process sharp resize of a
      // full-resolution PNG. A subprocess is scheduled by the OS across all cores
      // and touches neither this process's event loop nor its thread pool, so the
      // old shared limit was guarding a cost that no longer exists on this path.
      //
      // It matters because queue WAIT, not decode time, is the bottleneck.
      // Measured on a cold 30-tile viewport: generation averaged 205ms while mean
      // wait was 1559ms and the worst 2981ms. Thirty visible tiles sharing two
      // slots is what leaves visible video sitting as placeholders.
      //
      // Still bounded, and bounded by the machine rather than by a guess.
      const PHOTO_SLOTS = 2
      const VIDEO_SLOTS = Math.min(6, Math.max(2, cpuCount() - 2))
      const isVideoPath = (path: string): boolean =>
        VIDEO_THUMB_EXTS.has(extname(path).toLowerCase())

      const runWorker = async (accept: (path: string) => boolean): Promise<void> => {
        for (;;) {
          if (isQuitting) return
          const p = nextThumb(thumbQueue, accept)
          if (p === undefined) return
          if (thumbInFlight.has(p) || thumbFailed.has(p)) continue
          thumbInFlight.add(p)
          const tPicked = Date.now()
          const waitMs = tPicked - (thumbEnqueuedAt.get(p) ?? tPicked)
          thumbEnqueuedAt.delete(p)
          let lookupMs = 0
          let generateMs = 0
          let writeMs = 0
          let deliverMs = 0
          let cacheHit = false
          let failed = false
          const isVideo = VIDEO_THUMB_EXTS.has(extname(p).toLowerCase())
          try {
            // Shared with the media protocol and file actions, so a tile, a
            // preview and an action all agree on why a path did not resolve.
            const tLookup = Date.now()
            const availability = checkPathAvailability(p)
            lookupMs = Date.now() - tLookup
            if (availability.status !== 'ok') {
              failed = true
              // Anything that can come back on its own - a disconnected drive,
              // a relettered volume, a folder the user can still point us at -
              // is never remembered as failed, or it would stay broken after
              // the situation is fixed. Only a real miss on the right volume
              // is remembered.
              const recoverable =
                availability.status === 'drive-offline' ||
                availability.status === 'volume-mismatch' ||
                availability.status === 'folder-missing'
              if (!recoverable) thumbFailed.add(p)
              const sentinel =
                availability.status === 'folder-missing'
                  ? THUMB_FOLDER_MISSING
                  : availability.status === 'no-access'
                    ? THUMB_NO_ACCESS
                    : recoverable
                      ? THUMB_VOLUME_OFFLINE
                      : THUMB_UNAVAILABLE
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('thumb-ready', { filePath: p, thumbPath: sentinel })
              }
              continue
            }
            // Generated from wherever the original actually is now. A cached
            // thumbnail that has gone missing is regenerated from a readable
            // original rather than marking that original unavailable.
            // A cache hit and a cold generation both come back from here; the
            // difference is whether the file already existed, which is what
            // separates "warm display" from "cold generation" in any measurement.
            const tGen = Date.now()
            const pathVolumeId = getCachedVolumeId(p.slice(0, 2))
            const existedBefore = thumbCacheHit(availability.resolved, pathVolumeId)
            const thumbPath = await generateThumbForFile(
              availability.resolved,
              extname(p).toLowerCase(),
              pathVolumeId
            )
            generateMs = Date.now() - tGen
            cacheHit = existedBefore && thumbPath !== null
            if (thumbPath) {
              // Delivered to the renderer BEFORE being recorded. The tile only
              // needs the path; the catalogue write is bookkeeping, and making
              // the pixels wait for it is what the write stage used to cost.
              const tDeliver = Date.now()
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('thumb-ready', { filePath: p, thumbPath })
              }
              deliverMs = Date.now() - tDeliver
              const tWrite = Date.now()
              updateThumb(p, thumbPath)
              writeMs = Date.now() - tWrite
            } else {
              failed = true
              thumbFailed.add(p)
              // Also remembered on disk. In-memory only meant every launch
              // retried every undecodable file, and the two generation slots
              // went to work already known to be hopeless while visible video
              // waited behind it. Bounded - see MAX_THUMB_ATTEMPTS.
              recordThumbFailure(p)
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('thumb-ready', { filePath: p, thumbPath: THUMB_UNAVAILABLE })
              }
            }
          } catch (err) {
            thumbFailed.add(p)
            recordThumbFailure(p)
            console.error('[thumb:onDemand]', p, err)
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('thumb-ready', { filePath: p, thumbPath: THUMB_UNAVAILABLE })
            }
          } finally {
            thumbStages.add({ waitMs, lookupMs, generateMs, writeMs, deliverMs, cacheHit, failed, video: isVideo })
            scheduleStageReport()
            thumbInFlight.delete(p)
          }
          await new Promise((r) => setImmediate(r))
        }
      }

      await Promise.all([
        ...Array.from({ length: VIDEO_SLOTS }, () => runWorker(isVideoPath)),
        ...Array.from({ length: PHOTO_SLOTS }, () => runWorker((path) => !isVideoPath(path)))
      ])
    } finally {
      thumbPumping = false
      // A request that arrived while the last worker was finishing would have
      // seen thumbPumping true and returned; pick that work up now.
      if (queuedCount(thumbQueue) > 0) void pumpThumbs()
    }
  }

  /**
   * What the grid wants thumbnails for: the tiles on screen, and the band it is
   * scrolling towards. Ordering and bounds live in thumbQueue.ts.
   *
   * Accepts the older bare-array form too, so a renderer from a previous build
   * talking to this main process still gets its visible tiles.
   */
  ipcMain.handle('prioritize-thumbnails', async (_event, raw: unknown) => {
    if (thumbFailed.size > 5000) thumbFailed.clear()
    const payload = Array.isArray(raw)
      ? { visible: raw, prefetch: [] }
      : ((raw ?? {}) as { visible?: unknown; prefetch?: unknown })
    const requested = {
      visible: safePathList(payload.visible, 300),
      prefetch: safePathList(payload.prefetch, 900)
    }
    // Files that have exhausted their attempts never enter the queue, so a
    // screen holding a few undecodable sidecars cannot push decodable video
    // behind them. One indexed lookup for the whole request, not per file.
    const exhausted = exhaustedThumbPaths([...requested.visible, ...requested.prefetch])
    if (exhausted.size > 0) {
      diag('thumbs', `skipped ${exhausted.size} path(s) with exhausted thumbnail attempts`)
    }
    const request = {
      visible: requested.visible.filter((p) => !exhausted.has(p)),
      prefetch: requested.prefetch.filter((p) => !exhausted.has(p))
    }
    thumbQueue = mergeThumbRequest(thumbQueue, request, (p) => thumbInFlight.has(p) || thumbFailed.has(p))
    const queuedNow = Date.now()
    for (const path of [...thumbQueue.visible, ...thumbQueue.prefetch]) {
      if (!thumbEnqueuedAt.has(path)) thumbEnqueuedAt.set(path, queuedNow)
    }
    // Paths the merge dropped must not keep a timestamp alive.
    if (thumbEnqueuedAt.size > 4000) {
      const live = new Set([...thumbQueue.visible, ...thumbQueue.prefetch, ...thumbInFlight])
      for (const key of thumbEnqueuedAt.keys()) if (!live.has(key)) thumbEnqueuedAt.delete(key)
    }
    // The renderer still has to stop showing a spinner for them.
    if (mainWindow && !mainWindow.isDestroyed()) {
      for (const p of exhausted) {
        mainWindow.webContents.send('thumb-ready', { filePath: p, thumbPath: THUMB_UNAVAILABLE })
      }
    }
    void pumpThumbs()
    return []
  })

  // Pick one folder and index just that folder, through the normal library
  // path. Bounded by file count and depth; no drive-wide traversal, and no
  // thumbnail work - those are produced on demand for what is on screen.
  ipcMain.handle('pick-folder', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return null
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a folder to index',
      properties: ['openDirectory']
    })
    if (res.canceled || !res.filePaths.length) return null
    return res.filePaths[0]
  })

  ipcMain.handle('index-folder', async (_event, folder: string, maxFiles?: number) => {
    if (typeof folder !== 'string' || !isSafeLocalPath(folder)) {
      return { ok: false, error: 'unsafe path' }
    }
    if (!fs.existsSync(folder)) return { ok: false, error: 'folder not found' }
    const cap = Math.min(Math.max(Number(maxFiles) || 5000, 1), 20000)
    try {
      const r = await indexFolderBounded(folder, cap)
      sendFilesUpdated(r.drive, 'index-folder')
      // The new records carry a volume id, so refresh the letter map that
      // availability checks read.
      void refreshVolumeCache()
      return { ok: true, ...r }
    } catch (err) {
      console.error('[index-folder]', err)
      return { ok: false, error: String(err) }
    }
  })

  // Keep the letter -> volume map current; everything that resolves a path
  // reads it synchronously, so it must be refreshed when drives come and go.
  void refreshVolumeCache()
  setInterval(() => void refreshVolumeCache(), 30000)

  // The control overlay runs in the mpv window; its clicks and key presses
  // are relayed to the main renderer so there is a single place that decides
  // what each action means.
  ipcMain.on('overlay-action', (_e, action: string) => {
    if (typeof action !== 'string' || action.length > 64) return
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('overlay-action', action)
    }
  })

  // Filename, favourite state, toasts and "reveal the bars" all go the other
  // way: main renderer -> overlay, because the overlay is the only surface
  // that can actually be seen over the video.
  ipcMain.on('overlay-meta', (_e, meta: unknown) => {
    sendToOverlay('overlay-meta', meta)
  })

  ipcMain.on('overlay-interactive', (_e, on: unknown) => {
    setOverlayInteractive(!!on)
  })

  ipcMain.handle('cancel-index-folder', () => {
    cancelFolderIndex()
    return true
  })

  /**
   * Why one file would not paint.
   *
   * The viewer only learns that an <img> or a <video> failed, which is the
   * same event for a deleted original, an unplugged drive, a permission
   * refusal and a file that is present and readable but cannot be decoded.
   * Showing "Failed to load image" for all four sends the user looking for the
   * wrong thing - and in the reported case (Snipping Tool captures under
   * TempState\Snips, which Windows clears) it implied the app had lost a file
   * it never owned.
   *
   * Same resolver the thumbnails and the media protocol use, so a tile, a
   * preview and the viewer cannot disagree about one path. Reports only - it
   * never deletes a record and never copies the file anywhere.
   */
  ipcMain.handle('media-status', (_event, raw: unknown) => {
    const filePath = typeof raw === 'string' ? raw : ''
    if (!isSafeLocalPath(filePath)) return { status: 'missing', volumeKnown: false, resolved: filePath }
    const a = checkPathAvailability(filePath)
    return {
      status: a.status,
      volumeKnown: a.volumeKnown,
      resolved: a.resolved,
      missingRoot: a.missingRoot ?? null
    }
  })

  ipcMain.handle('drive-availability', async () => {
    try {
      return await getDriveAvailability()
    } catch (err) {
      console.error('[drive-availability]', err)
      return []
    }
  })

  ipcMain.handle('favourite-paths', () => {
    try {
      return getFavouritePaths()
    } catch {
      return []
    }
  })

  // ── VAULT / HIDE ──
  ipcMain.handle('hide-files', (_event, filePaths: string[]) => {
    const results: { path: string; ok: boolean }[] = []
    for (const p of safePathList(filePaths)) {
      const r = hideFile(p)
      results.push({ path: p, ok: !!r })
    }
    return results
  })

  ipcMain.handle('unhide-file', (_event, filePath: string, pin: string) => {
    if (!isSafeLocalPath(filePath) || typeof pin !== 'string') return false
    return unhideFile(filePath, pin)
  })

  ipcMain.handle('get-pin', () => getPin())
  ipcMain.handle('set-pin', (_event, pin: string) => {
    setPin(pin)
    return true
  })
  ipcMain.handle('verify-pin', (_event, pin: string) => verifyPin(pin))

  // Copy and move differ only in the filesystem call and how the index row is
  // carried over, so they share one implementation. Both used to open their own
  // better-sqlite3 connection alongside the scanner's, which meant two writers
  // on one WAL database for the duration of a transfer.
  async function transferFiles(
    payload: unknown,
    mode: 'copy' | 'move'
  ): Promise<{ success: string[]; failed: { path: string; error: string }[] }> {
    const { filePaths, destDrive } = (payload ?? {}) as { filePaths?: unknown; destDrive?: unknown }
    const sources = safePathList(filePaths)
    const drive = normalizeDrive(destDrive)
    if (!drive || sources.length === 0) return { success: [], failed: [] }

    const destRoot = `${drive}\\`
    const success: string[] = []
    const failed: { path: string; error: string }[] = []
    let completed = 0

    for (const src of sources) {
      try {
        if (!fs.existsSync(src)) throw new Error('Source file does not exist')
        const dest = getUniqueDestPath(join(destRoot, basename(src)))

        if (mode === 'copy') {
          fs.copyFileSync(src, dest)
          recordCopiedFile(src, dest, drive)
        } else {
          try {
            fs.renameSync(src, dest)
          } catch (renameErr: any) {
            if (renameErr.code !== 'EXDEV') throw renameErr
            fs.copyFileSync(src, dest)
            fs.unlinkSync(src)
          }
          recordMovedFile(src, dest, drive)
        }
        success.push(src)
      } catch (err: any) {
        console.error(`[fs-${mode}] Error on ${src}:`, err)
        failed.push({ path: src, error: err?.message || `${mode} failed` })
      }

      completed++
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('fs-io-progress', {
          completed,
          total: sources.length,
          currentFile: basename(src)
        })
      }
    }

    // The user initiated this, so the destination gallery applies it directly.
    sendFilesUpdated(drive, 'initial')
    return { success, failed }
  }

  ipcMain.handle('fs-copy-paste', (_event, payload) => transferFiles(payload, 'copy'))
  ipcMain.handle('fs-cut-paste', (_event, payload) => transferFiles(payload, 'move'))

  ipcMain.handle('get-video-play-info', async (_event, { filePath, startSecs }: { filePath: string; startSecs?: number }) => {
    if (!isSafeLocalPath(filePath)) throw new Error('Invalid file path')
    const res = resolveMediaFile(filePath)
    if (!res.exists) {
      throw new Error(`File not found: ${filePath}`)
    }
    const targetPath = res.path
    const port = await initStreamServer()
    authorizeStreamPath(targetPath)
    const probe = await probeMedia(targetPath)
    if (probe.isNative) {
      return {
        mode: 'native',
        url: 'media:///' + targetPath.replace(/\\/g, '/'),
        duration: probe.duration
      }
    }
    const queryPath = encodeURIComponent(targetPath)
    const startParam = startSecs && startSecs > 0 ? `&start=${startSecs}` : ''
    const url = `http://127.0.0.1:${port}/stream?path=${queryPath}${startParam}`
    return {
      mode: 'stream',
      url,
      duration: probe.duration,
      isRemux: probe.isRemux
    }
  })

  ipcMain.handle('stop-video-stream', () => {
    killActiveStream()
    return true
  })

  ipcMain.handle('start-mpv', (_event, { filePath, relativeBounds }) => {
    if (!subsystemEnabled(safeMode, 'mpv')) {
      diag('safe-mode', 'mpv start refused (mpv subsystem off)')
      throw new Error('mpv disabled in safe mode')
    }
    if (!isSafeLocalPath(filePath)) throw new Error('Invalid file path')
    const res = resolveMediaFile(filePath)
    if (!res.exists) {
      throw new Error(`File not found on disk: ${filePath}`)
    }
    return initMpv(res.path, relativeBounds, mainWindow)
  })

  ipcMain.on('mpv-command', (_event, { command, args }) => {
    sendMpvCommand(command, args)
  })

  ipcMain.on('mpv-resize', (_event, bounds) => {
    updateMpvBounds(bounds)
  })

  ipcMain.on('mpv-close', () => {
    closeMpv()
  })

  ipcMain.on('start-native-drag', (event, filePaths: string[]) => {
    const validFiles = safePathList(filePaths).filter((p) => fs.existsSync(p))

    if (validFiles.length === 0) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('native-drag-error', {
          error: 'File(s) no longer exist on disk'
        })
      }
      return
    }

    const appPath = app.getAppPath()
    const unpackedPath = appPath.replace('app.asar', 'app.asar.unpacked')
    let iconPath = app.isPackaged
      ? join(unpackedPath, 'resources', 'drag-icon.png')
      : join(appPath, 'resources', 'drag-icon.png')

    if (!fs.existsSync(iconPath)) {
      iconPath = app.isPackaged
        ? join(unpackedPath, 'resources', 'icon.png')
        : join(appPath, 'resources', 'icon.png')
    }

    event.sender.startDrag({
      file: validFiles[0],
      files: validFiles,
      icon: iconPath
    })
  })

  // ── TRANSCODE (improved: parse duration, reliable spawn) ──
  ipcMain.on('transcode-video', async (event, inputPath: string) => {
    if (!isSafeLocalPath(inputPath) || !fs.existsSync(inputPath)) return
    const { createHash } = await import('crypto')
    const hash = createHash('md5').update(inputPath).digest('hex')
    const transcodeDir = join(app.getPath('userData'), 'transcoded')
    if (!fs.existsSync(transcodeDir)) fs.mkdirSync(transcodeDir, { recursive: true })
    const outPath = join(transcodeDir, `${hash}.mp4`)

    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
      event.reply('transcode-done', { inputPath, outPath })
      return
    }

    // Remove partial output if exists
    if (fs.existsSync(outPath)) {
      try {
        fs.unlinkSync(outPath)
      } catch {}
    }

    const ff = spawn(ffmpegExe, [
      '-i',
      inputPath,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '32',
      '-vf',
      'scale=trunc(iw/4)*2:trunc(ih/4)*2',
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      '-threads',
      '2',
      '-tune',
      'fastdecode',
      '-bufsize',
      '1M',
      '-maxrate',
      '4M',
      '-movflags',
      '+faststart',
      '-y',
      outPath
    ])

    let totalSecs = 0
    let stderrBuf = ''

    ff.stderr.on('data', (data: Buffer) => {
      const str = data.toString()
      stderrBuf += str

      // Parse total duration once from header
      if (!totalSecs) {
        const durMatch = stderrBuf.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
        if (durMatch) {
          totalSecs =
            parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3])
        }
      }

      // Parse current time
      const timeMatch = str.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/)
      if (timeMatch) {
        const secs =
          parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3])
        if (mainWindow)
          mainWindow.webContents.send('transcode-progress', { inputPath, secs, totalSecs })
      }
    })

    ff.on('close', (code: number) => {
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
        if (mainWindow) mainWindow.webContents.send('transcode-done', { inputPath, outPath })
      } else {
        console.error('[transcode] failed code=', code, 'stderr:', stderrBuf.slice(-500))
        if (mainWindow) mainWindow.webContents.send('transcode-error', { inputPath })
      }
    })

    ff.on('error', (err) => {
      console.error('[transcode] spawn error', err)
      if (mainWindow) mainWindow.webContents.send('transcode-error', { inputPath })
    })
  })

  // An explicit Quit that runs the same teardown as closing the window:
  // watchers, the indexing timer, mpv and the stream server are all released
  // before the process exits, so nothing is left holding a drive or a decoder.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'File',
        submenu: [
          {
            label: 'Quit DiskFrame',
            accelerator: 'CmdOrCtrl+Q',
            click: () => {
              diag('quit', 'explicit Quit - releasing workers and media processes')
              shutdown()
              app.quit()
            }
          }
        ]
      },
      { label: 'Edit', role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          // Not the built-in togglefullscreen role: that would change the
          // window without updating the app's own record of what the user
          // wants (see appFullscreen).
          { label: 'Toggle Full Screen', accelerator: 'F11', click: () => setAppFullscreen(!appFullscreen) }
        ]
      },
      { label: 'Window', role: 'windowMenu' }
    ])
  )

  if (safeMode.enabled) {
    diag('safe-mode', `ENABLED. sampleFolder=${safeMode.sampleFolder ?? '(none)'} maxFiles=${safeMode.maxFiles} gpu=${safeMode.disableGpu ? 'disabled' : 'on'}`)
    diag('safe-mode', `subsystems allowed: ${safeMode.allow.size ? [...safeMode.allow].join(',') : '(none - window only)'}`)

    if (safeMode.sampleFolder) {
      mainWindow.webContents.once('did-finish-load', () => {
        try {
          const folder = safeMode.sampleFolder as string
          if (!isSafeLocalPath(folder) || !fs.existsSync(folder)) {
            diag('sample', `folder unusable: ${folder}`)
            return
          }
          const t0 = Date.now()
          const { count, skipped } = indexSampleFolder(folder, safeMode.maxFiles)
          diag('sample', `indexed ${count} media files (skipped ${skipped} non-media) from ${folder} in ${Date.now() - t0}ms`)
          // The renderer has to learn which drive it is showing before the file
          // payload arrives, otherwise it discards the payload as belonging to
          // some other drive. It re-requests via get-files once it is ready.
          mainWindow.webContents.send('safe-mode-sample', { drive: SAMPLE_DRIVE_KEY, folder, count })
        } catch (err) {
          diag('sample', `indexing failed: ${err}`)
        }
      })
    }
  }

  // Startup background work is deferred until the window has actually painted.
  // Running the thumbnail and capture-date passes immediately competed with the
  // renderer for CPU during the first seconds after launch - exactly the window
  // the "show cached files fast" target is measured in.
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (isQuitting) return
      // Thumbnails are no longer generated drive-wide at launch. That pass ran
      // across EVERY indexed drive two seconds after the window loaded -
      // before the user had even picked a drive - and spawned sharp/ffmpeg into
      // the exact window the "show cached files fast" target is measured in
      // (measured on this machine: a 475ms main-process stall at launch).
      // Thumbnails for what is on screen come from the viewport pump, and the
      // rest of a volume is backfilled when that volume is opened - scoped to
      // it, and yielding to the viewport. See the open-drive handler.
      const runThumbs = false
      // The capture-date backfill reads every indexed photo and spawns ffprobe
      // for every video - on a 110k-file library that is hours of sustained
      // I/O. It corrects real data, but starting it unannounced on every launch
      // is not something a media browser should do, so it is opt-in via
      // --backfill-capture-dates (or --safe-allow=exif in diagnostic mode).
      const runExif = safeMode.enabled
        ? subsystemEnabled(safeMode, 'exif')
        : process.argv.includes('--backfill-capture-dates')
      diag('startup', `background passes: thumbnails=${runThumbs} exif=${runExif}`)
      if (!runThumbs && !runExif) return
      Promise.resolve()
        .then(() => (runExif && !isQuitting ? enrichExifBackfill(() => isQuitting) : undefined))
        .catch((err) => diag('startup', `background pass failed: ${err}`))
    }, 2000)
  })

  if (subsystemEnabled(safeMode, 'periodic')) {
    driveInterval = setInterval(() => sendDrives(), 3000)
    // A safety net for anything the watcher missed. Cheap: with the folder
    // snapshot this is one stat per known folder, and only changed folders
    // are listed. Replaces a 30-minute pass that stat()ed every indexed file
    // on every known drive.
    setInterval(() => {
      if (currentOpenDrive && !isQuitting) syncService.request(currentOpenDrive, { reason: 'periodic' })
    }, 15 * 60 * 1000)
  } else {
    // The drive list was still sent once above, so the window has something to show.
    diag('safe-mode', 'drive polling and periodic rescan suppressed')
  }
  memoryLogInterval = setInterval(logMemoryMetrics, safeMode.enabled ? 5000 : 20000)

  // After sleep the watcher's handle may be stale and anything could have
  // changed (a laptop's external drive used elsewhere). Re-attach and
  // reconcile once the system has settled - the reconcile itself refuses to
  // remove anything unless the volume is present and verified.
  powerMonitor.on('resume', () => {
    const d = watchWanted
    if (!d || currentOpenDrive !== d) return
    diag('sync', `${d}: system resumed - re-attaching watcher and reconciling`)
    watcherManager.unwatchDrive(d)
    invalidateMountedVolumes()
    setTimeout(() => {
      if (isQuitting || currentOpenDrive !== d || !fs.existsSync(catalogueRoot(d))) return
      attachWatcherFor(d)
      syncService.request(d, { reason: 'resume' })
    }, 3000)
  })

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

function shutdown(): void {
  isQuitting = true
  watcherManager.closeAll()
  syncService.cancel()
  closeMpv()
  closeStreamServer()
  if (driveInterval) {
    clearInterval(driveInterval)
    driveInterval = null
  }
  if (memoryLogInterval) {
    clearInterval(memoryLogInterval)
    memoryLogInterval = null
  }
}

app.on('before-quit', shutdown)
app.on('will-quit', shutdown)
app.on('window-all-closed', () => {
  shutdown()
  if (process.platform !== 'darwin') app.quit()
})

export { generateThumbForFile, updateThumb, probeMedia, initStreamServer, killActiveStream, closeStreamServer }

