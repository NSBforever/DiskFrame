/**
 * Google Calendar event (events.list with singleEvents=true) -> one cached row.
 *
 * Google expands recurring series into instances, applies moved and cancelled
 * occurrences, and resolves time zones and DST; nothing here re-implements
 * that. What is left is turning two shapes of time into rows a day query can
 * use:
 *   - timed events carry RFC 3339 instants with an offset -> UTC ms;
 *   - all-day events carry calendar DATES with an EXCLUSIVE end -> local
 *     midnights, and an inclusive end_day.
 * Days are this machine's local days, the same days the gallery groups by.
 */

export interface GoogleEventTime {
  date?: string
  dateTime?: string
  timeZone?: string
}

export interface GoogleEvent {
  id?: string
  status?: string
  summary?: string
  description?: string
  location?: string
  start?: GoogleEventTime
  end?: GoogleEventTime
  recurringEventId?: string
  originalStartTime?: GoogleEventTime
  updated?: string
}

export interface EventRow {
  event_id: string
  recurring_event_id: string | null
  original_start_ms: number | null
  summary: string
  description: string
  location: string
  all_day: 0 | 1
  start_ms: number
  end_ms: number
  /** Local YYYY-MM-DD, inclusive at both ends. */
  start_day: string
  end_day: string
  event_tz: string | null
  updated: string | null
}

/** What to do with one item of an events.list page. */
export type EventChange = { kind: 'upsert'; row: EventRow } | { kind: 'delete'; event_id: string } | { kind: 'skip' }

const pad = (n: number): string => String(n).padStart(2, '0')

/** This machine's local calendar day of an instant. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Local midnight at the start of a YYYY-MM-DD date, or null if malformed. */
function localMidnight(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return null
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  return isNaN(t) ? null : t
}

function instant(t: GoogleEventTime | undefined): number | null {
  if (t?.dateTime) {
    const ms = Date.parse(t.dateTime)
    return isNaN(ms) ? null : ms
  }
  if (t?.date) return localMidnight(t.date)
  return null
}

/**
 * Event descriptions arrive as HTML and can be written by anyone who invites
 * the user. The renderer runs with web security off, so only plain text ever
 * leaves the main process, and it is rendered as a text node.
 */
export function plainText(html: string | undefined, max: number): string {
  if (!html) return ''
  const text = html
    // Script and style bodies are code, not words: drop them with their tags.
    .replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(br|\/p|\/div|\/li)\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

export function normalizeEvent(e: GoogleEvent): EventChange {
  if (!e.id) return { kind: 'skip' }
  // Deleted events, and cancelled occurrences of a series, come back as
  // status 'cancelled' (incremental sync always includes them).
  if (e.status === 'cancelled') return { kind: 'delete', event_id: e.id }
  const allDay = !!e.start?.date && !e.start?.dateTime
  const start = instant(e.start)
  let end = instant(e.end)
  if (start === null) return { kind: 'skip' }
  if (end === null || end < start) end = start
  let startDay: string
  let endDay: string
  if (allDay) {
    startDay = e.start!.date!
    // Google's end date is exclusive: a one-day event on the 18th ends on the 19th.
    endDay = end > start ? localDay(end - 1) : startDay
  } else {
    startDay = localDay(start)
    // An event ending exactly at midnight does not spill into the next day.
    endDay = localDay(end > start ? end - 1 : start)
  }
  return {
    kind: 'upsert',
    row: {
      event_id: e.id,
      recurring_event_id: e.recurringEventId ?? null,
      original_start_ms: instant(e.originalStartTime),
      summary: plainText(e.summary, 500) || '(No title)',
      description: plainText(e.description, 4000),
      location: plainText(e.location, 500),
      all_day: allDay ? 1 : 0,
      start_ms: start,
      end_ms: end,
      start_day: startDay,
      end_day: endDay,
      event_tz: e.start?.timeZone ?? null,
      updated: e.updated ?? null
    }
  }
}
