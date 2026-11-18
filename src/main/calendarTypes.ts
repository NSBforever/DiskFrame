/** What the renderer is told about Google Calendar (shared with the preload types). */
export type CalendarState = 'unconfigured' | 'disconnected' | 'connecting' | 'connected' | 'syncing' | 'offline' | 'expired' | 'error'

export interface CalendarStatus {
  state: CalendarState
  email: string | null
  connectedAt: string | null
  lastSyncAt: string | null
  /** Plain words for the user, or null. Never contains a token or an event. */
  message: string | null
  eventCount: number
  autoSync: boolean
  bufferMin: number
}
