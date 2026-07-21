import { app, shell, BrowserWindow, ipcMain, protocol, net } from 'electron'
import { join } from 'path'
import { spawn } from 'child_process'
import * as fs from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { getDiskInfo } from 'node-disk-info'
import ffmpegPath from 'ffmpeg-static'
import {
  scanDrive,
  getGroupedFiles,
  toggleFavourite,
  getFavourites,
  getFileCount,
  getFilesWithoutThumbs,
  generateThumbForFile,
  updateThumb,
  hideFile,
  unhideFile,
  getPin,
  setPin,
  verifyPin,
  getSkipConfirm,
  setSkipConfirm,
  getTrashedFiles,
  getTrashCount,
  softDeleteFiles,
  restoreFiles,
  deleteFilesPermanently,
  emptyTrash,
  autoPurgeTrash
} from './scanner'
import Database from 'better-sqlite3'

const ffmpegExe = ffmpegPath ? ffmpegPath.replace('app.asar', 'app.asar.unpacked') : 'ffmpeg'

let mainWindow: BrowserWindow
let driveInterval: ReturnType<typeof setInterval> | null = null

// Re-open sqlite db to query status for sync
const dbPath = join(app.getPath('userData'), 'diskframe.db')

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
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webSecurity: false
    }
  })
  mainWindow.on('ready-to-show', () => mainWindow.show())
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

async function sendDrives(): Promise<void> {
  try {
    const disks = await getDiskInfo()
    const drives = disks.map((disk) => ({
      name: disk.mounted,
      filesystem: disk.filesystem,
      total: Math.round(disk.blocks / 1024 / 1024 / 1024),
      used: Math.round((disk.blocks - disk.available) / 1024 / 1024 / 1024),
      free: Math.round(disk.available / 1024 / 1024 / 1024)
    }))
    if (mainWindow) mainWindow.webContents.send('drives-updated', drives)
  } catch (err) {
    console.error('Error getting disk info:', err)
  }
}

async function generateThumbsForDrive(drivePath: string): Promise<void> {
  const files = getFilesWithoutThumbs(drivePath)
  for (const file of files) {
    const thumbPath = await generateThumbForFile(file.path, file.ext)
    if (thumbPath && mainWindow && !mainWindow.isDestroyed()) {
      updateThumb(file.path, thumbPath)
      mainWindow.webContents.send('thumb-ready', { filePath: file.path, thumbPath })
    }
  }
}

app.whenReady().then(() => {
  // Run auto-purge on startup
  try {
    autoPurgeTrash()
  } catch (err) {
    console.error('Error running auto-purge on startup:', err)
  }

  protocol.handle('media', (request) => {
    const url = request.url.replace('media:///', '')
    const filePath = decodeURIComponent(url).replace(/\//g, '\\')
    return net.fetch('file:///' + filePath.replace(/\\/g, '/'))
  })

  electronApp.setAppUserModelId('com.electron')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // ── DRIVE / SCAN ──
  ipcMain.on('get-drives', () => sendDrives())
  ipcMain.on('reveal-file', (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
  })
  ipcMain.on('open-file', (_event, filePath: string) => {
    shell.openPath(filePath)
  })

  ipcMain.on('scan-drive', async (_event, drivePath: string) => {
    const existing = getFileCount(drivePath)
    if (existing > 0) {
      if (mainWindow)
        mainWindow.webContents.send('scan-complete', { count: existing, drive: drivePath })
      generateThumbsForDrive(drivePath)
      return
    }
    const { homedir } = await import('os')
    const scanPath = drivePath === 'C:' ? homedir() : drivePath
    let count = 0
    // Pass 1 completes fast (sync walk, no EXIF) — sends scan-complete immediately
    // Pass 2 (EXIF enrichment) runs in background, sends exif-progress
    await scanDrive(
      drivePath,
      scanPath,
      (progress) => {
        count = progress
        if (mainWindow) mainWindow.webContents.send('scan-progress', { count, drive: drivePath })
      },
      (enriched, total) => {
        if (mainWindow)
          mainWindow.webContents.send('exif-progress', { enriched, total, drive: drivePath })
      }
    )
    if (mainWindow) mainWindow.webContents.send('scan-complete', { count, drive: drivePath })
    generateThumbsForDrive(drivePath)
  })

  ipcMain.on('rescan-drive', async (_event, drivePath: string) => {
    const { homedir } = await import('os')
    const scanPath = drivePath === 'C:' ? homedir() : drivePath
    let count = 0
    await scanDrive(
      drivePath,
      scanPath,
      (progress) => {
        count = progress
        if (mainWindow) mainWindow.webContents.send('scan-progress', { count, drive: drivePath })
      },
      (enriched, total) => {
        if (mainWindow)
          mainWindow.webContents.send('exif-progress', { enriched, total, drive: drivePath })
      }
    )
    if (mainWindow) mainWindow.webContents.send('scan-complete', { count, drive: drivePath })
    generateThumbsForDrive(drivePath)
  })

  ipcMain.on('get-files', (_event, drivePath: string) => {
    const grouped = getGroupedFiles(drivePath)
    if (mainWindow) mainWindow.webContents.send('files-updated', grouped)
  })

  ipcMain.on('toggle-favourite', (_event, filePath: string) => {
    toggleFavourite(filePath)
    // Instantly query the new favourited status and send as a payload to avoid double-toggles
    const db = new Database(dbPath)
    const row = db.prepare('SELECT favourited FROM files WHERE path = ?').get(filePath) as { favourited: number } | undefined
    db.close()
    const isFav = (row?.favourited ?? 0) === 1
    if (mainWindow) mainWindow.webContents.send('favourite-toggled', { filePath, isFav })
  })

  ipcMain.on('get-favourites', () => {
    const files = getFavourites()
    if (mainWindow) mainWindow.webContents.send('favourites-updated', files)
  })

  // ── SOFT DELETE (TRASH) ──
  ipcMain.handle('delete-files', (_event, filePaths: string[]) => {
    softDeleteFiles(filePaths)
    return { success: filePaths, failed: [] }
  })

  // ── TRASH IPC HANDLERS ──
  ipcMain.handle('restore-files', (_event, filePaths: string[]) => {
    restoreFiles(filePaths)
    return { success: true }
  })

  ipcMain.handle('delete-files-permanently', (_event, filePaths: string[]) => {
    return deleteFilesPermanently(filePaths)
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

  // ── VAULT / HIDE ──
  ipcMain.handle('hide-files', (_event, filePaths: string[]) => {
    const results: { path: string; ok: boolean }[] = []
    for (const p of filePaths) {
      const r = hideFile(p)
      results.push({ path: p, ok: !!r })
    }
    return results
  })

  ipcMain.handle('unhide-file', (_event, filePath: string, pin: string) => {
    return unhideFile(filePath, pin)
  })

  ipcMain.handle('get-pin', () => getPin())
  ipcMain.handle('set-pin', (_event, pin: string) => {
    setPin(pin)
    return true
  })
  ipcMain.handle('verify-pin', (_event, pin: string) => verifyPin(pin))

  // ── TRANSCODE (improved: parse duration, reliable spawn) ──
  ipcMain.on('transcode-video', async (event, inputPath: string) => {
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

  createWindow()
  driveInterval = setInterval(() => sendDrives(), 3000)
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (driveInterval) clearInterval(driveInterval)
  if (process.platform !== 'darwin') app.quit()
})
