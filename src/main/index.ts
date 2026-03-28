import { app, shell, BrowserWindow, ipcMain, protocol, net } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { unlinkSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { getDiskInfo } from 'node-disk-info'
import {
  scanDrive,
  getGroupedFiles,
  clearDrive,
  isDriveScanned,
  getFileCount,
  generateThumb,
  getThumbPath,
} from './scanner'

let mainWindow: BrowserWindow

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'localfile',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true,
    },
  },
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
      webSecurity: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

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
      free: Math.round(disk.available / 1024 / 1024 / 1024),
    }))
    if (mainWindow) {
      mainWindow.webContents.send('drives-updated', drives)
    }
  } catch (err) {
    console.error('Error getting disk info:', err)
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  protocol.handle('localfile', (request) => {
    let filePath = decodeURIComponent(request.url.slice('localfile:///'.length))
    if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(filePath)) {
      filePath = filePath.slice(1)
    }
    return net.fetch(pathToFileURL(filePath).toString())
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.on('get-drives', () => {
    sendDrives()
  })

  ipcMain.handle('get-thumb', async (_event, filePath: string) => {
    const cached = getThumbPath(filePath)
    if (cached) return cached
    return await generateThumb(filePath)
  })

  ipcMain.on('delete-files', (_event, paths: string[]) => {
    for (const p of paths) {
      try { unlinkSync(p) } catch {}
    }
  })

  ipcMain.on('scan-drive', async (_event, drivePath: string) => {
    if (isDriveScanned(drivePath)) {
      const count = getFileCount(drivePath)
      if (mainWindow) {
        mainWindow.webContents.send('scan-complete', { count, drive: drivePath, cached: true })
      }
      return
    }
    clearDrive(drivePath)
    let count = 0
    const { homedir } = await import('os')
    const scanPath = drivePath === 'C:' ? homedir() : drivePath
    await scanDrive(drivePath, scanPath, (progress) => {
      count = progress
      if (mainWindow) {
        mainWindow.webContents.send('scan-progress', { count, drive: drivePath })
      }
    })
    if (mainWindow) {
      mainWindow.webContents.send('scan-complete', { count, drive: drivePath, cached: false })
    }
  })

  ipcMain.on('rescan-drive', async (_event, drivePath: string) => {
    clearDrive(drivePath)
    let count = 0
    const { homedir } = await import('os')
    const scanPath = drivePath === 'C:' ? homedir() : drivePath
    await scanDrive(drivePath, scanPath, (progress) => {
      count = progress
      if (mainWindow) {
        mainWindow.webContents.send('scan-progress', { count, drive: drivePath })
      }
    })
    if (mainWindow) {
      mainWindow.webContents.send('scan-complete', { count, drive: drivePath, cached: false })
    }
  })

  ipcMain.on('get-files', (_event, drivePath: string) => {
    const grouped = getGroupedFiles(drivePath)
    if (mainWindow) {
      mainWindow.webContents.send('files-updated', grouped)
    }
  })

  createWindow()

  setInterval(() => {
    sendDrives()
  }, 3000)

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})