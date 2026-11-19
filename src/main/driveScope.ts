/**
 * Which drives "All Drives" combines: every indexed volume, or a chosen set.
 * Stored as JSON in delete_prefs.drive_scope, by volume id - never by drive
 * letter, which changes as drives come and go.
 */
export type DriveScope = { mode: 'all' } | { mode: 'some'; volumeIds: string[] }
export interface ScopeVolume {
  volumeId: string
  count: number
}

const MAX_IDS = 64
const MAX_ID_LEN = 512

/** A stored or renderer-sent scope, validated. Anything unreadable means all drives. */
export function parseScope(raw: unknown): DriveScope {
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return { mode: 'all' }
    }
  }
  const o = v as { mode?: unknown; volumeIds?: unknown } | null
  if (!o || typeof o !== 'object' || o.mode !== 'some' || !Array.isArray(o.volumeIds)) return { mode: 'all' }
  const ids = o.volumeIds.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= MAX_ID_LEN)
  return { mode: 'some', volumeIds: [...new Set(ids)].slice(0, MAX_IDS) }
}

/** Same value as validation.ts THUMB_VOLUME_OFFLINE (that module is not importable under node:test). */
const THUMB_VOLUME_OFFLINE = '!offline'

/**
 * Marks rows whose own volume is not the one mounted at their letter now:
 * its drive is unplugged, or another drive has that letter. The row stays
 * listed with any thumbnail it already has; without one it reads as "drive
 * not connected" rather than asking for a thumbnail that would be made from
 * whatever the letter holds today. Mutates and returns `rows` (page rows are
 * fresh objects from the reader).
 */
export function markOffline<T extends { path: string; volume_id?: string | null; thumb?: string | null; offline?: boolean }>(
  rows: T[],
  volumeAt: (letter: string) => string | null
): T[] {
  for (const r of rows) {
    if (r.volume_id && volumeAt(r.path.slice(0, 2).toUpperCase()) === r.volume_id) continue
    r.offline = true
    if (!r.thumb || r.thumb === 'NO_FILE') r.thumb = THUMB_VOLUME_OFFLINE
  }
  return rows
}

/** The volume ids a scope stands for now: only volumes the catalogue actually has files for. */
export function resolveScope(scope: DriveScope, volumes: ScopeVolume[]): string[] {
  const indexed = volumes.filter((v) => v.count > 0).map((v) => v.volumeId)
  if (scope.mode === 'all') return indexed
  const want = new Set(scope.volumeIds)
  return indexed.filter((id) => want.has(id))
}
