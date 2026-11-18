import { normalizeEvent, type GoogleEvent } from './eventNormalize.ts'
import { applyEventChanges, saveCalendar, syncTokenOf, type CalDb } from './calendarStore.ts'
import type { Fetch } from './googleAuth.ts'

/**
 * One calendar's sync (Google's guide, checked 2026-11-18): a full list, then
 * only changes via nextSyncToken. A 410 means the token is no longer honoured:
 * list the calendar in full again. singleEvents=true has Google expand
 * recurring series, moved and cancelled instances included.
 *
 * The cache is never wiped up front. Google's guide says to clear the store and
 * resync; clearing FIRST meant a resync that then failed (offline, a revoked
 * grant, a 5xx) left the user with no saved events at all - seen in the app
 * when a 410 was followed by a 401. A full list instead removes whatever it did
 * not see, and only once it has completed.
 */

export type SyncFailure = 'auth' | 'offline' | 'http'

export class SyncError extends Error {
  readonly kind: SyncFailure
  readonly status: number | null
  constructor(kind: SyncFailure, message: string, status: number | null = null) {
    super(message)
    this.kind = kind
    this.status = status
  }
}

export interface SyncDeps {
  db: CalDb
  fetch: Fetch
  apiBase: string
  /** A valid access token; `force` asks for a fresh one after a 401. */
  accessToken(force: boolean): Promise<string>
  now?: () => number
}

export interface SyncResult {
  full: boolean
  upserted: number
  deleted: number
  pages: number
  summary: string | null
}

interface EventsPage {
  items?: GoogleEvent[]
  nextPageToken?: string
  nextSyncToken?: string
  summary?: string
  timeZone?: string
}

async function getPage(deps: SyncDeps, calendarId: string, params: Record<string, string>): Promise<{ status: number; body: EventsPage }> {
  const url = `${deps.apiBase}/calendars/${encodeURIComponent(calendarId)}/events?${new URLSearchParams(params)}`
  let forced = false
  for (;;) {
    const token = await deps.accessToken(forced)
    let res: Awaited<ReturnType<Fetch>>
    try {
      res = await deps.fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
    } catch {
      throw new SyncError('offline', 'Could not reach Google Calendar')
    }
    // One fresh token per request: a second 401 is a revoked grant, not an
    // expired token, and retrying forever would hammer Google.
    if (res.status === 401 && !forced) {
      forced = true
      continue
    }
    if (res.status === 401 || res.status === 403) throw new SyncError('auth', 'Google Calendar refused access', res.status)
    if (res.status === 410) return { status: 410, body: {} }
    if (!res.ok) throw new SyncError('http', `Google Calendar answered ${res.status}`, res.status)
    return { status: res.status, body: (await res.json()) as EventsPage }
  }
}

export async function syncCalendar(deps: SyncDeps, calendarId = 'primary'): Promise<SyncResult> {
  const now = deps.now ?? Date.now
  let restartedAfter410 = false
  for (;;) {
    const token = syncTokenOf(deps.db, calendarId)
    const full = !token
    const result: SyncResult = { full, upserted: 0, deleted: 0, pages: 0, summary: null }
    // A full list must also remove what it did not see: a full sync cut short
    // and restarted (no token was saved) would otherwise keep events deleted
    // in between, since a full list does not report deletions.
    const seen = full ? new Set<string>() : null
    let pageToken: string | undefined
    let gone = false
    do {
      const params: Record<string, string> = { singleEvents: 'true', maxResults: '2500' }
      if (token) params.syncToken = token
      if (pageToken) params.pageToken = pageToken
      const { status, body } = await getPage(deps, calendarId, params)
      if (status === 410) {
        gone = true
        break
      }
      result.pages++
      if (result.pages === 1) {
        result.summary = body.summary ?? null
        saveCalendar(deps.db, calendarId, { summary: body.summary ?? null, time_zone: body.timeZone ?? null })
      }
      const changes = (body.items ?? []).map(normalizeEvent)
      for (const c of changes) if (seen && c.kind === 'upsert') seen.add(c.row.event_id)
      const applied = applyEventChanges(deps.db, calendarId, changes, now())
      result.upserted += applied.upserted
      result.deleted += applied.deleted
      pageToken = body.nextPageToken
      if (!pageToken && body.nextSyncToken) {
        if (seen) {
          const stale = (deps.db.prepare('SELECT event_id FROM calendar_events WHERE calendar_id = ?').all(calendarId) as { event_id: string }[])
            .filter((r) => !seen.has(r.event_id))
            .map((r) => ({ kind: 'delete' as const, event_id: r.event_id }))
          result.deleted += applyEventChanges(deps.db, calendarId, stale, now()).deleted
        }
        saveCalendar(deps.db, calendarId, { sync_token: body.nextSyncToken })
      }
    } while (pageToken)
    if (!gone) return result
    if (restartedAfter410) throw new SyncError('http', 'Google Calendar keeps rejecting a fresh sync', 410)
    restartedAfter410 = true
    // Forget only the token. Should the full list fail part-way, the next
    // attempt starts a full list again and the saved events stay meanwhile.
    saveCalendar(deps.db, calendarId, { sync_token: null })
  }
}
