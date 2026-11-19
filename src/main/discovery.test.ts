import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  discoverPlaces,
  discoverTrips,
  discoveryRowsSql,
  toGeoItems,
  haversineM,
  DISCOVERY_DEFAULTS,
  type GeoItem
} from './discovery.ts'
import type { Discovered } from './collections.ts'

// ── Synthetic histories ─────────────────────────────────────────────────────
// Deterministic, so a threshold change that breaks a scenario fails the same
// way every run. Coordinates are real places; distances are what matter.

const BLR_HOME = { lat: 12.9352, lng: 77.6245 } // Koramangala
const BLR_COLLEGE = { lat: 12.9716, lng: 77.5946 } // ~5.4 km away
const BLR_WORK = { lat: 12.9784, lng: 77.6408 } // Indiranagar, ~5 km
const MYSORE = { lat: 12.3052, lng: 76.6552 } // ~125 km
const GOA = { lat: 15.5439, lng: 73.7553 }
const DELHI = { lat: 28.6139, lng: 77.209 }
const KERALA = { lat: 9.4981, lng: 76.3388 }
const PUNE = { lat: 18.5204, lng: 73.8567 }
const HYD = { lat: 17.385, lng: 78.4867 }
const DAY = 86_400_000
const T0 = Date.UTC(2025, 0, 1, 4) // 09:30 IST

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}
const r = rng(42)
let seq = 0
/** `n` items on `day` within `spreadM` metres of `at`. */
function shoot(at: { lat: number; lng: number }, day: number, n: number, spreadM = 40, vol = 'VOL-A'): GeoItem[] {
  const out: GeoItem[] = []
  for (let i = 0; i < n; i++) {
    const dy = (r() - 0.5) * 2 * spreadM
    const dx = (r() - 0.5) * 2 * spreadM
    out.push({
      path: `E:\\DCIM\\IMG_${String(++seq).padStart(5, '0')}.JPG`,
      volumeId: vol,
      lat: at.lat + dy / 111_320,
      lng: at.lng + dx / (111_320 * Math.cos((at.lat * Math.PI) / 180)),
      t: T0 + day * DAY + i * 60_000,
      day
    })
  }
  return out
}
/** Ordinary life: a few photos at one of `spots` on most days in [from, to). */
function routine(spots: { lat: number; lng: number }[], from: number, to: number, everyNDays = 2): GeoItem[] {
  const out: GeoItem[] = []
  for (let d = from; d < to; d += everyNDays) out.push(...shoot(spots[d % spots.length], d, 3))
  return out
}
const trips = (items: GeoItem[], home: { lat: number; lng: number } | null = null): Discovered[] => discoverTrips(items, { home })
const near = (a: { lat: number; lng: number }, b: { lat: number; lng: number }, km: number): boolean => haversineM(a, b) < km * 1000

// ── Places ──────────────────────────────────────────────────────────────────

test('home, college and workplace are three places, not one blob', () => {
  const items = [...routine([BLR_HOME, BLR_COLLEGE, BLR_WORK], 0, 180, 1)]
  const places = discoverPlaces(items)
  assert.equal(places.length, 3)
  for (const spot of [BLR_HOME, BLR_COLLEGE, BLR_WORK]) assert.ok(places.some((p) => near(p, spot, 0.2)), JSON.stringify(spot))
  for (const p of places) assert.ok(p.radiusM < 150, `compact: ${p.radiusM}`)
})

test('two venues 350 m apart joined by a walk of photos stay separate places', () => {
  const cafe = { lat: 15.4989, lng: 73.8278 }
  const museum = { lat: 15.5019, lng: 73.8278 } // ~334 m north
  const items: GeoItem[] = []
  for (let d = 0; d < 6; d++) items.push(...shoot(cafe, d, 8, 25), ...shoot(museum, d, 8, 25))
  // A photo every ~40 m along the walk between them, once.
  for (let k = 1; k < 8; k++) items.push(...shoot({ lat: cafe.lat + (museum.lat - cafe.lat) * (k / 8), lng: cafe.lng }, 3, 1, 1))
  const places = discoverPlaces(items)
  assert.equal(places.length, 2, places.map((p) => `${p.members.length}@${p.radiusM}`).join(' '))
  assert.ok(places.some((p) => near(p, cafe, 0.08)))
  assert.ok(places.some((p) => near(p, museum, 0.08)))
})

test('a big venue photographed all over is one place, not shredded', () => {
  const park = { lat: 12.9763, lng: 77.5929 } // Cubbon Park
  const items: GeoItem[] = []
  for (let d = 0; d < 10; d++) items.push(...shoot(park, d * 7, 12, 220))
  const places = discoverPlaces(items)
  assert.equal(places.length, 1)
  assert.equal(places[0].members.length, 120)
})

test('a handful of photos somewhere is not a place', () => {
  assert.equal(discoverPlaces(shoot(GOA, 0, DISCOVERY_DEFAULTS.placeMinItems - 1)).length, 0)
})

test('place confidence grows with photos and distinct days', () => {
  const lots = discoverPlaces(routine([BLR_HOME], 0, 60, 1))
  assert.equal(lots[0].confidence, 'high')
  const once = discoverPlaces(shoot(GOA, 0, 10))
  assert.equal(once[0].confidence, 'low')
})

test('thousands of photos at one spot stay fast and in one place', () => {
  const items: GeoItem[] = []
  for (let d = 0; d < 400; d++) items.push(...shoot(BLR_HOME, d, 50, 30))
  const t = Date.now()
  const places = discoverPlaces(items)
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`)
  assert.equal(places.length, 1)
  assert.equal(places[0].members.length, 20_000)
})

// ── Trips ───────────────────────────────────────────────────────────────────

test('a commuter between home, college and work has no trips', () => {
  assert.deepEqual(trips(routine([BLR_HOME, BLR_COLLEGE, BLR_WORK], 0, 365, 1)), [])
})

test('a weekend in Mysore is a two-day trip holding only the Mysore photos', () => {
  const items = [...routine([BLR_HOME, BLR_COLLEGE], 0, 120), ...shoot(MYSORE, 61, 15), ...shoot(MYSORE, 62, 10)]
  const t = trips(items)
  assert.equal(t.length, 1)
  assert.equal(t[0].members.length, 25)
  assert.ok(near(t[0], MYSORE, 5))
  assert.equal(new Date(t[0].startMs).getUTCDate(), new Date(T0 + 61 * DAY).getUTCDate())
  assert.notEqual(t[0].confidence, 'low')
})

test('a day trip is not a trip (multi-day only)', () => {
  assert.deepEqual(trips([...routine([BLR_HOME], 0, 120), ...shoot(MYSORE, 61, 30)]), [])
})

test('a month in Goa is found even when it has more photo-days than home life around it', () => {
  // Home: one photo-day a week. Goa: every day for 30 days.
  const items = [...routine([BLR_HOME], 0, 200, 7)]
  for (let d = 90; d < 120; d++) items.push(...shoot(GOA, d, 16, 2000))
  const t = trips(items)
  assert.equal(t.length, 1)
  assert.equal(t[0].members.length, 480)
  assert.ok(near(t[0], GOA, 10))
})

test('someone who only takes photos on trips still gets each trip, as low-confidence suggestions', () => {
  const items = [...shoot(GOA, 10, 20), ...shoot(GOA, 11, 20), ...shoot(DELHI, 100, 20), ...shoot(DELHI, 102, 20), ...shoot(KERALA, 220, 20), ...shoot(KERALA, 221, 20)]
  const t = trips(items)
  assert.equal(t.length, 3, t.map((x) => `${x.lat},${x.lng}`).join(' '))
  assert.ok(t.every((x) => x.confidence === 'low'))
})

test('a stint in one city between two moves is not a trip, even with a home set', () => {
  const items = [...routine([BLR_HOME], 0, 100, 1), ...routine([PUNE], 100, 130, 1), ...routine([DELHI], 130, 400, 1)]
  assert.deepEqual(trips(items, BLR_HOME), [])
})

test('moving to another city is not a trip', () => {
  const items = [...routine([BLR_HOME, BLR_WORK], 0, 120, 1), ...routine([PUNE], 120, 300, 1)]
  assert.deepEqual(trips(items), [])
})

test('home is never inferred from the most-photographed place: a family-home visit is a suggestion, and gone once home is set', () => {
  // Lives in Bangalore for college; family home is Hyderabad.
  const items = [...routine([BLR_COLLEGE, BLR_HOME], 0, 300, 1)]
  for (let d = 150; d < 160; d++) items.push(...shoot(HYD, d, 6))
  for (let d = 200; d < 203; d++) items.push(...shoot(GOA, d, 10))
  const withoutHome = trips(items)
  assert.equal(withoutHome.length, 2)
  const withHome = trips(items, HYD)
  assert.equal(withHome.length, 1, 'the family home is not a trip once the user says it is home')
  assert.ok(near(withHome[0], GOA, 5))
  assert.equal(withHome[0].confidence, 'high')
})

test('a gap of one empty day inside a trip does not split it; a long gap does', () => {
  const base = routine([BLR_HOME], 0, 200, 2)
  const one = trips([...base, ...shoot(GOA, 101, 10), ...shoot(GOA, 103, 10)])
  assert.equal(one.length, 1)
  assert.equal(one[0].members.length, 20)
  const split = trips([...base, ...shoot(GOA, 101, 10), ...shoot(GOA, 102, 10), ...shoot(GOA, 120, 10), ...shoot(GOA, 121, 10)])
  assert.equal(split.length, 2)
})

test('trips keep each photo on its own drive', () => {
  const items = [...routine([BLR_HOME], 0, 120), ...shoot(MYSORE, 61, 6, 40, 'VOL-A'), ...shoot(MYSORE, 62, 6, 40, 'VOL-B')]
  const t = trips(items)
  assert.equal(t.length, 1)
  assert.deepEqual([...new Set(t[0].members.map((m) => m.volumeId))].sort(), ['VOL-A', 'VOL-B'])
})

test('thresholds are configurable', () => {
  const items = [...routine([BLR_HOME], 0, 120), ...shoot(MYSORE, 61, 15), ...shoot(MYSORE, 62, 10)]
  assert.equal(discoverTrips(items, { home: null, tripAwayKm: 200 }).length, 0)
})

// ── What discovery may read ─────────────────────────────────────────────────

test('only reliable capture times with real coordinates are read, videos included', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT, ext TEXT, date TEXT, lat REAL, lng REAL, volume_id TEXT,
    hidden INTEGER DEFAULT 0, trashed_at TEXT, date_source TEXT, date_offset_min INTEGER)`)
  const add = db.prepare('INSERT INTO files (path, ext, date, lat, lng, volume_id, date_source, date_offset_min, hidden, trashed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const at = '2026-01-04T05:00:00.000Z'
  add.run('E:\\ok-offset.jpg', '.jpg', at, 15.5, 73.8, 'A', 'exif-offset', 330, 0, null)
  add.run('E:\\ok-exif.jpg', '.jpg', at, 15.5, 73.8, 'A', 'exif', null, 0, null)
  add.run('E:\\ok-video.mov', '.mov', at, 15.5, 73.8, 'A', 'quicktime', null, 0, null)
  add.run('E:\\mtime.jpg', '.jpg', at, 15.5, 73.8, 'A', 'mtime', null, 0, null)
  add.run('E:\\birth.jpg', '.jpg', at, 15.5, 73.8, 'A', 'birthtime', null, 0, null)
  add.run('E:\\unknown.jpg', '.jpg', at, 15.5, 73.8, 'A', null, null, 0, null)
  add.run('E:\\nogps.jpg', '.jpg', at, null, null, 'A', 'exif', null, 0, null)
  add.run('E:\\null-island.jpg', '.jpg', at, 0, 0, 'A', 'exif', null, 0, null)
  add.run('E:\\hidden.jpg', '.jpg', at, 15.5, 73.8, 'A', 'exif', null, 1, null)
  add.run('E:\\trashed.jpg', '.jpg', at, 15.5, 73.8, 'A', 'exif', null, 0, 'x')
  add.run('F:\\other-volume.jpg', '.jpg', at, 15.5, 73.8, 'B', 'exif', null, 0, null)
  const q = discoveryRowsSql(['A'])
  const rows = db.prepare(q.sql).all(...(q.params as string[])) as Parameters<typeof toGeoItems>[0]
  assert.deepEqual(rows.map((x) => x.path).sort(), ['E:\\ok-exif.jpg', 'E:\\ok-offset.jpg', 'E:\\ok-video.mov'])
  const items = toGeoItems(rows, 330)
  const offset = items.find((i) => i.path === 'E:\\ok-offset.jpg')!
  // 05:00 UTC at +05:30 is 10:30 on the 4th, the photo's own local day.
  assert.equal(offset.day, Math.floor((Date.parse(at) + 330 * 60_000) / DAY))
})
