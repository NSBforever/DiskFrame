import { app, ipcMain, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

/**
 * Updates from GitHub Releases (electron-builder's `publish: github`).
 *
 * Checks a little after startup and every six hours, downloads in the
 * background, and installs when the app quits - or at once, if the user
 * presses "Restart" on the banner the renderer shows for 'update-ready'.
 * Nothing about the user's files is sent: the request is GitHub's release
 * metadata for this repository.
 *
 * Off for unpackaged runs (there is no app-update.yml), for the portable exe
 * (electron-updater can only replace an NSIS install), when the user turned it
 * off in Settings, and in safe mode (the caller does not start it).
 *
 * DF_UPDATE_FEED=<url> points it at a generic feed instead of GitHub, for
 * testing a download end to end without publishing a release.
 */
export function startAutoUpdates(getWindow: () => BrowserWindow | null, log: (m: string) => void): void {
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) {
    log('updates: not an installed build, not checking')
    return
  }
  if (process.env.DF_UPDATE_FEED) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.DF_UPDATE_FEED })
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = { info: (m) => log(`updates: ${m}`), warn: (m) => log(`updates: ${m}`), error: (m) => log(`updates: ${m}`), debug: () => {} }

  autoUpdater.on('update-available', (i) => log(`updates: ${i.version} available, downloading`))
  autoUpdater.on('update-not-available', () => log(`updates: ${app.getVersion()} is current`))
  // Offline, GitHub down, rate-limited: try again at the next check, never bother the user.
  autoUpdater.on('error', (err) => log(`updates: check failed (${err?.message ?? err})`))
  autoUpdater.on('update-downloaded', (i) => {
    log(`updates: ${i.version} downloaded, installs on quit`)
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('update-ready', { version: i.version })
  })

  ipcMain.handle('install-update', () => {
    // Silent NSIS run, then start DiskFrame again.
    setImmediate(() => autoUpdater.quitAndInstall(true, true))
  })

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err) => log(`updates: check failed (${err?.message ?? err})`))
  }
  // After startup has settled: the first screen of thumbnails matters more.
  setTimeout(check, 15_000)
  setInterval(check, 6 * 60 * 60 * 1000)
}
