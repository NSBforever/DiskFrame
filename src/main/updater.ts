import { app, ipcMain, shell, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { releaseUrl, type UpdateMode, type UpdateState } from './updateState'

/**
 * Updates from GitHub Releases (electron-builder's `publish: github`).
 *
 * One state, pushed to the renderer whenever it changes: checking, a version
 * available, downloading with a percentage, ready to install, or an error.
 * What happens on its own depends on the mode the user chose in Settings:
 *
 *   auto    check a little after startup and every six hours; download in the
 *           background; install when the app quits, or at once on request.
 *   notify  the same checks, but only say that a version exists - the download
 *           starts when the user asks for it.
 *   off     no checks unless the user presses "Check for updates".
 *
 * electron-updater verifies the download against the SHA-512 in the release's
 * latest.yml before it will install it, and resumes or restarts an interrupted
 * download on the next attempt. Nothing about the user's files is sent: the
 * request is this repository's public release metadata, no account needed.
 *
 * The portable exe can check and announce, but cannot replace itself: for it
 * `canInstall` is false and the renderer offers the release page instead.
 * Unpackaged runs and safe mode do not check at all.
 *
 * DF_UPDATE_FEED=<url> points it at a generic feed instead of GitHub, for
 * testing check -> download -> ready end to end without publishing a release.
 * It also enables the updater in an unpackaged run, where a download is
 * verified but never installed.
 */
const CHECK_AFTER_START_MS = 15_000
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

export interface UpdaterOptions {
  getWindow: () => BrowserWindow | null
  log: (m: string) => void
  getMode: () => UpdateMode
  /** True while something must not be interrupted by a restart (a file transfer). */
  isBusy: () => boolean
  safeMode: boolean
}

/** Electron and Node network failures, in words. */
function describe(err: unknown): string {
  const m = String((err as Error)?.message ?? err)
  if (/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|ERR_NETWORK_CHANGED|ERR_CONNECTION|ETIMEDOUT|ECONNRE/i.test(m)) {
    return 'no connection to GitHub. Check your internet connection and try again.'
  }
  if (/sha512|checksum|signature/i.test(m)) return 'the download did not match its checksum, so it was discarded.'
  if (/404|latest\.yml/i.test(m)) return 'the release information could not be found.'
  if (/403|rate limit/i.test(m)) return 'GitHub is limiting requests right now. Try again later.'
  return m.split('\n')[0].slice(0, 160)
}

export function initUpdates(opts: UpdaterOptions): void {
  const { getWindow, log } = opts
  const feed = process.env.DF_UPDATE_FEED
  const supported = !opts.safeMode && (app.isPackaged || !!feed)
  const portable = !!process.env.PORTABLE_EXECUTABLE_DIR

  let state: UpdateState = supported
    ? { phase: 'idle', currentVersion: app.getVersion(), canInstall: !portable }
    : { phase: 'unsupported', currentVersion: app.getVersion(), canInstall: false, reason: opts.safeMode ? 'safe-mode' : 'development' }
  const set = (next: Partial<UpdateState>): void => {
    state = { ...state, ...next }
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('update-state', state)
  }
  /** A manual check reports "you are up to date" and errors; a background one stays quiet. */
  let checking = false
  let downloading = false
  // A version whose download failed is not fetched again on its own this
  // session: a release with a bad checksum would otherwise be downloaded in
  // full at every background check. 'Try Again' still works.
  let failedVersion: string | undefined

  ipcMain.handle('update-get-state', () => state)
  ipcMain.handle('update-open-release', () => {
    void shell.openExternal(releaseUrl(state.version))
  })

  if (!supported) {
    log(`updates: not checking (${state.reason})`)
    ipcMain.handle('update-check', () => state)
    ipcMain.handle('update-download', () => state)
    ipcMain.handle('update-install', () => ({ ok: false, reason: 'unsupported' }))
    return
  }

  if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed })
  if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true
  // Downloads are started here, not by the library, so "available" is always
  // announced first and the notify mode can wait for the user.
  autoUpdater.autoDownload = false
  // A downloaded update installs when the app quits. Never from an unpackaged
  // run: there is no install to replace, only a developer's machine.
  autoUpdater.autoInstallOnAppQuit = app.isPackaged
  autoUpdater.logger = { info: (m) => log(`updates: ${m}`), warn: (m) => log(`updates: ${m}`), error: (m) => log(`updates: ${m}`), debug: () => {} }

  const download = (): void => {
    if (downloading || state.phase === 'ready' || !state.version) return
    if (!state.canInstall) return // portable: nothing to install into
    downloading = true
    set({ phase: 'downloading', percent: 0, error: undefined })
    autoUpdater
      .downloadUpdate()
      .catch((err) => {
        log(`updates: download failed (${err?.message ?? err})`)
        failedVersion = state.version
        set({ phase: 'error', error: describe(err) })
      })
      .finally(() => {
        downloading = false
      })
  }

  autoUpdater.on('update-available', (i) => {
    log(`updates: ${i.version} available`)
    set({ phase: 'available', version: i.version, checkedAt: Date.now(), error: undefined })
    if (opts.getMode() === 'auto' && state.canInstall && i.version !== failedVersion) download()
  })
  autoUpdater.on('update-not-available', () => {
    log(`updates: ${app.getVersion()} is current`)
    // A download already in hand is still in hand.
    if (state.phase !== 'ready' && state.phase !== 'downloading') set({ phase: 'current', version: undefined, checkedAt: Date.now(), error: undefined })
  })
  autoUpdater.on('download-progress', (p) => {
    if (state.phase === 'downloading') set({ percent: Math.max(0, Math.min(100, p.percent)) })
  })
  autoUpdater.on('update-downloaded', (i) => {
    log(`updates: ${i.version} downloaded and verified`)
    set({ phase: 'ready', version: i.version, percent: 100, error: undefined })
  })

  const check = async (): Promise<UpdateState> => {
    // One check at a time, and never over a download or a finished one.
    if (checking || state.phase === 'downloading' || state.phase === 'ready') return state
    checking = true
    const before = state
    set({ phase: 'checking', error: undefined })
    try {
      await autoUpdater.checkForUpdates()
      // The events above have set the outcome; if none fired, nothing changed.
      if (state.phase === 'checking') set({ phase: 'current', checkedAt: Date.now() })
    } catch (err) {
      log(`updates: check failed (${(err as Error)?.message ?? err})`)
      // A version already known to exist is still on offer after a failed re-check.
      if (before.phase === 'available') set({ ...before })
      else set({ phase: 'error', version: undefined, error: describe(err), checkedAt: Date.now() })
    } finally {
      checking = false
    }
    return state
  }

  ipcMain.handle('update-check', () => check())
  ipcMain.handle('update-download', () => {
    download()
    return state
  })
  ipcMain.handle('update-install', () => {
    if (state.phase !== 'ready') return { ok: false, reason: 'not-ready' }
    // Restarting now would cut a copy or a move off part-way.
    if (opts.isBusy()) return { ok: false, reason: 'busy' }
    if (!app.isPackaged) return { ok: false, reason: 'unsupported' }
    // Silent NSIS run, then start DiskFrame again.
    setImmediate(() => autoUpdater.quitAndInstall(true, true))
    return { ok: true }
  })

  const background = (): void => {
    if (opts.getMode() !== 'off') void check()
  }
  // After startup has settled: the first screen of thumbnails matters more.
  setTimeout(background, CHECK_AFTER_START_MS).unref()
  setInterval(background, CHECK_EVERY_MS).unref()
}
