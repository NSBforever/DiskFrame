import type { CalDb } from './calendarStore.ts'
import { matchFiles, EVIDENCE_SOURCES, suggests, type Decision, type LinkState, type MatchEvent } from './eventMatch.ts'
import { PHOTO_EXTS, VIDEO_EXTS } from './libraryQuery.ts'
import type { DayFile, EventCard, EventDetail, EventsList, LinkOp, OtherEvent } from './calendarTypes.ts'

/**
 * The Events section's data: every calendar event with the photos and videos
 * the Stage 7 matcher (eventMatch.ts) places in it, plus the user's own
 * decisions. Reads only the existing index and the calendar cache.
 *
 * Events compete for files only with events whose windows overlap theirs, so
 * the calendar is matched in CLUSTERS: events sorted by start, merged while
 * their [start - buffer, end + buffer] windows overlap. A cluster sees exactly
 * the files in its window. The list and an event's own page compute the same
 * cluster, so they always agree on which files belong where.
 */

export const keyOf = (calendarId: string, eventId: string): string => `${calendarId}\u0000${eventId}`

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

const EVENT_COLS = 'calendar_id, event_id, summary, location, all_day, start_ms, end_ms, recurring_event_id'
const FILE_COLS = 'path, volume_id, name, ext, thumb, date, date_source, size, year, month, lat, lng, drive, favourited'
const LIVE = 'f.hidden = 0 AND f.trashed_at IS NULL'
const EVIDENCE = `date_source IN (${EVIDENCE_SOURCES.map((s) => `'${s}'`).join(',')})`

const windowOf = (e: EventRow, bufferMs: number): [number, number] => [e.start_ms - bufferMs, e.end_ms + bufferMs]
const toMatch = (e: EventRow): MatchEvent => ({ key: keyOf(e.calendar_id, e.event_id), start_ms: e.start_ms, end_ms: e.end_ms, all_day: e.all_day })
const canSuggest = (e: EventRow): boolean => suggests(toMatch(e))

/** Clusters of suggestible events whose windows overlap (input sorted by start). */
function clusters(events: EventRow[], bufferMs: number): EventRow[][] {
  const out: EventRow[][] = []
  let cur: EventRow[] = []
  let end = -Infinity
  for (const e of events) {
    const [s, t] = windowOf(e, bufferMs)
    if (cur.length && s > end) {
      out.push(cur)
      cur = []
      end = -Infinity
    }
    cur.push(e)
    end = Math.max(end, t)
  }
  if (cur.length) out.push(cur)
  return out
}

interface LinkRow {
  path: string
  volume_id: string | null
  calendar_id: string
  event_id: string
  state: LinkState
}

/** The user's decisions on this volume, with the rows of files that still exist. */
function decisionsOf(db: CalDb, volumeId: string): { decisions: Decision[]; rows: Map<string, FileRow> } {
  const links = db.prepare('SELECT path, volume_id, calendar_id, event_id, state FROM event_file_links WHERE volume_id IS ?').all(volumeId) as LinkRow[]
  const rows = new Map<string, FileRow>()
  if (links.some((l) => l.state !== 'rejected')) {
    for (const r of db
      .prepare(
        `SELECT DISTINCT ${FILE_COLS.split(', ').map((c) => 'f.' + c).join(', ')} FROM event_file_links l
         JOIN files f ON f.path = l.path AND f.volume_id IS l.volume_id
         WHERE l.volume_id IS ? AND l.state != 'rejected' AND ${LIVE}`
      )
      .all(volumeId) as FileRow[])
      rows.set(r.path, r)
  }
  // A link to a file that is gone or in the trash shows nothing.
  const decisions = links
    .filter((l) => l.state === 'rejected' || rows.has(l.path))
    .map((l) => ({ path: l.path, volume_id: l.volume_id, key: keyOf(l.calendar_id, l.event_id), state: l.state }))
  return { decisions, rows }
}

/** Evidence files in [from, to], sorted by time. The list asks only for what
 *  matching and a cover need (the other columns cost ~2x on 20k rows). */
const SLIM_COLS = 'path, volume_id, ext, date, date_source, thumb'
function evidenceFiles(db: CalDb, volumeId: string, from: number, to: number, cols = FILE_COLS): FileRow[] {
  return db
    .prepare(`SELECT ${cols} FROM files f WHERE f.volume_id = ? AND ${LIVE} AND f.date >= ? AND f.date <= ? AND f.${EVIDENCE} ORDER BY f.date`)
    .all(volumeId, new Date(from).toISOString(), new Date(to).toISOString()) as FileRow[]
}

/** Files of each event in `group` (a whole cluster), decisions included. */
function matchGroup(group: EventRow[], files: FileRow[], decisions: Decision[], decidedRows: Map<string, FileRow>, bufferMin: number): Map<string, DayFile[]> {
  const keys = new Set(group.map((e) => keyOf(e.calendar_id, e.event_id)))
  const paths = new Set(files.map((f) => f.path))
  const relevant = decisions.filter((d) => keys.has(d.key) || paths.has(d.path))
  const byPath = new Map(files.map((f) => [f.path, f]))
  for (const d of relevant) if (d.state !== 'rejected' && !byPath.has(d.path)) byPath.set(d.path, decidedRows.get(d.path)!)
  const matched = matchFiles(
    group.map(toMatch),
    [...byPath.values()].map((f) => ({ path: f.path, volume_id: f.volume_id, ext: f.ext, t: Date.parse(f.date), source: f.date_source })),
    relevant,
    bufferMin
  )
  const out = new Map<string, DayFile[]>()
  for (const [k, list] of matched) {
    out.set(
      k,
      list
        .map((m) => {
          const { date_source, ...row } = byPath.get(m.path)!
          void date_source
          return { ...row, score: m.score, status: m.status }
        })
        .sort((a, b) => a.date.localeCompare(b.date))
    )
  }
  return out
}

/** Confirmed/added photos first, then the best suggestion; a video only if there is no photo. */
export function pickCover(files: DayFile[]): DayFile | null {
  const photos = new Set(PHOTO_EXTS)
  const rank = (f: DayFile): number => (photos.has(f.ext.toLowerCase()) ? 0 : 2) + (f.status === 'suggested' ? 1 : 0)
  return files.slice().sort((a, b) => rank(a) - rank(b) || b.score - a.score || a.date.localeCompare(b.date))[0] ?? null
}

const card = (e: EventRow, files: DayFile[]): EventCard => {
  const cover = pickCover(files)
  return {
    calendarId: e.calendar_id,
    eventId: e.event_id,
    summary: e.summary,
    location: e.location,
    allDay: !!e.all_day,
    startMs: e.start_ms,
    endMs: e.end_ms,
    recurring: !!e.recurring_event_id,
    confirmed: files.filter((f) => f.status !== 'suggested').length,
    suggested: files.filter((f) => f.status === 'suggested').length,
    cover: cover && { path: cover.path, ext: cover.ext, thumb: cover.thumb }
  }
}

/** Every event with files on this volume (newest first), and the rest. */
export function eventCards(db: CalDb, volumeId: string | null, bufferMin: number, now = Date.now()): EventsList {
  if (!volumeId) return { cards: [], others: [] }
  const bufferMs = Math.max(0, bufferMin) * 60_000
  const events = db.prepare(`SELECT ${EVENT_COLS} FROM calendar_events ORDER BY start_ms`).all() as EventRow[]
  const { decisions, rows } = decisionsOf(db, volumeId)
  const filesOf = new Map<string, DayFile[]>()

  const suggestible = events.filter(canSuggest)
  if (suggestible.length) {
    // One read of the volume's evidence files over the calendar's span; each
    // cluster then takes its slice by binary search.
    const all = evidenceFiles(db, volumeId, suggestible[0].start_ms - bufferMs, Math.max(...suggestible.map((e) => e.end_ms)) + bufferMs, SLIM_COLS)
    const times = all.map((f) => Date.parse(f.date))
    const lowerBound = (t: number): number => {
      let lo = 0
      let hi = times.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (times[mid] < t) lo = mid + 1
        else hi = mid
      }
      return lo
    }
    for (const group of clusters(suggestible, bufferMs)) {
      const from = Math.min(...group.map((e) => e.start_ms)) - bufferMs
      const to = Math.max(...group.map((e) => e.end_ms)) + bufferMs
      const slice = all.slice(lowerBound(from), lowerBound(to + 1))
      for (const [k, list] of matchGroup(group, slice, decisions, rows, bufferMin)) filesOf.set(k, list)
    }
  }
  // All-day and long events: only what the user placed there.
  for (const e of events.filter((x) => !canSuggest(x))) {
    filesOf.set(keyOf(e.calendar_id, e.event_id), matchGroup([e], [], decisions, rows, bufferMin).get(keyOf(e.calendar_id, e.event_id)) ?? [])
  }

  const cards: EventCard[] = []
  const others: OtherEvent[] = []
  for (const e of events) {
    const files = filesOf.get(keyOf(e.calendar_id, e.event_id)) ?? []
    if (files.length) cards.push(card(e, files))
    else if (e.start_ms <= now)
      others.push({ calendarId: e.calendar_id, eventId: e.event_id, summary: e.summary, location: e.location, allDay: !!e.all_day, startMs: e.start_ms, endMs: e.end_ms })
  }
  cards.sort((a, b) => b.startMs - a.startMs)
  others.sort((a, b) => b.startMs - a.startMs)
  return { cards, others: others.slice(0, 300) }
}

/** One event's page: the same cluster the list used, so they agree. */
export function eventDetail(db: CalDb, volumeId: string | null, calendarId: string, eventId: string, bufferMin: number): EventDetail | null {
  if (!volumeId) return null
  const target = db.prepare(`SELECT ${EVENT_COLS} FROM calendar_events WHERE calendar_id = ? AND event_id = ?`).get(calendarId, eventId) as EventRow | undefined
  if (!target) return null
  const bufferMs = Math.max(0, bufferMin) * 60_000
  const { decisions, rows } = decisionsOf(db, volumeId)
  let group: EventRow[] = [target]
  let files: FileRow[] = []
  if (canSuggest(target)) {
    // Grow the window until no further suggestible event overlaps it: that
    // is exactly the cluster eventCards() put this event in.
    let [from, to] = windowOf(target, bufferMs)
    for (;;) {
      const near = (db.prepare(`SELECT ${EVENT_COLS} FROM calendar_events WHERE start_ms - ? <= ? AND end_ms + ? >= ? ORDER BY start_ms`).all(bufferMs, to, bufferMs, from) as EventRow[]).filter(canSuggest)
      const f2 = Math.min(from, ...near.map((e) => e.start_ms - bufferMs))
      const t2 = Math.max(to, ...near.map((e) => e.end_ms + bufferMs))
      group = near
      if (f2 === from && t2 === to) break
      from = f2
      to = t2
    }
    files = evidenceFiles(db, volumeId, from, to)
  }
  const key = keyOf(calendarId, eventId)
  const list = matchGroup(group, files, decisions, rows, bufferMin).get(key) ?? []
  const located = list.filter((f) => typeof f.lat === 'number' && typeof f.lng === 'number')
  return {
    calendarId,
    eventId,
    summary: target.summary,
    location: target.location,
    allDay: !!target.all_day,
    startMs: target.start_ms,
    endMs: target.end_ms,
    recurring: !!target.recurring_event_id,
    files: list,
    cover: (() => {
      const c = pickCover(list)
      return c && { path: c.path, ext: c.ext, thumb: c.thumb }
    })(),
    gps: located.length
      ? { lat: located.reduce((s, f) => s + f.lat!, 0) / located.length, lng: located.reduce((s, f) => s + f.lng!, 0) / located.length }
      : null
  }
}

/**
 * Photos and videos the user can add by hand: everything on the event's
 * local day(s), including files whose only date is the filesystem's (which
 * the matcher never suggests). Capped; the event's own files are left out.
 */
export function pickerFiles(db: CalDb, volumeId: string | null, calendarId: string, eventId: string, limit = 600): DayFile[] {
  if (!volumeId) return []
  const e = db.prepare(`SELECT start_ms, end_ms, all_day, start_day, end_day FROM calendar_events WHERE calendar_id = ? AND event_id = ?`).get(calendarId, eventId) as
    | { start_ms: number; end_ms: number; start_day: string; end_day: string }
    | undefined
  if (!e) return []
  const [y1, m1, d1] = e.start_day.split('-').map(Number)
  const [y2, m2, d2] = e.end_day.split('-').map(Number)
  const from = new Date(y1, m1 - 1, d1).getTime()
  const to = new Date(y2, m2 - 1, d2 + 1).getTime()
  const media = [...PHOTO_EXTS, ...VIDEO_EXTS]
  const linked = new Set(
    (db.prepare("SELECT path FROM event_file_links WHERE volume_id IS ? AND calendar_id = ? AND event_id = ? AND state != 'rejected'").all(volumeId, calendarId, eventId) as { path: string }[]).map((r) => r.path)
  )
  return (
    db
      .prepare(
        `SELECT ${FILE_COLS} FROM files f WHERE f.volume_id = ? AND ${LIVE} AND f.date >= ? AND f.date < ?
           AND lower(f.ext) IN (${media.map(() => '?').join(',')}) ORDER BY f.date LIMIT ?`
      )
      .all(volumeId, new Date(from).toISOString(), new Date(to).toISOString(), ...media, limit) as FileRow[]
  )
    .filter((f) => !linked.has(f.path))
    .map(({ date_source, ...row }) => {
      void date_source
      return { ...row, score: 0, status: 'suggested' as const }
    })
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

