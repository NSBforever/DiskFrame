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
  updateThumb
} from './scanner'

const ffmpegExe = ffmpegPath
  ? ffmpegPath.replace('app.asar', 'app.asar.unpacked')
  : 'ffmpeg'

let mainWindow: BrowserWindow
let driveInterval: ReturnType<typeof setInterval> | null = null

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
  // Electron 25+ streaming protocol handler — supports range requests for video
  protocol.handle('media', (request) => {
    const url = request.url.replace('media:///', '')
    const filePath = decodeURIComponent(url).replace(/\//g, '\\')
    return net.fetch('file:///' + filePath.replace(/\\/g, '/'))
  })

  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

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
    await scanDrive(drivePath, scanPath, (progress) => {
      count = progress
      if (mainWindow) mainWindow.webContents.send('scan-progress', { count, drive: drivePath })
    })
    if (mainWindow) mainWindow.webContents.send('scan-complete', { count, drive: drivePath })
    generateThumbsForDrive(drivePath)
  })

  ipcMain.on('rescan-drive', async (_event, drivePath: string) => {
    const { homedir } = await import('os')
    const scanPath = drivePath === 'C:' ? homedir() : drivePath
    let count = 0
    await scanDrive(drivePath, scanPath, (progress) => {
      count = progress
      if (mainWindow) mainWindow.webContents.send('scan-progress', { count, drive: drivePath })
    })
    if (mainWindow) mainWindow.webContents.send('scan-complete', { count, drive: drivePath })
    generateThumbsForDrive(drivePath)
  })

  ipcMain.on('get-files', (_event, drivePath: string) => {
    const grouped = getGroupedFiles(drivePath)
    if (mainWindow) mainWindow.webContents.send('files-updated', grouped)
  })

  ipcMain.on('toggle-favourite', (_event, filePath: string) => {
    toggleFavourite(filePath)
    if (mainWindow) mainWindow.webContents.send('favourite-toggled', filePath)
  })

  ipcMain.on('get-favourites', () => {
    const files = getFavourites()
    if (mainWindow) mainWindow.webContents.send('favourites-updated', files)
  })

  // On-demand MOV/AVI/MKV → MP4 transcoding — non-blocking, streams progress back
  ipcMain.on('transcode-video', async (event, inputPath: string) => {
    const { createHash } = await import('crypto')
    const hash = createHash('md5').update(inputPath).digest('hex')
    const transcodeDir = join(app.getPath('userData'), 'transcoded')
    if (!fs.existsSync(transcodeDir)) fs.mkdirSync(transcodeDir, { recursive: true })
    const outPath = join(transcodeDir, `${hash}.mp4`)

    // Already transcoded — reply immediately
    if (fs.existsSync(outPath)) {
      event.reply('transcode-done', { inputPath, outPath })
      return
    }

    const ff = spawn(ffmpegExe, [
      '-i', inputPath,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
      '-c:a', 'aac', '-b:a', '96k',
      '-movflags', '+faststart',
      '-y', outPath
    ])

    // Send progress updates
    ff.stderr.on('data', (data: Buffer) => {
      const str = data.toString()
      const match = str.match(/time=(\d+):(\d+):(\d+)/)
      if (match) {
        const secs = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3])
        if (mainWindow) mainWindow.webContents.send('transcode-progress', { inputPath, secs })
      }
    })

    ff.on('close', (code: number) => {
      if (code === 0 && fs.existsSync(outPath)) {
        if (mainWindow) mainWindow.webContents.send('transcode-done', { inputPath, outPath })
      } else {
        if (mainWindow) mainWindow.webContents.send('transcode-error', { inputPath })
      }
    })

    ff.on('error', () => {
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
