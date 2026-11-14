/**
 * What the update system can be doing, and the rules for telling the user
 * about it. Pure - no Electron, no network - so `npm test` covers it and the
 * renderer imports the same definitions the main process uses.
 */

/**
 * - auto:   check, download in the background, install on quit (the default).
 * - notify: check and say so; download only when the user asks.
 * - off:    never check on its own. "Check for updates" in Settings still works.
 */
export type UpdateMode = 'auto' | 'notify' | 'off'

export type UpdatePhase =
  | 'unsupported' // this build cannot check at all (see `reason`)
  | 'idle' // nothing checked yet this session
  | 'checking'
  | 'current' // checked: this is the newest version
  | 'available' // a newer version exists and is not downloaded
  | 'downloading'
  | 'ready' // downloaded and verified; installs on quit or on request
  | 'error'

export interface UpdateState {
  phase: UpdatePhase
  currentVersion: string
  /** The newer version, once one is known. Kept through downloading/ready/error. */
  version?: string
  /** 0-100 while downloading. */
  percent?: number
  /** What went wrong, in words fit to show. */
  error?: string
  /** When the last check finished (ms since epoch). */
  checkedAt?: number
  /** False for the portable build: it can be told about a version but cannot replace itself. */
  canInstall: boolean
  /** Why `unsupported`. */
  reason?: 'development' | 'safe-mode'
}

/**
 * The preference column is an integer that began life as a boolean
 * (1 = update automatically, 0 = off), so those two keep their meaning and
 * `notify` takes the next value. Anything unreadable is the default.
 */
export function modeFromPref(value: unknown): UpdateMode {
  if (value === 0) return 'off'
  if (value === 2) return 'notify'
  return 'auto'
}
export function prefFromMode(mode: UpdateMode): number {
  return mode === 'off' ? 0 : mode === 'notify' ? 2 : 1
}
export function isUpdateMode(v: unknown): v is UpdateMode {
  return v === 'auto' || v === 'notify' || v === 'off'
}

const REPO_URL = 'https://github.com/NSBforever/DiskFrame'

/** The release page for a version, or the list of releases when it is not a plain version. */
export function releaseUrl(version: string | undefined): string {
  return version && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) ? `${REPO_URL}/releases/tag/v${version}` : `${REPO_URL}/releases`
}

/** "Remind me later" for one version, until a time. */
export interface UpdateSnooze {
  version: string
  until: number
}
export const SNOOZE_MS = 24 * 60 * 60 * 1000

export function parseSnooze(raw: string | null): UpdateSnooze | null {
  try {
    const v = JSON.parse(raw ?? 'null') as UpdateSnooze | null
    return v && typeof v.version === 'string' && typeof v.until === 'number' ? v : null
  } catch {
    return null
  }
}

/**
 * Whether the update notice should be on screen right now.
 *
 * Only for things the user can act on: a version to download, a download in
 * progress, one ready to install, or a download they asked for that failed. A
 * failed background check is never announced - offline is not news. Nothing is
 * shown over a file transfer or an open viewer (`busy`); it appears once that
 * is over. A snooze hides one version's "available" notice until it expires; a
 * newer version than the one snoozed is announced at once.
 */
export function shouldAnnounce(state: UpdateState, opts: { busy: boolean; snooze: UpdateSnooze | null; now: number; dismissed: boolean }): boolean {
  if (opts.busy || opts.dismissed) return false
  if (state.phase === 'downloading' || state.phase === 'ready') return true
  if (state.phase === 'error') return !!state.version
  if (state.phase !== 'available') return false
  const s = opts.snooze
  return !(s && s.version === state.version && opts.now < s.until)
}

/** One line for Settings: what the last check found. */
export function statusLine(state: UpdateState, now: number): string {
  const ago = (t: number): string => {
    const m = Math.round((now - t) / 60000)
    if (m < 1) return 'just now'
    if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
    const h = Math.round(m / 60)
    if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
    const d = Math.round(h / 24)
    return `${d} day${d === 1 ? '' : 's'} ago`
  }
  switch (state.phase) {
    case 'unsupported':
      return state.reason === 'safe-mode' ? 'Updates are off in diagnostic mode.' : 'This is a development build; it does not check for updates.'
    case 'idle':
      return `DiskFrame ${state.currentVersion}. Not checked yet.`
    case 'checking':
      return 'Checking for updates…'
    case 'current':
      return `DiskFrame ${state.currentVersion} is the latest version.${state.checkedAt ? ` Checked ${ago(state.checkedAt)}.` : ''}`
    case 'available':
      return `DiskFrame ${state.version} is available. You have ${state.currentVersion}.`
    case 'downloading':
      return `Downloading DiskFrame ${state.version}… ${Math.round(state.percent ?? 0)}%`
    case 'ready':
      return `DiskFrame ${state.version} is downloaded and installs when you close the app.`
    case 'error':
      return `Could not ${state.version ? 'download the update' : 'check for updates'}: ${state.error ?? 'unknown error'}`
  }
}
