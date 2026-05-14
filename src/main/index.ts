import { app, shell, BrowserWindow, ipcMain, protocol } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { getDiskInfo } from 'node-disk-info'
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

let mainWindow: BrowserWindow
let driveInterval: ReturnType<typeof setInterval> | null = null

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: { secure: true, supportFetchAPI: true, bypassCSP: true, stream: true }
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
  protocol.registerFileProtocol('media', (request, callback) => {
    try {
      const urlWithoutQuery = request.url.split('?')[0]
      const withoutScheme = urlWithoutQuery.replace('media:///', '')
      const decoded = decodeURIComponent(withoutScheme)
      // Handle both Windows absolute paths (C:/...) and relative
      const filePath = decoded.replace(/\//g, '\\')
      callback({ path: filePath })
    } catch (e) {
      console.error('[media protocol error]', e)
      callback({ error: -2 })
    }
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
