import { app, shell, BrowserWindow, ipcMain, protocol, net, crashReporter, Menu, dialog } from 'electron'
import { join, basename, extname, dirname } from 'path'
import { spawn } from 'child_process'
import * as fs from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { getDiskInfo } from 'node-disk-info'
import ffmpegPath from 'ffmpeg-static'
import {
  spawnScanUtilityProcess,
  ScannedFile,
  getGroupedFiles,
  toggleFavourite,
  getFavourites,
  getFileCount,
  getFileCountsByDrive,
  getAllFilesWithoutThumbs,
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
  refreshVolumeCache,

  getFavouritePaths
} from './scanner'
import type { LibraryQuery } from './libraryQuery'

import { initStreamServer, probeMedia, killActiveStream, closeStreamServer, authorizeStreamPath } from './streamServer'
import { initMpv, sendMpvCommand, updateMpvBounds, closeMpv, refreshMpvBounds, setOverlayInteractive, sendToOverlay } from './mpvManager'
import { WatcherManager } from './watcher'
import { IndexingService } from './indexingService'
import { normalizeDrive, isSafeLocalPath, safePathList, THUMB_UNAVAILABLE, THUMB_VOLUME_OFFLINE } from './validation'
import { parseSafeMode, subsystemEnabled } from './runtimeMode'

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
const indexingService = new IndexingService()

const ffmpegExe = ffmpegPath ? ffmpegPath.replace('app.asar', 'app.asar.unpacked') : 'ffmpeg'

let mainWindow: BrowserWindow
let driveInterval: ReturnType<typeof setInterval> | null = null
let memoryLogInterval: ReturnType<typeof setInterval> | null = null
// Long-running background passes (thumbnails, capture dates) poll this so they
// stop promptly on quit instead of holding the process alive mid-file.
let isQuitting = false

// Per-process memory, logged periodically so a reported "app uses N GB" can be
// traced to a specific process (renderer/GPU/main/utility) instead of guessed at.
function logMemoryMetrics(): void {
  const metrics = app.getAppMetrics()
  const parts = metrics
    .map((m) => `${m.type}${m.type === 'Utility' ? `(${m.name ?? m.serviceName ?? '?'})` : ''}=${Math.round(m.memory.workingSetSize / 1024)}MB`)
    .join(' ')
  const total = metrics.reduce((sum, m) => sum + m.memory.workingSetSize, 0)
  console.log(`[memory] total=${Math.round(total / 1024)}MB | ${parts}`)
}

// Every files-updated payload says which drive it describes and whether the
// user asked for it. The renderer applies 'initial' immediately and offers
// 'background' as a refresh, so an unrelated drive's sync can neither replace
// the open gallery nor rearrange it mid-scroll.
function sendFilesUpdated(drive: string, reason: 'initial' | 'background' | 'index-folder'): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('files-updated', {
    drive,
    groups: getGroupedFiles(drive),
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webSecurity: false,
      webviewTag: true
    }
  })
  watcherManager.setMainWindow(mainWindow)
  indexingService.setMainWindow(mainWindow)
  mainWindow.setBackgroundColor('#00000000')
  mainWindow.on('ready-to-show', () => mainWindow.show())
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

function getDrivesPowerShell(): Promise<Array<{ name: string; filesystem: string; total: number; used: number; free: number }>> {
  return new Promise((resolve) => {
    const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, FileSystem, Size, FreeSpace | ConvertTo-Json"`
    const { exec } = require('child_process')
    exec(cmd, (err: any, stdout: string) => {
      if (err || !stdout) return resolve([])
      try {
        const parsed = JSON.parse(stdout)
        const items = Array.isArray(parsed) ? parsed : [parsed]
        const drives = items
          .filter((d: any) => d.Size && d.DeviceID)
          .map((d: any) => {
            const totalGB = Math.round(Number(d.Size) / (1024 * 1024 * 1024))
            const freeGB = Math.round(Number(d.FreeSpace) / (1024 * 1024 * 1024))
            const usedGB = Math.max(0, totalGB - freeGB)
            return {
              name: d.DeviceID,
              filesystem: d.FileSystem || 'NTFS',
              total: totalGB,
              used: usedGB,
              free: freeGB
            }
          })
        resolve(drives)
      } catch {
        resolve([])
      }
    })
  })
}

// Connection type (internal/external) is a physical-disk property, not a
// per-poll one - it only changes when a drive is actually plugged/unplugged.
// Cached by drive letter so the (multi-CIM-call) classification query only
// re-runs when the set of mounted letters changes, not on every 3s poll.
let driveHardwareCache: Record<string, DriveHardware> = {}
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
  volumeId: string | null
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
      `  $v = Get-CimInstance Win32_Volume | Where-Object { $_.DriveLetter -eq ($dl + ':') }`,
      `  if ($v) {`,
      `    if ($v.SerialNumber) { $vol = [string]$v.SerialNumber }`,
      `    elseif ($v.DeviceID) { $vol = [string]$v.DeviceID }`,
      `  }`,
      `  $out += [PSCustomObject]@{ DriveLetter = $dl; BusType = $bus; MediaType = $media; Model = $model; VolumeId = $vol; Err = $err }`,
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
              model: item.Model ? String(item.Model) : null,
              volumeId: item.VolumeId ? String(item.VolumeId) : null
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

async function sendDrives(): Promise<void> {
  try {
    let drives: Array<{ name: string; filesystem: string; total: number; used: number; free: number }> = []
    try {
      const disks = await getDiskInfo()
      drives = disks.map((disk) => ({
        name: disk.mounted,
        filesystem: disk.filesystem,
        total: Math.round(disk.blocks / 1024 / 1024 / 1024),
        used: Math.round((disk.blocks - disk.available) / 1024 / 1024 / 1024),
        free: Math.round(disk.available / 1024 / 1024 / 1024)
      }))
    } catch {
      drives = await getDrivesPowerShell()
    }

    const letters = drives.map((d) => d.name.slice(0, 2).toUpperCase())
    const currentSet = new Set(letters)
    const sameSet =
      currentSet.size === knownDriveLetters.size && [...currentSet].every((l) => knownDriveLetters.has(l))
    if (!sameSet) {
      knownDriveLetters = currentSet
      driveHardwareCache = await queryDriveHardware(letters)
    }

    const drivesWithType = drives.map((d) => ({
      ...d,
      ...(() => {
        const hw = driveHardwareCache[d.name.slice(0, 2).toUpperCase()]
        return {
          connectionType: hw?.connection ?? 'unknown',
          mediaType: hw?.media ?? 'unknown',
          model: hw?.model ?? null,
          volumeId: hw?.volumeId ?? null
        }
      })()
    }))

    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('drives-updated', drivesWithType)
  } catch (err) {
    console.error('Error getting disk info:', err)
  }
}

async function generateThumbsForDrive(_drivePath: string): Promise<void> {
  await backfillAllMissingThumbnails()
}

async function backfillAllMissingThumbnails(): Promise<void> {
  let files: ScannedFile[] = []
  try {
    files = getAllFilesWithoutThumbs()
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
        const thumbPath = await generateThumbForFile(file.path, file.ext)
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
}

app.whenReady().then(() => {
  if (!gotLock) return

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
  // One-time (idempotent) cleanup of index rows for the app's own generated
  // thumbnails and cache files. Rows only - nothing on disk is removed.
  try {
    clearThumbSentinels()
    const purged = purgeGeneratedAssetRows()
    if (purged.removed > 0) diag('purge', `removed ${purged.removed} generated-asset rows of ${purged.scanned} scanned`)
  } catch (err) {
    console.error('[purge] failed', err)
  }

  // Auto-purge permanently deletes trashed files older than 30 days. A
  // diagnostic session must never destroy anything, so it stays off there.
  if (safeMode.enabled) {
    diag('safe-mode', 'startup trash auto-purge suppressed (no destructive work in diagnostic mode)')
  } else {
    try {
      autoPurgeTrash()
    } catch (err) {
      console.error('Error running auto-purge on startup:', err)
    }
  }
  protocol.handle('media', async (request) => {
    const url = request.url.replace('media:///', '')
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
  ipcMain.on('get-drives', () => sendDrives())
  ipcMain.handle('get-drive-file-counts', () => getFileCountsByDrive())

  // Queried by the renderer on mount rather than pushed once at load time.
  // The push could be missed if the renderer subscribed after it fired, which
  // is how a diagnostic session ended up looking like a normal one showing an
  // empty library.
  ipcMain.handle('get-runtime-mode', () => ({
    safeMode: safeMode.enabled,
    allowed: [...safeMode.allow],
    sampleFolder: safeMode.sampleFolder,
    userDataPath: app.getPath('userData'),
    isDefaultUserData: app.getPath('userData').toLowerCase() === join(app.getPath('appData'), 'diskframe').toLowerCase()
  }))
  ipcMain.on('reveal-file', (_event, filePath: string) => {
    if (isSafeLocalPath(filePath)) shell.showItemInFolder(filePath)
  })
  ipcMain.on('open-file', (_event, filePath: string) => {
    if (isSafeLocalPath(filePath)) shell.openPath(filePath)
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
        mainWindow.webContents.send('scan-complete', { count: getFileCount(drivePath), drive: drivePath })
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
      if (subsystemEnabled(safeMode, 'watcher')) {
        watcherManager.watchDrive(scanPath)
      } else {
        diag('safe-mode', `watcher suppressed for ${scanPath}`)
      }

      if (!opts.forceFull && getFileCount(drivePath) > 0) {
        const incResult = await incrementalSyncDrive(drivePath, (progress) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('scan-progress', { count: progress, drive: drivePath })
          }
        })
        if (!incResult.fullScanNeeded) {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('scan-complete', { count: incResult.count, drive: drivePath })
          }
          sendFilesUpdated(drivePath, 'background')
          generateThumbsForDrive(drivePath)
          return
        }
      }

      let count = 0
      await spawnScanUtilityProcess(
        drivePath,
        scanPath,
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
  ipcMain.on('open-drive', (_event, drivePath: string) => {
    const drive = normalizeDrive(drivePath)
    if (!drive) return
    const indexed = getFileCount(drive)
    const t0 = Date.now()
    sendFilesUpdated(drive, 'initial')
    diag('open-drive', `${drive}: served ${indexed} cached records in ${Date.now() - t0}ms (no scan, no stat)`)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('drive-opened', {
        drive,
        indexed,
        // A drive with no records needs a first scan, but the user asks for it.
        needsInitialScan: indexed === 0
      })
    }
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
      nav: (navs.includes(String(q.nav)) ? q.nav : 'all') as LibraryQuery['nav'],
      search: typeof q.search === 'string' ? q.search.slice(0, 200) : '',
      groupBy: (groups.includes(String(q.groupBy)) ? q.groupBy : 'day') as LibraryQuery['groupBy'],
      order: q.order === 'reverse' ? 'reverse' : 'default'
    }
  }

  ipcMain.handle('library-summary', (_event, raw) => {
    const q = normalizeQuery(raw)
    if (!q) return { total: 0, groups: [] }
    const t0 = Date.now()
    const res = getLibrarySummary(q)
    diag('library', `summary ${q.drive}/${q.nav}/${q.groupBy}: ${res.total} files in ${res.groups.length} groups (${Date.now() - t0}ms)`)
    return res
  })

  ipcMain.handle('library-page', (_event, raw) => {
    const { query, offset, limit } = (raw ?? {}) as { query?: unknown; offset?: number; limit?: number }
    const q = normalizeQuery(query)
    if (!q) return { offset: 0, rows: [] }
    const from = Math.max(0, Math.floor(Number(offset) || 0))
    const size = Math.max(1, Math.min(Math.floor(Number(limit) || 100), MAX_PAGE_SIZE))
    const rows = getLibraryPage(q, from, size)
    return { offset: from, rows }
  })

  // Explicit reconciliation. Never triggered by opening a drive.
  ipcMain.on('reconcile-drive', (_event, drivePath: string) => {
    runScan(drivePath, { forceFull: false }).catch((err) => diag('reconcile', String(err)))
  })

  ipcMain.on('scan-drive', (_event, drivePath: string) => {
    runScan(drivePath, { forceFull: false }).catch((err) => console.error('[scan-drive]', err))
  })

  ipcMain.on('rescan-drive', (_event, drivePath: string) => {
    runScan(drivePath, { forceFull: true }).catch((err) => console.error('[rescan-drive]', err))
  })

  ipcMain.handle('incremental-sync-drive', async (_event, drivePath: string) => {
    const drive = normalizeDrive(drivePath)
    if (!drive) return { fullScanNeeded: false, count: 0 }
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

  ipcMain.on('toggle-favourite', (_event, filePath: string) => {
    if (!isSafeLocalPath(filePath)) return
    // Reads back through the scanner's existing connection. Opening a second
    // better-sqlite3 handle per toggle meant a fresh WAL attach, page cache and
    // teardown for a single-row read, on the main thread, per click.
    const isFav = toggleFavourite(filePath)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('favourite-toggled', { filePath, isFav })
    }
  })

  ipcMain.on('get-favourites', () => {
    const files = getFavourites()
    if (mainWindow) mainWindow.webContents.send('favourites-updated', files)
  })

  // ── SOFT DELETE (TRASH) ──
  ipcMain.handle('delete-files', (_event, filePaths: string[]) => {
    const paths = safePathList(filePaths)
    softDeleteFiles(paths)
    return { success: paths, failed: [] }
  })

  // ── TRASH IPC HANDLERS ──
  ipcMain.handle('restore-files', (_event, filePaths: string[]) => {
    restoreFiles(safePathList(filePaths))
    return { success: true }
  })

  ipcMain.handle('delete-files-permanently', (_event, filePaths: string[]) => {
    return deleteFilesPermanently(safePathList(filePaths))
  })

  ipcMain.handle('empty-trash', () => {
    return emptyTrash()
  })

  ipcMain.handle('get-trashed-files', () => {
    return getTrashedFiles()
  })

  ipcMain.handle('get-trash-count', () => {
    return getTrashCount()
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
  // Pending viewport work. A new request REPLACES this - work for a screen the
  // user has scrolled past is dropped - but never touches what is already
  // being generated.
  let thumbPending: string[] = []
  let thumbPumping = false

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
      const CONCURRENCY = 2
      const workers = Array.from({ length: CONCURRENCY }, async () => {
        for (;;) {
          if (isQuitting) return
          const p = thumbPending.shift()
          if (p === undefined) return
          if (thumbInFlight.has(p) || thumbFailed.has(p)) continue
          thumbInFlight.add(p)
          try {
            // Shared with the media protocol and file actions, so a tile, a
            // preview and an action all agree on why a path did not resolve.
            const availability = checkPathAvailability(p)
            if (availability.status !== 'ok') {
              // An offline or relettered volume may come back, so it is never
              // remembered as failed - only a real miss on the right volume is.
              const recoverable =
                availability.status === 'drive-offline' || availability.status === 'volume-mismatch'
              if (!recoverable) thumbFailed.add(p)
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('thumb-ready', {
                  filePath: p,
                  thumbPath: recoverable ? THUMB_VOLUME_OFFLINE : THUMB_UNAVAILABLE
                })
              }
              continue
            }
            const thumbPath = await generateThumbForFile(p, extname(p).toLowerCase())
            if (thumbPath) {
              updateThumb(p, thumbPath)
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('thumb-ready', { filePath: p, thumbPath })
              }
            } else {
              thumbFailed.add(p)
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('thumb-ready', { filePath: p, thumbPath: THUMB_UNAVAILABLE })
              }
            }
          } catch (err) {
            thumbFailed.add(p)
            console.error('[thumb:onDemand]', p, err)
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('thumb-ready', { filePath: p, thumbPath: THUMB_UNAVAILABLE })
            }
          } finally {
            thumbInFlight.delete(p)
          }
          await new Promise((r) => setImmediate(r))
        }
      })
      await Promise.all(workers)
    } finally {
      thumbPumping = false
      // A request that arrived while the last worker was finishing would have
      // seen thumbPumping true and returned; pick that work up now.
      if (thumbPending.length > 0) void pumpThumbs()
    }
  }

  /** Newest viewport first, everything still owed behind it, nothing dropped. */
  const MAX_PENDING = 600
  ipcMain.handle('prioritize-thumbnails', async (_event, rawPaths: string[]) => {
    // One screen plus a small buffer. A caller asking for thousands is not
    // describing anything that is actually visible.
    const paths = safePathList(rawPaths, 200)
    if (thumbFailed.size > 5000) thumbFailed.clear()
    // Merge rather than replace. Replacing meant a later request silently
    // discarded whatever it displaced, and since the grid only re-requests
    // when the visible set *changes*, those tiles were never asked for again -
    // measured as a plateau with 52 tiles still pending on a settled screen.
    const wanted = paths.filter((p) => !thumbInFlight.has(p) && !thumbFailed.has(p))
    const merged = [...wanted, ...thumbPending.filter((p) => !wanted.includes(p))]
    thumbPending = merged.slice(0, MAX_PENDING)
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
      { label: 'View', role: 'viewMenu' },
      { label: 'Window', role: 'windowMenu' }
    ])
  )

  createWindow()

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
      const runThumbs = subsystemEnabled(safeMode, 'thumbnails')
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
        .then(() => (runThumbs ? backfillAllMissingThumbnails() : undefined))
        .then(() => (runExif && !isQuitting ? enrichExifBackfill(() => isQuitting) : undefined))
        .catch((err) => diag('startup', `background pass failed: ${err}`))
    }, 2000)
  })

  if (subsystemEnabled(safeMode, 'periodic')) {
    driveInterval = setInterval(() => sendDrives(), 3000)
    indexingService.start()
  } else {
    diag('safe-mode', 'drive polling and periodic rescan suppressed')
    // The drive list is still sent once, so the window has something to show.
    sendDrives()
  }
  memoryLogInterval = setInterval(logMemoryMetrics, safeMode.enabled ? 5000 : 20000)

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

function shutdown(): void {
  isQuitting = true
  watcherManager.closeAll()
  indexingService.stop()
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

