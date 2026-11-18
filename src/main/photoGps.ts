import exifr from 'exifr'
import { parseExifOffset, wallAtOffset } from './captureTime.ts'

/** Capture date and position read from a photo's EXIF. */
export interface PhotoMeta {
  date: Date | null
  /** Minutes east of UTC from OffsetTimeOriginal; null = not recorded. */
  offsetMin: number | null
  lat: number | null
  lng: number | null
}

/**
 * Reads the capture date and GPS position of a photo (a path or a buffer).
 *
 * Kept apart from scanner.ts, which opens the database at import, so the
 * reading itself can be tested on its own.
 */
export async function readPhotoMeta(input: string | Buffer): Promise<PhotoMeta> {
  const exif = await exifr.parse(input, {
    // The two Ref tags carry the hemisphere (N/S, E/W). GPSLatitude and
    // GPSLongitude are unsigned, and with only those picked exifr had no sign
    // to apply: every photo west of Greenwich or south of the equator was
    // stored at its mirror image (Mountain View landed in China).
    pick: ['DateTimeOriginal', 'OffsetTimeOriginal', 'GPSLatitude', 'GPSLatitudeRef', 'GPSLongitude', 'GPSLongitudeRef'],
    gps: true
  })
  if (!exif) return { date: null, offsetMin: null, lat: null, lng: null }
  const wall = exif.DateTimeOriginal ? new Date(exif.DateTimeOriginal) : null
  const offsetMin = parseExifOffset(exif.OffsetTimeOriginal)
  return {
    date: wall && offsetMin !== null ? wallAtOffset(wall, offsetMin) : wall,
    offsetMin: wall ? offsetMin : null,
    lat: typeof exif.latitude === 'number' ? exif.latitude : null,
    lng: typeof exif.longitude === 'number' ? exif.longitude : null
  }
}
