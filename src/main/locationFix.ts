import { buildWhere, type LibraryQuery } from './libraryQuery.ts'

/**
 * Correcting a wrong position by hand.
 *
 * A photo's position is whatever its file says. Windows Camera on a laptop
 * writes the Windows Location Service's guess, which can be tens of km off:
 * the owner's Vellore webcam shots of 31 Jan 2025 carry a Chennai position.
 * DiskFrame cannot know the truth, so the owner can move or remove it. The
 * correction lives in the catalogue only; the file itself is never changed.
 *
 * `loc_override` = 1 marks a corrected row, and every backfill write below
 * leaves such a row's position alone, so a rescan never brings the wrong
 * position back.
 */

export const LOC_OVERRIDE_COLUMN_SQL = 'ALTER TABLE files ADD COLUMN loc_override INTEGER'

// The EXIF backfill's writes (scanner.ts). Scoped to (path, volume_id); see there.
export const UPDATE_EXIF_SQL = `UPDATE files SET date=?, year=?, month=?,
  lat = CASE WHEN loc_override IS NULL THEN ? ELSE lat END,
  lng = CASE WHEN loc_override IS NULL THEN ? ELSE lng END,
  date_source=?, date_offset_min=? WHERE path=? AND volume_id IS ? AND lat IS NULL`
export const UPDATE_GPS_ONLY_SQL = `UPDATE files SET lat=?, lng=? WHERE path=? AND volume_id IS ? AND lat IS NULL AND loc_override IS NULL`
export const REPAIR_GPS_SQL = `UPDATE files SET lat=?, lng=? WHERE path=? AND volume_id IS ? AND loc_override IS NULL`

/** Back to the position the file itself carries (read by the caller), correction cleared. */
export const RESTORE_LOCATION_SQL = `UPDATE files SET lat = ?, lng = ?, loc_override = NULL WHERE path = ? AND volume_id IS ?`

export type LocationTarget = { lat: number; lng: number } | null

/** null = remove the position; undefined = not a valid request. */
export function parseLocationTarget(v: unknown): LocationTarget | undefined {
  if (v === null) return null
  if (!v || typeof v !== 'object') return undefined
  const { lat, lng } = v as { lat?: unknown; lng?: unknown }
  if (typeof lat !== 'number' || typeof lng !== 'number') return undefined
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined
  return { lat, lng }
}

/**
 * Moves (or, with null, removes) every file the map place's boxed query
 * matches - exactly the files its panel lists. Without a box there is no
 * place, and the whole library is never rewritten: null.
 */
export function setLocationSql(q: LibraryQuery, to: LocationTarget): { sql: string; params: unknown[] } | null {
  if (!q.bbox) return null
  const w = buildWhere(q)
  return {
    sql: `UPDATE files SET lat = ?, lng = ?, loc_override = 1 WHERE ${w.sql}`,
    params: [to?.lat ?? null, to?.lng ?? null, ...w.params]
  }
}
