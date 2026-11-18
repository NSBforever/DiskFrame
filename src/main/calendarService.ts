import { app, ipcMain, net, safeStorage, shell, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { authorize, googleConfig, OAuthError, refreshAccess, revokeToken, type Fetch, type GoogleConfig } from './googleAuth'
import { credentialStore } from './credentialStore'
import { forgetCalendarData, getAccount, saveAccount, type CalDb } from './calendarStore'
import { syncCalendar, SyncError } from './calendarSync'
import type { CalendarState, CalendarStatus, DayEvent, LinkOp } from './calendarTypes'
import { dayEvents, eventDays, setLink } from './calendarDay'

/**
 * Google Calendar for the app: Settings actions, background sync, and the one
 * status the renderer sees. The renderer never receives a token - only this
 * status, which carries the account's own address and nothing else secret.
 *
 * Nothing here gates the gallery: it starts after the window, a missing client
 * id or no network only changes the status, and every failure keeps the cache.
 */

export interface CalendarPrefsIO {
  get(): { autoSync: boolean; bufferMin: number }
  set(p: { autoSync?: boolean; bufferMin?: number }): { autoSync: boolean; bufferMin: number }
}

const AUTO_SYNC_MS = 30 * 60_000
const OFFLINE_RETRY_MS = 2 * 60_000
const FIRST_SYNC_DELAY_MS = 20_000

// net.fetch uses Chromium's network stack: the system proxy and certificates.
const netFetch: Fetch = (url, init) => net.fetch(url, init)

export function initCalendar(opts: {
  db: CalDb
  getWindow: () => BrowserWindow | null
  prefs: CalendarPrefsIO
  log: (m: string) => void
  safeMode: boolean
  /** The volume verifiably mounted at a drive letter, from live hardware. */
  volumeOf: (drive: string) => string | null
  isSafeLocalPath: (p: string) => boolean
}): void {
  const { db, prefs, log } = opts
  const cfg: GoogleConfig | null = opts.safeMode ? null : googleConfig()
  const creds = credentialStore(join(app.getPath('userData'), 'google-calendar.bin'), safeStorage)
  let access: { token: string; expiresAt: number } | null = null
  let transient: { state: CalendarState; message: string | null } | null = null
  let inFlight: Promise<void> | null = null
  let retry: NodeJS.Timeout | null = null

  const status = (): CalendarStatus => {
    const p = prefs.get()
    const acct = getAccount(db)
    const eventCount = (db.prepare('SELECT COUNT(*) n FROM calendar_events').get() as { n: number }).n
    const base = { email: acct?.email ?? null, connectedAt: acct?.connected_at ?? null, lastSyncAt: acct?.last_sync_at ?? null, eventCount, ...p }
    if (!cfg) return { ...base, state: 'unconfigured', message: opts.safeMode ? 'Not available in safe mode.' : 'Google Calendar is not set up in this build.' }
    if (transient) return { ...base, ...transient }
    if (!acct) return { ...base, state: 'disconnected', message: null }
    if (acct.status === 'expired') return { ...base, state: 'expired', message: acct.last_error ?? 'Google needs you to sign in again.' }
    if (acct.status === 'error') return { ...base, state: 'error', message: acct.last_error }
    return { ...base, state: 'connected', message: null }
  }
  const publish = (): void => {
    const w = opts.getWindow()
    if (w && !w.isDestroyed()) w.webContents.send('calendar-status', status())
  }
  const setTransient = (t: typeof transient): void => {
    transient = t
    publish()
  }

  const accessToken = async (force: boolean): Promise<string> => {
    if (!force && access && access.expiresAt - 60_000 > Date.now()) return access.token
    const rt = creds.load()
    if (!rt) throw new OAuthError('invalid_grant', 'Not signed in')
    const t = await refreshAccess(cfg!, netFetch, rt)
    access = { token: t.accessToken, expiresAt: t.expiresAt }
    return access.token
  }

  /** The grant is gone (revoked, expired testing token, password change...). */
  const markExpired = (why: string): void => {
    access = null
    creds.clear()
    saveAccount(db, { status: 'expired', last_error: why })
    log('expired: sign-in no longer accepted; cached events kept')
  }

  const runSync = async (): Promise<void> => {
    if (!cfg || !getAccount(db) || getAccount(db)!.status === 'expired') return
    if (retry) clearTimeout(retry)
    retry = null
    setTransient({ state: 'syncing', message: null })
    const t0 = Date.now()
    try {
      const r = await syncCalendar({ db, fetch: netFetch, apiBase: cfg.apiBase, accessToken })
      saveAccount(db, { status: 'connected', last_sync_at: new Date().toISOString(), last_error: null, ...(r.summary ? { email: r.summary } : {}) })
      log(`sync ${r.full ? 'full' : 'incremental'}: +${r.upserted} -${r.deleted} in ${r.pages} page(s), ${Date.now() - t0}ms`)
      transient = null
    } catch (e) {
      if ((e instanceof OAuthError && e.code === 'invalid_grant') || (e instanceof SyncError && e.kind === 'auth')) {
        markExpired('Google no longer accepts this sign-in. Reconnect to keep events up to date.')
        transient = null
      } else if ((e instanceof OAuthError && e.code === 'network') || (e instanceof SyncError && e.kind === 'offline')) {
        transient = { state: 'offline', message: 'You appear to be offline. Showing saved events.' }
        retry = setTimeout(() => void syncNow(), OFFLINE_RETRY_MS)
        log('sync: offline, will retry')
      } else {
        const msg = e instanceof Error ? e.message : 'Sync failed'
        saveAccount(db, { status: 'error', last_error: `${msg}. Showing saved events.` })
        transient = null
        log(`sync failed: ${msg}`)
      }
    } finally {
      publish()
    }
  }
  const syncNow = (): Promise<void> => (inFlight ??= runSync().finally(() => (inFlight = null)))

  const connect = async (): Promise<CalendarStatus> => {
    if (!cfg || inFlight) return status()
    setTransient({ state: 'connecting', message: 'Finish signing in in your browser.' })
    try {
      // Against the local test mock there is no one to click "Allow": follow the
      // redirect directly instead of opening the user's browser. Real Google
      // always goes through the system browser.
      const t = await authorize(cfg, { fetch: netFetch, openUrl: cfg.isMock ? async (u) => void (await net.fetch(u)) : (u) => shell.openExternal(u) })
      creds.save(t.refreshToken!)
      access = { token: t.accessToken, expiresAt: t.expiresAt }
      saveAccount(db, { status: 'connected', connected_at: new Date().toISOString(), last_error: null })
      log('connected')
      transient = null
      await syncNow()
    } catch (e) {
      const words: Record<string, string> = {
        denied: 'Access was not granted.',
        timeout: 'Sign-in timed out. Try again.',
        network: 'Could not reach Google. Check your connection.'
      }
      const why = e instanceof OAuthError ? (words[e.code] ?? e.message) : e instanceof Error ? e.message : 'Sign-in failed.'
      log(`connect failed: ${e instanceof OAuthError ? e.code : 'error'}`)
      transient = getAccount(db) ? null : { state: 'disconnected', message: why }
    }
    publish()
    return status()
  }

  const disconnect = async (): Promise<CalendarStatus> => {
    const rt = creds.load()
    // Best effort: offline, the grant stays at Google until the user removes
    // it there, but nothing on this PC can use it any more.
    const revoked = cfg && rt ? await revokeToken(cfg, netFetch, rt) : false
    creds.clear()
    access = null
    if (retry) clearTimeout(retry)
    forgetCalendarData(db)
    transient = null
    log(`disconnected (revoked at Google: ${revoked})`)
    publish()
    return status()
  }

  ipcMain.handle('calendar-status', () => status())
  ipcMain.handle('calendar-connect', () => connect())
  ipcMain.handle('calendar-sync-now', async () => {
    await syncNow()
    return status()
  })
  ipcMain.handle('calendar-disconnect', () => disconnect())
  // Reads work with or without a connection: saved events stay browsable
  // offline, after an expired sign-in, and in a build without a client id.
  ipcMain.handle('calendar-day', (_e, rawDrive: unknown, rawDay: unknown): DayEvent[] => {
    if (typeof rawDrive !== 'string' || !/^[A-Za-z]:$/.test(rawDrive)) return []
    if (typeof rawDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(rawDay)) return []
    return dayEvents(db, rawDay, opts.volumeOf(rawDrive.toUpperCase()), prefs.get().bufferMin)
  })
  ipcMain.handle('calendar-event-days', (): string[] => eventDays(db))
  ipcMain.handle('calendar-link', (_e, raw: unknown): boolean => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const op = r.op as LinkOp
    if (!['confirm', 'reject', 'manual', 'undo'].includes(op)) return false
    if (typeof r.path !== 'string' || !opts.isSafeLocalPath(r.path)) return false
    if (typeof r.calendarId !== 'string' || typeof r.eventId !== 'string' || r.eventId.length > 1024 || r.calendarId.length > 1024) return false
    const volumeId = opts.volumeOf(r.path.slice(0, 2).toUpperCase())
    if (!volumeId) return false
    if (op !== 'undo') {
      // Only a real event and a real indexed file can be linked.
      if (!db.prepare('SELECT 1 FROM calendar_events WHERE calendar_id = ? AND event_id = ?').get(r.calendarId, r.eventId)) return false
      if (!db.prepare('SELECT 1 FROM files WHERE path = ? AND volume_id = ?').get(r.path, volumeId)) return false
    }
    setLink(db, op, r.path, volumeId, r.calendarId, r.eventId)
    return true
  })
  ipcMain.handle('calendar-set-prefs', (_e, raw: unknown) => {
    const p = (raw && typeof raw === 'object' ? raw : {}) as { autoSync?: unknown; bufferMin?: unknown }
    prefs.set({
      ...(typeof p.autoSync === 'boolean' ? { autoSync: p.autoSync } : {}),
      ...(typeof p.bufferMin === 'number' ? { bufferMin: p.bufferMin } : {})
    })
    publish()
    return status()
  })

  if (!cfg) return
  const tick = (): void => {
    if (prefs.get().autoSync) void syncNow()
  }
  setTimeout(tick, FIRST_SYNC_DELAY_MS).unref()
  setInterval(tick, AUTO_SYNC_MS).unref()
}
