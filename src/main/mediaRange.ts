import * as fs from 'fs'
import { extname } from 'path'
import { Readable } from 'stream'

/**
 * Serves a local file to the `media:` protocol, honouring byte ranges.
 *
 * Chromium's media pipeline reads video by range. The handler used to return
 * net.fetch('file:///...'), which ignores the request's Range header: every
 * read came back 200 with the whole file, and a 4K .mp4/.mov in a <video>
 * failed with PIPELINE_ERROR_READ while a small file loaded but could not seek.
 * Forwarding the header to net.fetch slices the body but still answers 200
 * with no Content-Range, which fails the same way - so ranges are done here.
 */

export type ByteRange = { start: number; end: number }

/**
 * The single range a `Range` header asks for, clamped to the file.
 * null: no usable header - serve the whole file. 'unsatisfiable': answer 416.
 * Multi-range requests are answered with their first range, which is what
 * media elements ask for anyway.
 */
export function parseRange(
  header: string | null,
  size: number
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  if (m[1] === '') {
    // Suffix range: the last N bytes.
    const n = Number(m[2])
    if (n === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(m[1])
  if (start >= size) return 'unsatisfiable'
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  if (end < start) return 'unsatisfiable'
  return { start, end }
}

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml'
}

export async function fileResponse(
  filePath: string,
  rangeHeader: string | null
): Promise<Response> {
  let size: number
  try {
    const st = await fs.promises.stat(filePath)
    if (!st.isFile()) return new Response('Not found', { status: 404 })
    size = st.size
  } catch {
    return new Response('Not found', { status: 404 })
  }
  const headers: Record<string, string> = {
    'Content-Type': TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes'
  }
  const range = parseRange(rangeHeader, size)
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${size}` }
    })
  }
  const { start, end } = range ?? { start: 0, end: size - 1 }
  headers['Content-Length'] = String(size === 0 ? 0 : end - start + 1)
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  const body =
    size === 0
      ? null
      : (Readable.toWeb(fs.createReadStream(filePath, { start, end })) as ReadableStream)
  return new Response(body, { status: range ? 206 : 200, headers })
}
