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

/** One file shown under an event: the user's link, or a suggestion. */
export interface DayFile {
  path: string
  name: string
  ext: string
  thumb: string | null
  date: string
  /** The rest of a gallery row, so the viewer and Info get what they expect. */
  size: number
  year: string
  month: string
  lat: number | null
  lng: number | null
  drive: string
  favourited: number
  volume_id: string | null
  score: number
  status: 'suggested' | 'confirmed' | 'manual'
}

/** One calendar event on a local day, with its files. */
export interface DayEvent {
  calendarId: string
  eventId: string
  summary: string
  location: string
  allDay: boolean
  startMs: number
  endMs: number
  recurring: boolean
  files: DayFile[]
}

/** confirm / reject (remove a suggestion) / add by hand / undo any of those. */
export type LinkOp = 'confirm' | 'reject' | 'manual' | 'undo'
