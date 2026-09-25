/**
 * Pure predicates shared by the main process. Deliberately free of imports so
 * they can be exercised directly by `npm test` without booting Electron or
 * opening the database.
 */

export const photoExts = ['.jpg', '.jpeg', '.png', '.heic', '.raw', '.cr2', '.nef', '.webp']
export const videoExts = ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.wmv', '.webm']
export const docExts = ['.pdf', '.docx', '.doc', '.txt', '.xlsx', '.pptx', '.csv']
export const allExts = [...photoExts, ...videoExts, ...docExts]
/** Formats a thumbnail can actually be produced from. */
export const thumbnailExts = ['.jpg', '.jpeg', '.png', '.webp', '.heic', ...videoExts]

function extensionOf(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'))
  const name = filePath.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  // A leading dot is a dotfile, not an extension ("Local State" has none at all).
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/**
 * Whether this app indexes the file at all.
 *
 * The scan pass filters by extension, but the filesystem watcher did not, so
 * ordinary desktop activity filed .ts, .json, .db, settings.dat and
 * extensionless files like "Local State" into a media index - and then queued
 * each one for thumbnail generation.
 */
export function isIndexableMedia(filePath: string): boolean {
  return allExts.includes(extensionOf(filePath))
}

export function canHaveThumbnail(filePath: string): boolean {
  return thumbnailExts.includes(extensionOf(filePath))
}

/**
 * Assets DiskFrame produced itself, which must never enter the media index.
 *
 * Every generated thumbnail was being indexed as a photo in its own right, so
 * each video and photo appeared twice: once as itself, and once as a tile
 * showing its own thumbnail. Measured on a real library: 25,974 such rows, of
 * which 25,873 were exactly some other row's `thumb`.
 *
 * `vault/` is deliberately NOT excluded - that holds real user media the app
 * moved there, and those rows are genuine.
 */
const GENERATED_DIR_SEGMENTS = [
  'diskframe\\thumbs\\',
  'diskframe\\heic_cache\\',
  'diskframe\\transcoded\\',
  'diskframe-diagnostics\\thumbs\\',
  'node_modules\\',
  // The app's own build output, which ships sample imagery.
  'diskframe\\out\\',
  'diskframe\\dist\\'
]

export function isGeneratedAsset(filePath: string): boolean {
  if (typeof filePath !== 'string' || !filePath) return false
  const p = filePath.toLowerCase().replace(/\//g, '\\')
  for (const seg of GENERATED_DIR_SEGMENTS) if (p.includes(seg)) return true
  // Temporary frames extracted while building a video thumbnail.
  const slash = p.lastIndexOf('\\')
  const name = slash === -1 ? p : p.slice(slash + 1)
  if (name.startsWith('df_raw_')) return true
  return false
}

/** Indexable AND not something the app generated. */
export function isIndexableUserMedia(filePath: string): boolean {
  return isIndexableMedia(filePath) && !isGeneratedAsset(filePath)
}

/** Absolute local paths only - no UNC shares, no relative or traversal input. */
export function isSafeLocalPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false
  if (value.includes('\0')) return false
  if (value.startsWith('\\\\')) return false
  return /^[A-Za-z]:[\\/]/.test(value)
}

/** Drive letters only ("C:"). Everything crossing IPC as a drive is checked. */
export function normalizeDrive(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const m = value.trim().toUpperCase().match(/^([A-Z]):/)
  return m ? `${m[1]}:` : null
}

export function safePathList(value: unknown, limit = 10000): string[] {
  if (!Array.isArray(value)) return []
  return value.filter(isSafeLocalPath).slice(0, limit)
}

/**
 * A capture date is only usable if it is real: not missing, not unparseable,
 * not an epoch-ish value (what a zeroed timestamp field decodes to) and not in
 * the future. Anything that fails leaves the existing filesystem date in place,
 * so a file is never stamped with "today" or 1970.
 */
export function isUsableCaptureDate(d: Date | null | undefined): boolean {
  if (!d || isNaN(d.getTime())) return false
  const t = d.getTime()
  // 1980-01-01: earlier than any digital camera photo, and safely past the
  // epoch values that zeroed or garbage timestamp fields decode to.
  if (t < 315532800000) return false
  if (t > Date.now() + 24 * 3600 * 1000) return false
  return true
}

/**
 * True when a sync's "these files are gone" result is too large to believe.
 *
 * An unplugged drive, or one whose letter was reassigned to a different volume,
 * makes every stat() fail, so the sync reports the entire index as removed.
 * Acting on that deletes the user's index - and their cached thumbnails - for
 * media that is still intact on the volume.
 */
export function isMassRemoval(removedCount: number, knownCount: number): boolean {
  return removedCount > 100 && removedCount > knownCount * 0.5
}

/**
 * Sent to the renderer (never written to the database) when the main process
 * has established that a file cannot produce a thumbnail - it is missing,
 * unreadable, or the decoder rejected it.
 *
 * Without this a video whose file is gone has no thumbnail and no <img> to
 * fail, so its tile is indistinguishable from one that is still waiting, and
 * stays "loading" for the rest of the session. Writing a marker like this into
 * the thumb *column* is what the old NO_FILE sentinel did; that poisoned the
 * backfill query and had to be migrated out, so this one stays in memory only.
 */
export const THUMB_UNAVAILABLE = '!unavailable'

/**
 * Sent instead of THUMB_UNAVAILABLE when the failure is that no volume is
 * mounted at that drive letter. Nothing can be concluded about the file
 * itself, so the UI must offer "reconnect the drive", not "missing".
 */
export const THUMB_VOLUME_OFFLINE = '!offline'

/**
 * The file's folder is not where the index recorded it, on a drive that is
 * connected. The user can point the app at the folder's new location, so this
 * is a question rather than a failure - quite different from a deleted file.
 */
export const THUMB_FOLDER_MISSING = '!folder-missing'

/** The file is there but cannot be read: a permission problem, not a miss. */
export const THUMB_NO_ACCESS = '!no-access'
