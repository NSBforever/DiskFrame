import type { CalendarStatus } from './calendarTypes'

/**
 * What the Google Calendar card in Settings shows for a status. Pure, so
 * `npm test` covers it; the card itself only renders this.
 *
 * Eight service states collapse to five the user can tell apart:
 * - unavailable:  this build has no Google client (or safe mode) - nothing to press
 * - disconnected: set up, not signed in (connecting is its busy moment)
 * - connected:    signed in and syncing normally
 * - expired:      Google wants a fresh sign-in
 * - failed:       signed in, but the last sync did not go through (offline included)
 */
export type CalendarCardKind = 'unavailable' | 'disconnected' | 'connected' | 'expired' | 'failed'
export type CalendarTone = 'neutral' | 'ok' | 'warn' | 'danger'

export interface CalendarCard {
  kind: CalendarCardKind
  /** Short label for the status chip in the card header. */
  chip: string
  tone: CalendarTone
  /** Whether Connect / Reconnect can be pressed now. */
  canConnect: boolean
}

export function calendarCard(s: CalendarStatus): CalendarCard {
  switch (s.state) {
    case 'unconfigured':
      return { kind: 'unavailable', chip: 'Not available', tone: 'neutral', canConnect: false }
    case 'disconnected':
      return { kind: 'disconnected', chip: 'Not connected', tone: 'neutral', canConnect: true }
    case 'connecting':
      return { kind: 'disconnected', chip: 'Connecting…', tone: 'neutral', canConnect: false }
    case 'connected':
      return { kind: 'connected', chip: 'Connected', tone: 'ok', canConnect: false }
    case 'syncing':
      return { kind: 'connected', chip: 'Syncing…', tone: 'ok', canConnect: false }
    case 'expired':
      return { kind: 'expired', chip: 'Sign-in expired', tone: 'warn', canConnect: true }
    case 'offline':
      return { kind: 'failed', chip: 'Offline', tone: 'warn', canConnect: false }
    case 'error':
      return { kind: 'failed', chip: 'Sync failed', tone: 'danger', canConnect: false }
  }
}

function ago(iso: string | null, now: number): string {
  if (!iso) return 'not yet'
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString()
}

/** The card's one-line status, in plain words. */
export function calendarStatusLine(s: CalendarStatus, now: number): string {
  switch (s.state) {
    case 'unconfigured':
      return s.message ?? 'Google Calendar is not available in this build.'
    case 'disconnected':
      return s.message ? `Not connected. ${s.message}` : 'Not connected.'
    case 'connecting':
      return s.message ?? 'Waiting for Google…'
    case 'syncing':
      return 'Syncing…'
    case 'connected':
      return `Connected${s.email ? ` as ${s.email}` : ''}. Last synced ${ago(s.lastSyncAt, now)} · ${s.eventCount.toLocaleString()} events saved.`
    default:
      return `${s.message ?? ''} Last synced ${ago(s.lastSyncAt, now)}.`.trim()
  }
}
