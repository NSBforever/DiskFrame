/**
 * 1.6.0: Update History / What's New, and opt-in analytics with crash
 * summaries. Parsing and the privacy rules live in releaseHistory.ts and
 * analytics.ts (tested); this file only fetches, caches, sends and wires IPC.
 *
 * Network use:
 * - GitHub's public releases list (the repository the updater already reads),
 *   anonymous, nothing about the user's files.
 * - PostHog EU, only after the user said yes, only events analytics.ts allows,
 *   and only when this build has a project key. Never throws, never retries in
 *   a loop, never blocks the UI.
 */
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import type { App, IpcMain } from 'electron'
import { cachedReleases, compareVersions, parseReleases, shouldShowWhatsNew, type PublishedRelease } from './releaseHistory'
import { buildEvent, canSend, newInstallId } from './analytics'
import type { PrivacyPrefs } from './scanner'

const RELEASES_URL = 'https://api.github.com/repos/NSBforever/DiskFrame/releases?per_page=30'
const POSTHOG_CAPTURE = 'https://eu.i.posthog.com/i/v0/e/'

type Fetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; json(): Promise<unknown> }>

/** IPC that changes consent or counts use is taken only from a window's top frame. */
const fromTopFrame = (e: { sender: { mainFrame: unknown }; senderFrame: unknown }): boolean => e.senderFrame === e.sender.mainFrame

export function initReleaseHistory(o: {
  ipcMain: IpcMain
  fetch: Fetch
  userData: string
  currentVersion: string
  /** The version DiskFrame last ran as (null on a first install); index.ts has already recorded this one. */
  previousVersion: string | null
  log: (m: string) => void
}): void {
  const cacheFile = join(o.userData, 'release-history.json')
  const readCache = (): PublishedRelease[] => {
    try {
      return cachedReleases(JSON.parse(fs.readFileSync(cacheFile, 'utf8')))
    } catch {
      return []
    }
  }
  let inFlight: Promise<{ releases: PublishedRelease[]; fromCache: boolean }> | null = null
  const load = (): Promise<{ releases: PublishedRelease[]; fromCache: boolean }> =>
    (inFlight ??= (async () => {
      try {
        const r = await o.fetch(RELEASES_URL, {
          headers: { 'User-Agent': 'DiskFrame', Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(10_000)
        })
        if (!r.ok) throw new Error('GitHub answered with an error')
        const releases = parseReleases(await r.json())
        if (releases.length) {
          try {
            fs.writeFileSync(`${cacheFile}.tmp`, JSON.stringify(releases))
            fs.renameSync(`${cacheFile}.tmp`, cacheFile)
          } catch (e) {
            o.log(`release history not saved: ${String(e)}`)
          }
        }
        return { releases, fromCache: false }
      } catch (e) {
        o.log(`release history offline: ${String(e)}`)
        return { releases: readCache(), fromCache: true }
      } finally {
        setTimeout(() => (inFlight = null), 60_000).unref()
      }
    })())

  o.ipcMain.handle('release-history', async () => {
    const { releases, fromCache } = await load()
    return { installed: o.currentVersion, latest: releases[0]?.version ?? null, releases, fromCache }
  })
  // Once per update, only when its notes can be shown; never on a first install.
  let whatsNewDue = shouldShowWhatsNew(o.previousVersion, o.currentVersion)
  o.ipcMain.handle('whats-new', async () => {
    if (!whatsNewDue) return null
    const r = (await load()).releases.find((x) => x.version === o.currentVersion)
    if (!r || !r.sections.length) return null // offline: try again on the next start of this session's renderer
    whatsNewDue = false
    return r
  })
}

/** Electron's process types, as analytics.ts names them. */
function processType(t: string): string {
  const k = t.toLowerCase().replace(/\s+/g, '_')
  return ['utility', 'gpu', 'zygote', 'sandbox_helper', 'pepper_plugin'].includes(k) ? k : 'unknown'
}

/** Not crashes: a normal exit, or a process ended from outside (Task Manager, Windows shutting down). */
const ENDED_ON_PURPOSE = ['clean-exit', 'killed']

export function initAnalytics(o: {
  app: App
  ipcMain: IpcMain
  fetch: Fetch
  projectKey: string
  currentVersion: string
  /** Read before What's New marks this version seen: the version the user had before. */
  previousVersion: string | null
  getPrefs: () => PrivacyPrefs
  setPrefs: (p: { analytics?: boolean; crashes?: boolean; installId?: string }) => PrivacyPrefs
  log: (m: string) => void
}): void {
  // A local test server only (like the Calendar mock): never an arbitrary host.
  const override = process.env.DF_ANALYTICS_ENDPOINT
  const endpoint = override && !o.app.isPackaged && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(override) ? override : POSTHOG_CAPTURE

  const send = (event: string, props: Record<string, unknown>): void => {
    const p = o.getPrefs()
    const id = p.installId ?? ''
    if (!canSend({ analytics: p.analytics, crashes: p.crashes }, o.projectKey, id, event)) return
    const body = buildEvent(event, props, id, o.projectKey)
    if (!body) return
    void o
      .fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .catch((e) => o.log(`analytics not sent: ${String(e)}`))
  }

  const state = (): { analytics: boolean | null; crashes: boolean | null; hasId: boolean; available: boolean } => {
    const p = o.getPrefs()
    return { analytics: p.analytics, crashes: p.crashes, hasId: !!p.installId, available: !!o.projectKey }
  }

  o.ipcMain.handle('privacy-get', () => state())
  o.ipcMain.handle('privacy-set', (e, raw: unknown) => {
    if (!fromTopFrame(e)) return state()
    const r = (raw && typeof raw === 'object' ? raw : {}) as { analytics?: unknown; crashes?: unknown; resetId?: unknown }
    const patch: { analytics?: boolean; crashes?: boolean; installId?: string } = {}
    if (typeof r.analytics === 'boolean') patch.analytics = r.analytics
    if (typeof r.crashes === 'boolean') patch.crashes = r.crashes
    // A new id only while something is shared: an id is never created without a yes.
    const prefs = o.getPrefs()
    if (r.resetId === true && (prefs.analytics || prefs.crashes)) patch.installId = newInstallId()
    o.setPrefs(patch)
    // An id exists only once the user agreed to something that needs it.
    if ((patch.analytics || patch.crashes) && !o.getPrefs().installId) o.setPrefs({ installId: newInstallId() })
    const s = state()
    o.log(`privacy: analytics ${s.analytics}, crash summaries ${s.crashes}${patch.installId ? ', id reset' : ''}`)
    return s
  })
  o.ipcMain.on('track-feature', (e, name: unknown) => fromTopFrame(e) && send('feature_used', { feature: name }))

  send('app_started', { version: o.currentVersion, os: `${process.platform}-${os.release()}` })
  if (o.previousVersion && compareVersions(o.currentVersion, o.previousVersion) > 0) {
    send('update_installed', { from: o.previousVersion, to: o.currentVersion })
  }
  o.app.on('render-process-gone', (_e, _wc, d) => {
    if (!ENDED_ON_PURPOSE.includes(d.reason)) send('crash', { version: o.currentVersion, process_type: 'renderer', reason: d.reason, exit_code: d.exitCode })
  })
  o.app.on('child-process-gone', (_e, d) => {
    if (!ENDED_ON_PURPOSE.includes(d.reason)) send('crash', { version: o.currentVersion, process_type: processType(d.type), reason: d.reason, exit_code: d.exitCode })
  })
}
