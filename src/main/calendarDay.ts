import type { CalDb } from './calendarStore.ts'
import { matchFiles, LONG_EVENT_MS, EVIDENCE_SOURCES, type Decision, type LinkState, type MatchEvent, type MatchFile } from './eventMatch.ts'
import type { DayEvent, LinkOp } from './calendarTypes.ts'
export type { DayEvent, DayFile, LinkOp } from './calendarTypes.ts'

/**
 * One local day as the Memory Timeline shows it: the day's events, each with
 * the user's linked files and the suggested ones. Reads only - the index the
 * gallery already has (files.date, volume-scoped) and the calendar cache.
 * Nothing is scanned and nothing is written.
 */

export const keyOf = (calendarId: string, eventId: string): string => `${calendarId}\u0000${eventId}`

function localDayBounds(day: string): [number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return null
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  const end = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1).getTime()
  return isNaN(start) ? null : [start, end]
}

interface EventRow {
  calendar_id: string
  event_id: string
  summary: string
  location: string
  all_day: 0 | 1
  start_ms: number
  end_ms: number
  recurring_event_id: string | null
}

interface FileRow {
  path: string
  volume_id: string | null
  name: string
  ext: string
  thumb: string | null
  date: string
  date_source: string | null
  size: number
  year: string
  month: string
  lat: number | null
  lng: number | null
  drive: string
  favourited: number
}

const FILE_COLS = 'path, volume_id, name, ext, thumb, date, date_source, size, year, month, lat, lng, drive, favourited'
const LIVE = 'hidden = 0 AND trashed_at IS NULL'

export function dayEvents(db: CalDb, day: string, volumeId: string | null, bufferMin: number): DayEvent[] {
  const bounds = localDayBounds(day)
  if (!bounds || !volumeId) return []
  const ofDay = db
    .prepare(
      `SELECT calendar_id, event_id, summary, location, all_day, start_ms, end_ms, recurring_event_id
       FROM calendar_events WHERE start_day <= ? AND end_day >= ? ORDER BY all_day DESC, start_ms, summary`
    )
    .all(day, day) as EventRow[]
  if (ofDay.length === 0) return []

  // Candidate files: the window the day's suggestible events can reach, plus
  // any neighbour event overlapping that window (so a file near midnight goes
  // to the right event rather than to whichever day was asked for first).
  const bufferMs = Math.max(0, bufferMin) * 60_000
  const timed = ofDay.filter((e) => !e.all_day && e.end_ms - e.start_ms <= LONG_EVENT_MS)
  let events = ofDay
  let files: FileRow[] = []
  if (timed.length > 0) {
    const from = Math.min(...timed.map((e) => e.start_ms)) - bufferMs
    const to = Math.max(...timed.map((e) => e.end_ms)) + bufferMs
    const neighbours = db
      .prepare(
        `SELECT calendar_id, event_id, summary, location, all_day, start_ms, end_ms, recurring_event_id
         FROM calendar_events WHERE start_ms <= ? AND end_ms >= ? AND all_day = 0`
      )
      .all(to + bufferMs, from - bufferMs) as EventRow[]
    const seen = new Set(ofDay.map((e) => keyOf(e.calendar_id, e.event_id)))
    events = ofDay.concat(neighbours.filter((e) => !seen.has(keyOf(e.calendar_id, e.event_id))))
    // files.date is a UTC ISO string, so a string range uses the volume's date index.
    files = db
      // Only files whose time is evidence (eventMatch.EVIDENCE_SOURCES): on a
      // real busy day 5,376 of 5,386 rows were bulk copies with file dates.
      .prepare(
        `SELECT ${FILE_COLS} FROM files WHERE volume_id = ? AND ${LIVE} AND date >= ? AND date <= ?
           AND date_source IN (${EVIDENCE_SOURCES.map(() => '?').join(',')})`
      )
      .all(volumeId, new Date(from).toISOString(), new Date(to).toISOString(), ...EVIDENCE_SOURCES) as FileRow[]
  }

  // The user's decisions on these events, and on any candidate file (a file
  // confirmed for another event is not suggested here). Decisions are few -
  // one per click - so the volume's are read in one query, not per file: a
  // per-file lookup cost 5,386 queries and ~79 ms on a real busy day.
  const eventKeys = new Set(events.map((e) => keyOf(e.calendar_id, e.event_id)))
  const candidatePaths = new Set(files.map((f) => f.path))
  const decisions: Decision[] = (
    db.prepare('SELECT path, volume_id, calendar_id, event_id, state FROM event_file_links WHERE volume_id IS ?').all(volumeId) as {
      path: string
      volume_id: string | null
      calendar_id: string
      event_id: string
      state: LinkState
    }[]
  )
    .map((r) => ({ path: r.path, volume_id: r.volume_id, key: keyOf(r.calendar_id, r.event_id), state: r.state }))
    .filter((d) => eventKeys.has(d.key) || candidatePaths.has(d.path))

  // Files the user linked by hand can sit outside the window; fetch them. A
  // link to a file that is gone or in the trash shows nothing.
  const byPath = new Map(files.map((f) => [f.path, f]))
  for (const d of decisions) {
    if (d.state === 'rejected' || byPath.has(d.path)) continue
    const row = db.prepare(`SELECT ${FILE_COLS} FROM files WHERE path = ? AND volume_id IS ? AND ${LIVE}`).get(d.path, volumeId) as FileRow | undefined
    if (row) byPath.set(row.path, row)
  }
  const live = decisions.filter((d) => d.state === 'rejected' || byPath.has(d.path))

  const matchEvents: MatchEvent[] = events.map((e) => ({ key: keyOf(e.calendar_id, e.event_id), start_ms: e.start_ms, end_ms: e.end_ms, all_day: e.all_day }))
  const matchFilesIn: MatchFile[] = [...byPath.values()].map((f) => ({ path: f.path, volume_id: f.volume_id, ext: f.ext, t: Date.parse(f.date), source: f.date_source }))
  const matched = matchFiles(matchEvents, matchFilesIn, live, bufferMin)

  return ofDay.map((e) => ({
    calendarId: e.calendar_id,
    eventId: e.event_id,
    summary: e.summary,
    location: e.location,
    allDay: !!e.all_day,
    startMs: e.start_ms,
    endMs: e.end_ms,
    recurring: !!e.recurring_event_id,
    files: (matched.get(keyOf(e.calendar_id, e.event_id)) ?? [])
      .map((m) => {
        const f = byPath.get(m.path)!
        const { date_source, ...row } = f
        void date_source // provenance stays in main; the panel shows the date itself
        return { ...row, score: m.score, status: m.status }
      })
      .sort((a, b) => a.date.localeCompare(b.date))
  }))
}

export function setLink(db: CalDb, op: LinkOp, path: string, volumeId: string | null, calendarId: string, eventId: string, now = new Date()): void {
  if (op === 'undo') {
    db.prepare('DELETE FROM event_file_links WHERE path = ? AND volume_id IS ? AND calendar_id = ? AND event_id = ?').run(path, volumeId, calendarId, eventId)
    return
  }
  const state: LinkState = op === 'confirm' ? 'confirmed' : op === 'reject' ? 'rejected' : 'manual'
  db.prepare('INSERT OR REPLACE INTO event_file_links (path, volume_id, calendar_id, event_id, state, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    path,
    volumeId,
    calendarId,
    eventId,
    state,
    now.toISOString()
  )
}

/**
 * Local days that have at least one event, for deciding which day headers
 * look for events at all. Multi-day events count on each day (capped: a
 * months-long entry is context for its first weeks, not for every header).
 */
export function eventDays(db: CalDb): string[] {
  const rows = db.prepare('SELECT DISTINCT start_day, end_day FROM calendar_events').all() as { start_day: string; end_day: string }[]
  const days = new Set<string>()
  for (const r of rows) {
    const [y, m, d] = r.start_day.split('-').map(Number)
    for (let i = 0; i < 31; i++) {
      const t = new Date(y, m - 1, d + i)
      const key = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
      if (key > r.end_day) break
      days.add(key)
    }
  }
  return [...days]
}
