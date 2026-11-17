import * as fs from 'fs'
import { MPEG_TS_HEAD_BYTES, SNIFFED_VIDEO_EXTS, isGeneratedAsset, isIndexableUserMedia, looksLikeMpegTs } from './validation.ts'

/**
 * The content check every indexing path applies on top of the extension list.
 *
 * Only .ts/.mts need it: the same extensions name TypeScript sources, and a
 * code folder must not fill the gallery with "videos". Reads the first 400
 * bytes; an unreadable file is not indexed now and is picked up by a later
 * pass once it can be read.
 */
export function passesContentCheck(filePath: string, ext: string): boolean {
  if (!SNIFFED_VIDEO_EXTS.includes(ext.toLowerCase())) return true
  let fd: number | undefined
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(MPEG_TS_HEAD_BYTES)
    const n = fs.readSync(fd, buf, 0, MPEG_TS_HEAD_BYTES, 0)
    return looksLikeMpegTs(buf.subarray(0, n))
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * Whether to index this path: the name decides for every type except .ts/.mts,
 * which are read. What the watcher and single-file paths use.
 */
export function isIndexableMediaFile(filePath: string): boolean {
  if (isIndexableUserMedia(filePath)) return true
  const slash = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'))
  const dot = filePath.lastIndexOf('.')
  if (dot <= slash + 1) return false
  const ext = filePath.slice(dot).toLowerCase()
  return SNIFFED_VIDEO_EXTS.includes(ext) && !isGeneratedAsset(filePath) && passesContentCheck(filePath, ext)
}
