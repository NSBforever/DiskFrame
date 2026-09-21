import { app, shell, BrowserWindow, ipcMain, protocol, net, crashReporter, Menu } from 'electron'
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
  SAMPLE_DRIVE_KEY
} from './scanner'

import { initStreamServer, probeMedia, killActiveStream, closeStreamServer, authorizeStreamPath } from './streamServer'
import { initMpv, sendMpvCommand, updateMpvBounds, closeMpv, refreshMpvBounds } from './mpvManager'
import { WatcherManager } from './watcher'
import { IndexingService } from './indexingService'
import { normalizeDrive, isSafeLocalPath, safePathList } from './validation'
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
function sendFilesUpdated(drive: string, reason: 'initial' | 'background'): void {
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
let driveConnectionCache: Record<string, 'internal' | 'external' | 'unknown'> = {}
let knownDriveLetters: Set<string> = new Set()

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

function classifyDriveConnections(letters: string[]): Promise<Record<string, 'internal' | 'external' | 'unknown'>> {
  return new Promise((resolve) => {
    if (letters.length === 0) return resolve({})
    const { exec } = require('child_process')
    const list = letters.map((l) => l.replace(/:$/, '')).join(',')
    const psCommand = `
      $letters = '${list}'.Split(',')
      $letters | ForEach-Object {
        $dl = $_
        try {
          $phys = Get-Partition -DriveLetter $dl -ErrorAction Stop | Get-Disk -ErrorAction Stop | Get-PhysicalDisk -ErrorAction Stop
          [PSCustomObject]@{ DriveLetter = $dl; BusType = $phys.BusType.ToString() }
        } catch {
          [PSCustomObject]@{ DriveLetter = $dl; BusType = 'Unknown'; Err = $_.Exception.Message }
        }
      } | ConvertTo-Json
    `
    exec(
      // PowerShell uses newlines as statement separators - flattening to a
      // single line for exec() needs ';', not ' ', or every statement here
      // runs together into a syntax error. This was silently failing on every
      // call (caught by the outer !err check below), so the classification
      // cache never populated and every drive fell back to 'unknown'.
      `powershell -NoProfile -Command "${psCommand.replace(/\n/g, '; ')}"`,
      { timeout: 8000 },
      (err: any, stdout: string, stderr: string) => {
        const result: Record<string, 'internal' | 'external' | 'unknown'> = {}
        if (err) {
          console.error('[classifyDriveConnections] PowerShell call failed:', err.message, stderr)
        } else if (stdout) {
          try {
            const parsed = JSON.parse(stdout)
            const items = Array.isArray(parsed) ? parsed : [parsed]
            for (const item of items) {
              const letter = `${String(item.DriveLetter).toUpperCase()}:`
              if (item.Err) console.warn(`[classifyDriveConnections] ${letter} lookup failed: ${item.Err}`)
              result[letter] = classifyBusType(item.BusType)
            }
          } catch (parseErr) {
            console.error('[classifyDriveConnections] Failed to parse PowerShell output:', parseErr, stdout)
          }
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
      driveConnectionCache = await classifyDriveConnections(letters)
    }

    const drivesWithType = drives.map((d) => ({
      ...d,
      connectionType: driveConnectionCache[d.name.slice(0, 2).toUpperCase()] || 'unknown'
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
        updateThumb(file.path, 'NO_FILE')
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
  ipcMain.handle('prioritize-thumbnails', async (_event, rawPaths: string[]) => {
    // One screen's worth. A caller asking for thousands is not describing
    // anything that is actually visible.
    const paths = safePathList(rawPaths, 200)
    const results: (string | null)[] = new Array(paths.length).fill(null)
    const CONCURRENCY = 2
    let cursor = 0
    async function worker(): Promise<void> {
      while (cursor < paths.length) {
        const i = cursor++
        const p = paths[i]
        if (!fs.existsSync(p)) continue
        const thumbPath = await generateThumbForFile(p, extname(p).toLowerCase())
        if (thumbPath) {
          updateThumb(p, thumbPath)
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('thumb-ready', { filePath: p, thumbPath })
          }
        }
        results[i] = thumbPath
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
    return results
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


