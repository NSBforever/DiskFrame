/**
 * Local Places and Trips discovery. Pure functions over (path, volume, lat,
 * lng, capture time) - nothing here touches the network, geocodes, or reads a
 * file. Every result is a suggestion the user accepts, edits or dismisses
 * (collections.ts keeps track of which).
 *
 * Only capture times the file itself states are used (EXIF, EXIF with offset,
 * QuickTime): a copy or download date says nothing about where someone was.
 * Videos count exactly like photos when their own metadata has GPS.
 */
import { applyDiscovery, type ColDb, type Confidence, type Discovered, type FileRef } from './collections.ts'
import type { DateSource } from './captureTime.ts'

export interface GeoItem extends FileRef {
  lat: number
  lng: number
  /** Capture time, epoch ms. */
  t: number
  /** Local calendar day of the capture (days since epoch, in the photo's own zone when known). */
  day: number
}

/**
 * Every threshold in one place, overridable per call. The defaults are what
 * discovery.test.ts's synthetic histories (commuter, weekend away, long trip,
 * trip-only photographer, relocation, family-home visit, adjacent venues, big
 * park) were validated against.
 */
export const DISCOVERY_DEFAULTS = {
  /** DBSCAN neighbourhood for the first pass, metres. */
  placeEpsM: 150,
  /** Photos within eps for a point to be "dense". */
  placeMinPts: 5,
  /** Refinement stops below this eps: phone GPS is not better than this. */
  placeMinEpsM: 40,
  /** A place needs at least this many photos. */
  placeMinItems: 8,
  /** Further than this from every anchor (home, usual area) is "away", km. */
  tripAwayKm: 60,
  /** Trips span at least this many calendar days... */
  tripMinDays: 2,
  /** ...and at most this many; longer is living somewhere, not visiting. */
  tripMaxDays: 45,
  /** Empty days allowed inside one trip. */
  tripMaxGapDays: 1,
  tripMinItems: 4,
  /** The usual area for a day is read from photo-days within this many days of it... */
  baselineWindowDays: 180,
  /** ...ignoring this many days either side, so a long trip cannot become its own "usual area". */
  baselineExcludeDays: 14,
  /** Usual-area grid, degrees (~28 km). */
  baselineCellDeg: 0.25,
  /** Photo-days behind a usual area before a trip found against it is more than a guess. */
  baselineMinDays: 4,
  /** Departure and return are compared only when they are this close to the trip. */
  returnWindowDays: 14
}
export interface DiscoveryPrefs {
  /** Find Places and Trips across drives together (opt-in), not drive by drive. */
  crossDrive: boolean
  /** Optional, user-set. Never inferred. */
  home: { lat: number; lng: number } | null
}
export type DiscoveryOptions = Partial<typeof DISCOVERY_DEFAULTS> & { home?: { lat: number; lng: number } | null }

const DAY_MS = 86_400_000
const R = 6_371_000
const rad = (d: number): number => (d * Math.PI) / 180

export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

// ── Reading ─────────────────────────────────────────────────────────────────

export const RELIABLE_SOURCES: DateSource[] = ['exif-offset', 'exif', 'quicktime']

/** Rows discovery may use for these volumes. (0, 0) is a GPS chip's "no fix", not a place. */
export function discoveryRowsSql(volumeIds: string[]): { sql: string; params: unknown[] } {
  return {
    sql: `SELECT path, volume_id, lat, lng, date, date_offset_min FROM files
          WHERE volume_id IN (${volumeIds.map(() => '?').join(',') || 'NULL'})
            AND hidden = 0 AND trashed_at IS NULL AND date IS NOT NULL
            AND date_source IN (${RELIABLE_SOURCES.map((s) => `'${s}'`).join(',')})
            AND lat IS NOT NULL AND lng IS NOT NULL AND NOT (lat = 0 AND lng = 0)
            AND lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180`,
    params: volumeIds
  }
}

/**
 * Rows to items. The day is the photo's own local day when it recorded its
 * UTC offset, else `fallbackOffsetMin` (the machine's zone, as the gallery uses).
 */
export function toGeoItems(
  rows: { path: string; volume_id: string; lat: number; lng: number; date: string; date_offset_min: number | null }[],
  fallbackOffsetMin: number | ((t: number) => number)
): GeoItem[] {
  const out: GeoItem[] = []
  for (const r of rows) {
    const t = Date.parse(r.date)
    if (!Number.isFinite(t)) continue
    const off = r.date_offset_min ?? (typeof fallbackOffsetMin === 'function' ? fallbackOffsetMin(t) : fallbackOffsetMin)
    out.push({ path: r.path, volumeId: r.volume_id, lat: r.lat, lng: r.lng, t, day: Math.floor((t + off * 60_000) / DAY_MS) })
  }
  return out
}

// ── Places ──────────────────────────────────────────────────────────────────

/** Items snapped to ~11 m cells: thousands of photos taken in one room are one weighted point. */
interface Pt {
  x: number
  y: number
  lat: number
  lng: number
  w: number
  items: GeoItem[]
}

function snap(items: GeoItem[]): Pt[] {
  const cells = new Map<string, GeoItem[]>()
  for (const it of items) {
    const k = Math.round(it.lat * 1e4) + ':' + Math.round(it.lng * 1e4)
    const c = cells.get(k)
    if (c) c.push(it)
    else cells.set(k, [it])
  }
  const out: Pt[] = []
  for (const its of cells.values()) {
    let lat = 0
    let lng = 0
    for (const i of its) {
      lat += i.lat
      lng += i.lng
    }
    lat /= its.length
    lng /= its.length
    // Local equirectangular metres: exact enough at the scale of a venue.
    out.push({ x: lng * 111_320 * Math.cos(rad(lat)), y: lat * 110_574, lat, lng, w: its.length, items: its })
  }
  return out
}

/** Weighted DBSCAN on a grid index. Returns clusters; noise is dropped. */
function dbscan(pts: Pt[], eps: number, minPts: number): Pt[][] {
  const grid = new Map<string, number[]>()
  const key = (cx: number, cy: number): string => cx + ':' + cy
  pts.forEach((p, i) => {
    const k = key(Math.floor(p.x / eps), Math.floor(p.y / eps))
    const g = grid.get(k)
    if (g) g.push(i)
    else grid.set(k, [i])
  })
  const eps2 = eps * eps
  const neighbours = (i: number): number[] => {
    const p = pts[i]
    const cx = Math.floor(p.x / eps)
    const cy = Math.floor(p.y / eps)
    const out: number[] = []
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of grid.get(key(cx + dx, cy + dy)) ?? []) {
          const q = pts[j]
          if ((q.x - p.x) ** 2 + (q.y - p.y) ** 2 <= eps2) out.push(j)
        }
    return out
  }
  const weightOf = (ns: number[]): number => ns.reduce((s, j) => s + pts[j].w, 0)
  const label = new Int32Array(pts.length).fill(-1) // -1 unvisited, -2 noise
  const clusters: Pt[][] = []
  for (let i = 0; i < pts.length; i++) {
    if (label[i] !== -1) continue
    const ns = neighbours(i)
    if (weightOf(ns) < minPts) {
      label[i] = -2
      continue
    }
    const c = clusters.length
    const members: Pt[] = []
    clusters.push(members)
    label[i] = c
    members.push(pts[i])
    const queue = ns.filter((j) => j !== i)
    while (queue.length) {
      const j = queue.pop()!
      if (label[j] === -2) {
        label[j] = c // border point
        members.push(pts[j])
      }
      if (label[j] !== -1) continue
      label[j] = c
      members.push(pts[j])
      const nj = neighbours(j)
      if (weightOf(nj) >= minPts) for (const k of nj) if (label[k] === -1 || label[k] === -2) queue.push(k)
    }
  }
  return clusters
}

const weight = (c: Pt[]): number => c.reduce((s, p) => s + p.w, 0)

/**
 * Splits a cluster while it holds two or more dense cores that a looser
 * neighbourhood had chained together (two venues joined by a walk of photos),
 * halving the neighbourhood each time down to placeMinEpsM. A cluster that
 * stays one core at a tighter radius is one place, however big.
 */
function refine(c: Pt[], eps: number, o: typeof DISCOVERY_DEFAULTS): Pt[][] {
  const half = eps / 2
  if (half < o.placeMinEpsM) return [c]
  const subs = dbscan(c, half, o.placeMinPts).filter((s) => weight(s) >= o.placeMinItems)
  if (subs.length >= 2) return subs.flatMap((s) => refine(s, half, o))
  return [c]
}

function summarise(items: GeoItem[]): { lat: number; lng: number; radiusM: number; startMs: number; endMs: number; days: number } {
  let lat = 0
  let lng = 0
  let startMs = Infinity
  let endMs = -Infinity
  const days = new Set<number>()
  for (const i of items) {
    lat += i.lat
    lng += i.lng
    startMs = Math.min(startMs, i.t)
    endMs = Math.max(endMs, i.t)
    days.add(i.day)
  }
  lat /= items.length
  lng /= items.length
  // 90th percentile distance: one stray photo does not make a place look huge.
  const dist = items.map((i) => haversineM({ lat, lng }, i)).sort((a, b) => a - b)
  const radiusM = Math.round(dist[Math.min(dist.length - 1, Math.floor(dist.length * 0.9))])
  return { lat, lng, radiusM, startMs, endMs, days: days.size }
}

export function discoverPlaces(items: GeoItem[], opts: DiscoveryOptions = {}): Discovered[] {
  const o = { ...DISCOVERY_DEFAULTS, ...opts }
  const out: Discovered[] = []
  for (const c of dbscan(snap(items), o.placeEpsM, o.placeMinPts)) {
    for (const part of refine(c, o.placeEpsM, o)) {
      const members = part.flatMap((p) => p.items)
      if (members.length < o.placeMinItems) continue
      const s = summarise(members)
      let level = members.length >= 30 && s.days >= 3 ? 2 : members.length >= 15 || s.days >= 2 ? 1 : 0
      if (s.radiusM > 400) level = Math.max(0, level - 1)
      out.push({
        kind: 'place',
        members: members.map(ref),
        lat: s.lat,
        lng: s.lng,
        radiusM: s.radiusM,
        startMs: s.startMs,
        endMs: s.endMs,
        confidence: (['low', 'medium', 'high'] as const)[level]
      })
    }
  }
  return out.sort((a, b) => b.members.length - a.members.length)
}

const ref = (i: GeoItem): FileRef => ({ path: i.path, volumeId: i.volumeId })

// ── Trips ───────────────────────────────────────────────────────────────────

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * Multi-day stretches spent far from where the user usually is.
 *
 * "Usually" is never assumed to be one fixed home: the most-photographed place
 * is often a college or a workplace. Each day is compared with its own usual
 * area - the ~28 km cell with the most photo-days in the months around it,
 * leaving out the fortnight either side so a long trip cannot become its own
 * baseline - and, if the user has set one, with their home. A photo is away
 * when it is far from all of them. Away days (one empty day bridged) that
 * span 2-45 days form a trip, unless the days just before and after it are in
 * different places: that is a move, not a trip.
 *
 * Confidence: high with a user-set home, medium with a well-supported usual
 * area, low otherwise (for instance a library that only has trip photos).
 */
export function discoverTrips(items: GeoItem[], opts: DiscoveryOptions = {}): Discovered[] {
  const o = { ...DISCOVERY_DEFAULTS, ...opts }
  const home = opts.home ?? null
  const awayM = o.tripAwayKm * 1000
  const byDay = new Map<number, GeoItem[]>()
  for (const i of items) {
    const d = byDay.get(i.day)
    if (d) d.push(i)
    else byDay.set(i.day, [i])
  }
  const days = [...byDay.keys()].sort((a, b) => a - b)
  const centre = new Map<number, { lat: number; lng: number }>()
  const cell = new Map<number, string>()
  for (const d of days) {
    const its = byDay.get(d)!
    const c = { lat: median(its.map((i) => i.lat)), lng: median(its.map((i) => i.lng)) }
    centre.set(d, c)
    cell.set(d, Math.floor(c.lat / o.baselineCellDeg) + ':' + Math.floor(c.lng / o.baselineCellDeg))
  }

  // Usual area per day. ponytail: O(days x window); ~2M steps for 30 years of daily photos.
  const lowerBound = (v: number): number => {
    let lo = 0
    let hi = days.length
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (days[m] < v) lo = m + 1
      else hi = m
    }
    return lo
  }
  const baseline = new Map<number, { lat: number; lng: number; support: number } | null>()
  for (const d of days) {
    const tally = new Map<string, { n: number; lat: number; lng: number }>()
    for (let j = lowerBound(d - o.baselineWindowDays); j < days.length && days[j] <= d + o.baselineWindowDays; j++) {
      const dj = days[j]
      if (Math.abs(dj - d) <= o.baselineExcludeDays) continue
      const k = cell.get(dj)!
      const c = centre.get(dj)!
      const t = tally.get(k)
      if (t) {
        t.n++
        t.lat += c.lat
        t.lng += c.lng
      } else tally.set(k, { n: 1, lat: c.lat, lng: c.lng })
    }
    let best: { n: number; lat: number; lng: number } | null = null
    for (const t of tally.values()) if (!best || t.n > best.n) best = t
    baseline.set(d, best ? { lat: best.lat / best.n, lng: best.lng / best.n, support: best.n } : null)
  }

  const awayItems = new Map<number, GeoItem[]>()
  for (const d of days) {
    const anchors: { lat: number; lng: number }[] = []
    if (home) anchors.push(home)
    const b = baseline.get(d)
    if (b) anchors.push(b)
    if (!anchors.length) continue
    const away = byDay.get(d)!.filter((i) => anchors.every((a) => haversineM(a, i) > awayM))
    if (away.length) awayItems.set(d, away)
  }

  const awayDays = [...awayItems.keys()].sort((a, b) => a - b)
  const runs: number[][] = []
  for (const d of awayDays) {
    const last = runs[runs.length - 1]
    if (last && d - last[last.length - 1] <= o.tripMaxGapDays + 1) last.push(d)
    else runs.push([d])
  }

  const out: Discovered[] = []
  for (const run of runs) {
    const first = run[0]
    const last = run[run.length - 1]
    const span = last - first + 1
    if (span < o.tripMinDays || span > o.tripMaxDays) continue
    const members = run.flatMap((d) => awayItems.get(d)!)
    if (members.length < o.tripMinItems) continue
    // Left from one place and came back to it - or a move?
    const inRun = new Set(run)
    const iFirst = lowerBound(first)
    let before: number | null = null
    for (let j = iFirst - 1; j >= 0 && before === null; j--) if (!inRun.has(days[j])) before = days[j]
    let after: number | null = null
    for (let j = lowerBound(last + 1); j < days.length && after === null; j++) if (!inRun.has(days[j])) after = days[j]
    if (
      before !== null &&
      after !== null &&
      first - before <= o.returnWindowDays &&
      after - last <= o.returnWindowDays &&
      haversineM(centre.get(before)!, centre.get(after)!) > awayM &&
      !(home && haversineM(centre.get(after)!, home) <= awayM)
    )
      continue
    const support = Math.max(...run.map((d) => baseline.get(d)?.support ?? 0))
    const s = summarise(members)
    out.push({
      kind: 'trip',
      members: members.map(ref),
      lat: s.lat,
      lng: s.lng,
      radiusM: Math.round(Math.max(...members.map((i) => haversineM(s, i)))),
      startMs: s.startMs,
      endMs: s.endMs,
      confidence: home ? 'high' : support >= o.baselineMinDays ? 'medium' : ('low' as Confidence)
    })
  }
  return out
}

/** Both kinds for one scope, as the main process applies them. */
export function discoverAll(items: GeoItem[], opts: DiscoveryOptions = {}): Discovered[] {
  return [...discoverPlaces(items, opts), ...discoverTrips(items, opts)]
}

export { DAY_MS }

// ── Running it ──────────────────────────────────────────────────────────────

export interface DiscoveryScope {
  /** A volume id (per-drive discovery, the default) or '*' (opt-in, across the listed volumes). */
  scope: string
  volumeIds: string[]
}

/**
 * Reads each scope's reliable geotagged rows, discovers, and records the
 * suggestions. Reads and writes may be different connections (the library
 * worker reads on its read-only one and writes on its own).
 */
export function runDiscovery(
  read: ColDb,
  write: ColDb,
  scopes: DiscoveryScope[],
  opts: DiscoveryOptions,
  nowIso: string,
  fallbackOffsetMin: (t: number) => number
): { scope: string; items: number; added: number; updated: number; removed: number }[] {
  return scopes.map((s) => {
    const q = discoveryRowsSql(s.volumeIds)
    const items = toGeoItems(read.prepare(q.sql).all(...q.params) as Parameters<typeof toGeoItems>[0], fallbackOffsetMin)
    const r = applyDiscovery(write, s.scope, discoverAll(items, opts), nowIso)
    return { scope: s.scope, items: items.length, ...r }
  })
}
