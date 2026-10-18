import * as fs from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'

const md5 = (s: string): string => createHash('md5').update(s).digest('hex')

/** The names a file's thumbnail can have in the thumbs folder: the legacy
 *  md5(path) key and, with a known volume, the scoped key. Mirrors
 *  thumbKeyFor() in scanner.ts; thumbKey.test.ts pins both. */
export function thumbNames(fullPath: string, volumeId?: string | null): string[] {
  const legacy = md5(fullPath) + '.jpg'
  return volumeId ? [legacy, md5(volumeId + String.fromCharCode(0) + fullPath) + '.jpg'] : [legacy]
}

/**
 * Size limits for the app's own disk caches (transcoded video, HEIC viewer
 * JPEGs, thumbnails).
 *
 * Every cache file DiskFrame writes is named by an md5 and an extension, so
 * only names of that shape are ever considered: a stray user file, a folder or
 * a junction dropped into a cache folder is never deleted or followed. Nothing
 * here is given a path outside the app's own userData caches.
 */
const CACHE_NAME = /^[0-9a-f]{32}\.(jpg|mp4)$/i

interface Entry {
  path: string
  name: string
  size: number
  mtimeMs: number
}

function cacheEntries(dir: string): Entry[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: Entry[] = []
  for (const name of names) {
    if (!CACHE_NAME.test(name)) continue
    const p = join(dir, name)
    try {
      const st = fs.lstatSync(p)
      if (st.isFile()) out.push({ path: p, name, size: st.size, mtimeMs: st.mtimeMs })
    } catch {
      /* removed meanwhile */
    }
  }
  return out
}

function unlinkAll(entries: Entry[]): { removed: number; freed: number } {
  let removed = 0
  let freed = 0
  for (const e of entries) {
    try {
      fs.unlinkSync(e.path)
      removed++
      freed += e.size
    } catch {
      /* in use (being played or served) - it goes next time */
    }
  }
  return { removed, freed }
}

/**
 * Deletes the least recently used cache files until the folder fits in
 * `maxBytes`. "Used" is the mtime: callers touch a file when they serve it from
 * the cache. `keep` (the file just written) is never removed, even if it alone
 * is over budget.
 */
export function pruneToBudget(
  dir: string,
  maxBytes: number,
  keep?: string
): { removed: number; freed: number } {
  const entries = cacheEntries(dir).sort((a, b) => a.mtimeMs - b.mtimeMs)
  let total = entries.reduce((n, e) => n + e.size, 0)
  const doomed: Entry[] = []
  for (const e of entries) {
    if (total <= maxBytes) break
    if (e.path === keep) continue
    doomed.push(e)
    total -= e.size
  }
  return unlinkAll(doomed)
}

/**
 * Deletes cache files whose name is not in `live`, the names the catalogue can
 * still use. Only files last written before `before` are candidates: anything
 * newer may belong to a row added after `live` was read. Asynchronous file by
 * file, so a large sweep (tens of thousands of files) never holds its thread.
 */
export async function sweepOrphans(
  dir: string,
  live: Set<string>,
  before: number
): Promise<{ removed: number; freed: number }> {
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return { removed: 0, freed: 0 }
  }
  let removed = 0
  let freed = 0
  for (const name of names) {
    if (!CACHE_NAME.test(name) || live.has(name.toLowerCase())) continue
    const p = join(dir, name)
    try {
      const st = await fs.promises.lstat(p)
      if (!st.isFile() || st.mtimeMs >= before) continue
      await fs.promises.unlink(p)
      removed++
      freed += st.size
    } catch {
      /* in use or gone - left alone */
    }
  }
  return { removed, freed }
}

/** Marks a cache file as just used, so pruneToBudget keeps it longest. */
export function touch(p: string): void {
  try {
    const now = new Date()
    fs.utimesSync(p, now, now)
  } catch {
    /* best effort */
  }
}

/** Free bytes on the volume holding `dir`; Infinity when it cannot be told,
 *  so a failed probe never blocks the user. */
export function freeBytes(dir: string): number {
  try {
    const s = fs.statfsSync(dir)
    return s.bavail * s.bsize
  } catch {
    return Infinity
  }
}
