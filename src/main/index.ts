import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { getDiskInfo } from 'node-disk-info'

let mainWindow: BrowserWindow

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
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

// Send drive list to renderer
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
    if (mainWindow) {
      mainWindow.webContents.send('drives-updated', drives)
    }
  } catch (err) {
    console.error('Error getting disk info:', err)
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.on('ping', () => console.log('pong'))

  // Send drives when renderer asks
  ipcMain.on('get-drives', () => {
    sendDrives()
  })

  createWindow()

  // Poll for drive changes every 3 seconds
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