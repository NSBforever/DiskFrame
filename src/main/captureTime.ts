/**
 * Where a file's `date` came from, best first. Stored in files.date_source so
 * calendar matching can weigh how far a timestamp can be trusted, and the Info
 * panel can say what the date actually is.
 *
 *   exif-offset  EXIF DateTimeOriginal + OffsetTimeOriginal: an exact instant
 *   exif         DateTimeOriginal without an offset, read as this machine's
 *                local time (right unless the photo was taken in another zone)
 *   quicktime    a video's creation_time (UTC by the spec; some cameras lie)
 *   birthtime    file creation time, used when it is EARLIER than mtime
 *   mtime        file modification time (copies keep it, so it usually beats
 *                birthtime, which a copy resets) - the scan's default
 */
export type DateSource = 'exif-offset' | 'exif' | 'quicktime' | 'birthtime' | 'mtime'

/** EXIF OffsetTime* ("+05:30", "-08:00") to minutes east of UTC, or null. */
export function parseExifOffset(s: unknown): number | null {
  if (typeof s !== 'string') return null
  const m = /^\s*([+-])(\d{2}):?(\d{2})\s*$/.exec(s)
  if (!m) return null
  const min = Number(m[2]) * 60 + Number(m[3])
  if (min > 14 * 60) return null // no real zone is further than UTC+-14
  return m[1] === '-' ? -min : min
}

/**
 * The real instant of an EXIF wall-clock time taken at `offsetMin`.
 *
 * exifr returns DateTimeOriginal as a Date built from the wall clock in THIS
 * machine's zone and ignores OffsetTimeOriginal, so 10:15 in Tokyo read here
 * (UTC+5:30) came out as 04:45Z instead of 01:15Z. The local getters give the
 * wall clock back; it is then placed at the photo's own offset.
 * ponytail: a wall time inside this machine's DST gap can be off by the gap.
 */
export function wallAtOffset(localWall: Date, offsetMin: number): Date {
  const wallAsUtc = Date.UTC(
    localWall.getFullYear(),
    localWall.getMonth(),
    localWall.getDate(),
    localWall.getHours(),
    localWall.getMinutes(),
    localWall.getSeconds(),
    localWall.getMilliseconds()
  )
  return new Date(wallAsUtc - offsetMin * 60_000)
}

/**
 * The filesystem's best guess at when a file was made: the EARLIER of creation
 * and modification time. A Windows copy keeps mtime and resets birthtime to
 * the copy, so birthtime alone would date most copied photos by the day they
 * were copied; an edit moves mtime later, and then birthtime is the better
 * one. A recording is created when it starts and modified when it stops.
 * Two seconds of slack: NTFS and FAT round differently.
 */
export function fsEarliest(mtimeMs: number, birthtimeMs: number | null | undefined): { ms: number; source: 'birthtime' | 'mtime' } {
  if (typeof birthtimeMs === 'number' && birthtimeMs > 0 && birthtimeMs < mtimeMs - 2000) return { ms: birthtimeMs, source: 'birthtime' }
  return { ms: mtimeMs, source: 'mtime' }
}
