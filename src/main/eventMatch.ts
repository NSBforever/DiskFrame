import { PHOTO_EXTS, VIDEO_EXTS } from './libraryQuery.ts'

/**
 * Which local files belong to which calendar event. Local, read-time, and
 * nothing is written: only the user's own decisions are stored
 * (event_file_links). Design: docs/MEMORY_TIMELINE_DESIGN.md section 7.
 *
 * A file is SUGGESTED for an event only when both are true enough:
 *   - its time fits: inside the event = 1.0; in the buffer before/after it
 *     falls from 1.0 at the edge to 0.5 at the buffer's end; outside = 0;
 *   - its timestamp is trustworthy (files.date_source): a camera time with a
 *     zone 1.0, camera/recording time 0.85, a filesystem time 0.3.
 * Score = fit x confidence, suggested at >= 0.6. A file with only a
 * filesystem date therefore never qualifies on time alone - "the file was
 * modified during the meeting" is not evidence it is from the meeting.
 *
 * A burst (files <= 10 min apart) that reaches into the event lifts its
 * members' FIT to the burst's best, never their confidence: a shoot that
 * starts during a meeting and runs past its end stays together.
 *
 * Not suggested at all: all-day events and timed events over 12 hours (a
 * trip, a holiday, a conference entered as one event would claim every photo
 * of those days), and anything that is not a photo or video. The user can
 * still link any file to any event by hand.
 *
 * ponytail: fixed constants below; the buffer setting is the user's knob. Tune
 * them against real confirm/reject decisions once there are some.
 */

export interface MatchEvent {
  /** calendar_id + NUL + event_id */
  key: string
  start_ms: number
  end_ms: number
  all_day: 0 | 1
}

export interface MatchFile {
  path: string
  volume_id: string | null
  ext: string
  /** files.date as ms */
  t: number
  /** files.date_source; null = unknown */
  source: string | null
}

export type LinkState = 'confirmed' | 'rejected' | 'manual'

export interface Decision {
  path: string
  volume_id: string | null
  key: string
  state: LinkState
}

export interface Matched {
  path: string
  volume_id: string | null
  /** 0..1; 1 for the user's own links */
  score: number
  status: 'suggested' | 'confirmed' | 'manual'
}

export const SUGGEST_AT = 0.6
export const BURST_GAP_MS = 10 * 60_000
export const LONG_EVENT_MS = 12 * 3600_000

/** The library's own photo and video lists: documents are never suggested. */
const MEDIA = new Set([...PHOTO_EXTS, ...VIDEO_EXTS])

/** Sources whose time can support a suggestion (confidence >= SUGGEST_AT). */
export const EVIDENCE_SOURCES = ['exif-offset', 'exif', 'quicktime']

export function confidence(source: string | null): number {
  switch (source) {
    case 'exif-offset':
      return 1
    case 'exif':
    case 'quicktime':
      return 0.85
    default:
      return 0.3 // birthtime, mtime, unknown
  }
}

export function timeFit(t: number, e: MatchEvent, bufferMs: number): number {
  if (t >= e.start_ms && t <= e.end_ms) return 1
  const dist = t < e.start_ms ? e.start_ms - t : t - e.end_ms
  if (bufferMs <= 0 || dist > bufferMs) return 0
  return 1 - 0.5 * (dist / bufferMs)
}

export function suggests(e: MatchEvent): boolean {
  return !e.all_day && e.end_ms - e.start_ms <= LONG_EVENT_MS
}

const fileKey = (path: string, volume: string | null): string => `${volume ?? ''}\u0000${path}`

/**
 * Every event's files: the user's links first, then suggestions, each file in
 * at most one event's suggestions (best score; ties to the shorter, then the
 * earlier event). `files` must contain every file a decision names.
 */
export function matchFiles(events: MatchEvent[], files: MatchFile[], decisions: Decision[], bufferMin: number): Map<string, Matched[]> {
  const bufferMs = Math.max(0, bufferMin) * 60_000
  const out = new Map<string, Matched[]>(events.map((e) => [e.key, []]))
  const byEvent = new Map(events.map((e) => [e.key, e]))
  const decided = new Map<string, LinkState>() // fileKey + NUL + eventKey
  const claimed = new Set<string>() // files the user placed in some event
  for (const d of decisions) {
    decided.set(`${fileKey(d.path, d.volume_id)}\u0000${d.key}`, d.state)
    if (d.state !== 'rejected') {
      claimed.add(fileKey(d.path, d.volume_id))
      if (byEvent.has(d.key)) out.get(d.key)!.push({ path: d.path, volume_id: d.volume_id, score: 1, status: d.state === 'manual' ? 'manual' : 'confirmed' })
    }
  }

  // Only files whose time is evidence take part - also in bursts: a copy with
  // a filesystem date must not chain two camera shots together.
  const media = files
    .filter((f) => MEDIA.has(f.ext.toLowerCase()) && confidence(f.source) >= SUGGEST_AT && !claimed.has(fileKey(f.path, f.volume_id)))
    .sort((a, b) => a.t - b.t)
  // Bursts over the whole candidate set, by time.
  const burstOf: number[] = []
  media.forEach((f, i) => burstOf.push(i > 0 && f.t - media[i - 1].t <= BURST_GAP_MS ? burstOf[i - 1] : i))

  const best = new Map<string, { key: string; score: number; span: number; start: number }>()
  for (const e of events) {
    if (!suggests(e)) continue
    const fits = media.map((f) => timeFit(f.t, e, bufferMs))
    // A burst reaching into the event lifts every member's fit to its best.
    const burstFit = new Map<number, number>()
    media.forEach((_, i) => {
      if (fits[i] === 1) burstFit.set(burstOf[i], 1)
    })
    media.forEach((f, i) => {
      if (fits[i] === 0) return // the lift never reaches outside the buffer
      const fit = Math.max(fits[i], burstFit.get(burstOf[i]) ?? 0)
      const score = fit * confidence(f.source)
      if (score < SUGGEST_AT) return
      const k = fileKey(f.path, f.volume_id)
      if (decided.get(`${k}\u0000${e.key}`) === 'rejected') return
      const span = e.end_ms - e.start_ms
      const cur = best.get(k)
      if (!cur || score > cur.score || (score === cur.score && (span < cur.span || (span === cur.span && e.start_ms < cur.start)))) {
        best.set(k, { key: e.key, score, span, start: e.start_ms })
      }
    })
  }
  for (const f of media) {
    const b = best.get(fileKey(f.path, f.volume_id))
    if (b) out.get(b.key)!.push({ path: f.path, volume_id: f.volume_id, score: Math.round(b.score * 100) / 100, status: 'suggested' })
  }
  return out
}
