import { join, basename, extname, dirname } from 'path'
import * as fs from 'fs'
import * as cp from 'child_process'
import exifr from 'exifr'
import Database from 'better-sqlite3'
import { app, utilityProcess } from 'electron'
import sharp from 'sharp'
import { createHash } from 'crypto'
import { Worker } from 'worker_threads'
import {
  summarySql,
  pageSql,
  countSql,
  groupOffsets,
  type LibraryQuery
} from './libraryQuery'
import {
  isUsableCaptureDate,
  isMassRemoval,
  isIndexableUserMedia,
  videoExts,
  allExts,
  thumbnailExts
} from './validation'

function resolveFfmpeg(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const p = require('ffmpeg-static') as string
    if (p) {
      // Prioritize app.asar.unpacked path so Electron executes it successfully from disk rather than inside ASAR
      const candidates = [
        p.replace('app.asar', 'app.asar.unpacked'),
        p,
        p + '.exe'
      ]
      for (const c of candidates) if (fs.existsSync(c)) return c
    }
  } catch {}
  return 'ffmpeg'
}
const ffmpegExe = resolveFfmpeg()

function resolveFfprobe(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffprobeStatic = require('ffprobe-static')
    const p = ffprobeStatic?.path as string
    if (p) {
      const candidates = [
        p.replace('app.asar', 'app.asar.unpacked'),
        p,
        p + '.exe'
      ]
      for (const c of candidates) if (fs.existsSync(c)) return c
    }
  } catch {}
  return 'ffprobe'
}
const ffprobeExe = resolveFfprobe()

// sharp is libvips in-process in the main process, so when it faults it takes
// the whole app with it - which is exactly what the confirmed crash was
// (electron.exe, faulting module sharp-win32-x64.node, 0xc0000409 / BEX64).
// Two defaults make that far more likely under a bulk thumbnail pass:
//   - concurrency defaults to one thread per CPU core, so a single call can
//     fan out to 16 native threads here, multiplied by our own queue width;
//   - cache() keeps decoded operation results in native memory, invisible to
//     V8 and to any JS-side accounting.
// Both are pinned down. Thumbnailing is throughput-insensitive background work.
try {
  sharp.concurrency(1)
  sharp.cache(false)
} catch (err) {
  console.error('[sharp] could not apply concurrency/cache limits', err)
}

function parseISO6709(locStr: string): { lat: number; lng: number } | null {
  const regex = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)(?:[+-]\d+(?:\.\d+)?)?\/$/
  const match = locStr.match(regex)
  if (match) {
    const lat = parseFloat(match[1])
    const lng = parseFloat(match[2])
    if (!isNaN(lat) && !isNaN(lng)) {
      return { lat, lng }
    }
  }
  return null
}

async function getMovMetadata(filePath: string): Promise<{ date: Date | null; lat: number | null; lng: number | null; rotation: number } | null> {
  return new Promise((resolve) => {
    const ffprobeProc = cp.spawn(ffprobeExe, [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath
    ])

    let stdout = ''
    let err = false

    ffprobeProc.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    ffprobeProc.on('error', () => {
      err = true
    })

    ffprobeProc.on('close', (code) => {
      if (err || code !== 0 || stdout.trim().length === 0) {
        resolve(null)
        return
      }

      try {
        const data = JSON.parse(stdout)
        const streams = data.streams || []
        const format = data.format || {}

        const videoStream = streams.find((s: { codec_type?: string }) => s.codec_type === 'video')
        
        let date: Date | null = null
        let dateStr = ''
        if (format.tags && format.tags.creation_time) {
          dateStr = format.tags.creation_time
        } else if (videoStream && videoStream.tags && videoStream.tags.creation_time) {
          dateStr = videoStream.tags.creation_time
        }
        if (dateStr) {
          const parsed = new Date(dateStr)
          if (!isNaN(parsed.getTime())) {
            date = parsed
          }
        }

        let lat: number | null = null
        let lng: number | null = null
        let locationStr = ''
        if (format.tags) {
          locationStr = format.tags['com.apple.quicktime.location.ISO6709'] ||
                        format.tags['location'] ||
                        format.tags['location-eng'] ||
                        ''
        }
        if (locationStr) {
          const parsedLoc = parseISO6709(locationStr)
          if (parsedLoc) {
            lat = parsedLoc.lat
            lng = parsedLoc.lng
          }
        } else if (format.tags) {
          if (format.tags.GPSLatitude && format.tags.GPSLongitude) {
            lat = parseFloat(format.tags.GPSLatitude)
            lng = parseFloat(format.tags.GPSLongitude)
          }
        }

        let rotation = 0
        if (videoStream) {
          if (videoStream.tags && videoStream.tags.rotate) {
            rotation = parseInt(videoStream.tags.rotate, 10)
          } else if (videoStream.side_data_list) {
            const displayMatrix = videoStream.side_data_list.find((sd: any) => sd.side_data_type === 'Display Matrix')
            if (displayMatrix && typeof displayMatrix.rotation === 'number') {
              rotation = (360 - displayMatrix.rotation) % 360
            }
          }
        }

        resolve({ date, lat, lng, rotation })
      } catch {
        resolve(null)
      }
    })
  })
}


const dbPath = join(app.getPath('userData'), 'diskframe.db')
const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')

const thumbDir = join(app.getPath('userData'), 'thumbs')
if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true })

// Hidden vault folder
const vaultDir = join(app.getPath('userData'), 'vault')
if (!fs.existsSync(vaultDir)) fs.mkdirSync(vaultDir, { recursive: true })

db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE,
    name TEXT,
    ext TEXT,
    size INTEGER,
    date TEXT,
    year TEXT,
    month TEXT,
    lat REAL,
    lng REAL,
    drive TEXT,
    favourited INTEGER DEFAULT 0,
    thumb TEXT,
    locked INTEGER DEFAULT 0,
    hidden INTEGER DEFAULT 0,
    vault_path TEXT,
    trashed_at TEXT,
    mtime INTEGER,
    hash TEXT,
    ino INTEGER
  );

  CREATE TABLE IF NOT EXISTS vault_pin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pin TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS delete_prefs (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    skip_confirm INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS volume_drives (
    volume_id TEXT PRIMARY KEY,
    drive_letter TEXT,
    label TEXT,
    last_seen TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_files_drive_hidden_trashed_date ON files (drive, hidden, trashed_at, date DESC);
  CREATE INDEX IF NOT EXISTS idx_files_trashed ON files (trashed_at) WHERE trashed_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_files_favourited ON files (favourited) WHERE favourited = 1;
  -- Covers the exact ORDER BY pagination uses (date, then the unique path
  -- tie-break). Without the path column SQLite has to re-sort each page, which
  -- is what makes deep OFFSET queries degrade on a large library.
  CREATE INDEX IF NOT EXISTS idx_files_page ON files (drive, hidden, trashed_at, date DESC, path ASC);
`)

// Migrate existing DB — add columns if missing
const cols = (db.prepare('PRAGMA table_info(files)').all() as { name: string }[]).map((c) => c.name)
if (!cols.includes('locked'))
  db.prepare('ALTER TABLE files ADD COLUMN locked INTEGER DEFAULT 0').run()
if (!cols.includes('hidden'))
  db.prepare('ALTER TABLE files ADD COLUMN hidden INTEGER DEFAULT 0').run()
if (!cols.includes('vault_path')) db.prepare('ALTER TABLE files ADD COLUMN vault_path TEXT').run()
if (!cols.includes('trashed_at')) db.prepare('ALTER TABLE files ADD COLUMN trashed_at TEXT').run()
if (!cols.includes('mtime')) db.prepare('ALTER TABLE files ADD COLUMN mtime INTEGER').run()
if (!cols.includes('hash')) db.prepare('ALTER TABLE files ADD COLUMN hash TEXT').run()
if (!cols.includes('ino')) db.prepare('ALTER TABLE files ADD COLUMN ino INTEGER').run()
// Marks rows the capture-date backfill has already looked at, so the pass is
// resumable across launches instead of re-parsing the whole library each time.
if (!cols.includes('exif_checked'))
  db.prepare('ALTER TABLE files ADD COLUMN exif_checked INTEGER DEFAULT 0').run()

// Left behind by an older schema that had an `is_vaulted` column. SQLite keeps
// the index definition around, and every write to `files` has to consider it.
try {
  db.prepare('DROP INDEX IF EXISTS idx_files_vaulted').run()
} catch {
  /* index referenced a dropped column - nothing to clean up */
}


const deletePrefsCols = (db.prepare('PRAGMA table_info(delete_prefs)').all() as { name: string }[]).map((c) => c.name)
if (!deletePrefsCols.includes('tile_size')) {
  try {
    db.prepare('ALTER TABLE delete_prefs ADD COLUMN tile_size INTEGER DEFAULT 120').run()
  } catch (e) {
    console.error('Error migrating delete_prefs:', e)
  }
}
if (!deletePrefsCols.includes('view_order')) {
  try {
    db.prepare("ALTER TABLE delete_prefs ADD COLUMN view_order TEXT DEFAULT 'default'").run()
  } catch (e) {
    console.error('Error migrating delete_prefs (view_order):', e)
  }
}
if (!deletePrefsCols.includes('hover_previews')) {
  try {
    db.prepare('ALTER TABLE delete_prefs ADD COLUMN hover_previews INTEGER DEFAULT 1').run()
  } catch (e) {
    console.error('Error migrating delete_prefs (hover_previews):', e)
  }
}

export interface ScannedFile {
  path: string
  name: string
  ext: string
  size: number
  date: string
  year: string
  month: string
  lat: number | null
  lng: number | null
  drive: string
  favourited: number
  thumb: string | null
  locked: number
  hidden: number
  vault_path: string | null
  trashed_at: string | null
  mtime?: number
  hash?: string
  ino?: number | null
}

// ─── PIN MANAGEMENT ───────────────────────────────────────────────────────────
export function getPin(): string | null {
  const row = db.prepare('SELECT pin FROM vault_pin WHERE id = 1').get() as
    | { pin: string }
    | undefined
  return row?.pin ?? null
}

export function setPin(pin: string): void {
  db.prepare('INSERT OR REPLACE INTO vault_pin (id, pin) VALUES (1, ?)').run(pin)
}

export function verifyPin(pin: string): boolean {
  return getPin() === pin
}

// ─── DELETE PREFS ─────────────────────────────────────────────────────────────
export function getSkipConfirm(): boolean {
  const row = db.prepare('SELECT skip_confirm FROM delete_prefs WHERE id = 1').get() as
    | { skip_confirm: number }
    | undefined
  return (row?.skip_confirm ?? 0) === 1
}

export function setSkipConfirm(skip: boolean): void {
  db.prepare('INSERT OR REPLACE INTO delete_prefs (id, skip_confirm) VALUES (1, ?)').run(
    skip ? 1 : 0
  )
}

export function getTileSizePref(): number {
  try {
    const row = db.prepare('SELECT tile_size FROM delete_prefs WHERE id = 1').get() as
      | { tile_size: number }
      | undefined
    return row?.tile_size ?? 120
  } catch (e) {
    return 120
  }
}

export function setTileSizePref(size: number): void {
  try {
    const exists = db.prepare('SELECT id FROM delete_prefs WHERE id = 1').get()
    if (exists) {
      db.prepare('UPDATE delete_prefs SET tile_size = ? WHERE id = 1').run(size)
    } else {
      db.prepare('INSERT OR REPLACE INTO delete_prefs (id, tile_size) VALUES (1, ?)').run(size)
    }
  } catch (e) {
    console.error('Error saving tile size pref:', e)
  }
}

export function getViewOrderPref(): 'default' | 'reverse' {
  try {
    const row = db.prepare('SELECT view_order FROM delete_prefs WHERE id = 1').get() as
      | { view_order: string }
      | undefined
    return row?.view_order === 'reverse' ? 'reverse' : 'default'
  } catch {
    return 'default'
  }
}

export function setViewOrderPref(order: 'default' | 'reverse'): void {
  try {
    const exists = db.prepare('SELECT id FROM delete_prefs WHERE id = 1').get()
    if (exists) {
      db.prepare('UPDATE delete_prefs SET view_order = ? WHERE id = 1').run(order)
    } else {
      db.prepare('INSERT OR REPLACE INTO delete_prefs (id, view_order) VALUES (1, ?)').run(order)
    }
  } catch (e) {
    console.error('Error saving view order pref:', e)
  }
}

export function getHoverPreviewsPref(): boolean {
  try {
    const row = db.prepare('SELECT hover_previews FROM delete_prefs WHERE id = 1').get() as
      | { hover_previews: number }
      | undefined
    return (row?.hover_previews ?? 1) === 1
  } catch {
    return true
  }
}

export function setHoverPreviewsPref(enabled: boolean): void {
  try {
    const exists = db.prepare('SELECT id FROM delete_prefs WHERE id = 1').get()
    if (exists) {
      db.prepare('UPDATE delete_prefs SET hover_previews = ? WHERE id = 1').run(enabled ? 1 : 0)
    } else {
      db.prepare('INSERT OR REPLACE INTO delete_prefs (id, hover_previews) VALUES (1, ?)').run(enabled ? 1 : 0)
    }
  } catch (e) {
    console.error('Error saving hover previews pref:', e)
  }
}

// ─── HIDE/LOCK FILES ──────────────────────────────────────────────────────────
export function hideFile(filePath: string): { vaultPath: string } | null {
  const file = db.prepare('SELECT * FROM files WHERE path = ?').get(filePath) as
    | ScannedFile
    | undefined
  if (!file) return null

  // Move file to vault
  const hash = createHash('md5').update(filePath).digest('hex')
  const vaultPath = join(vaultDir, hash + file.ext)
  try {
    fs.renameSync(filePath, vaultPath)
    db.prepare('UPDATE files SET hidden = 1, vault_path = ? WHERE path = ?').run(
      vaultPath,
      filePath
    )
    return { vaultPath }
  } catch (e) {
    console.error('[hide] failed', e)
    return null
  }
}

export function unhideFile(filePath: string, pin: string): boolean {
  if (!verifyPin(pin)) return false
  const file = db.prepare('SELECT * FROM files WHERE path = ?').get(filePath) as
    | ScannedFile
    | undefined
  if (!file?.vault_path) return false
  try {
    fs.renameSync(file.vault_path, filePath)
    db.prepare('UPDATE files SET hidden = 0, vault_path = NULL WHERE path = ?').run(filePath)
    return true
  } catch {
    return false
  }
}

// ─── TRASH / RECYCLE BIN LIFECYCLE ───────────────────────────────────────────
export function getTrashedFiles(): ScannedFile[] {
  return db
    .prepare('SELECT * FROM files WHERE trashed_at IS NOT NULL ORDER BY trashed_at DESC')
    .all() as ScannedFile[]
}

export function getTrashCount(): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM files WHERE trashed_at IS NOT NULL').get() as { count: number }
  return row?.count ?? 0
}

export function softDeleteFiles(filePaths: string[]): void {
  const stmt = db.prepare('UPDATE files SET trashed_at = ? WHERE path = ?')
  const now = new Date().toISOString()
  const tx = db.transaction(() => {
    for (const p of filePaths) {
      stmt.run(now, p)
    }
  })
  tx()
}

export function restoreFiles(filePaths: string[]): void {
  const stmt = db.prepare('UPDATE files SET trashed_at = NULL WHERE path = ?')
  const tx = db.transaction(() => {
    for (const p of filePaths) {
      stmt.run(p)
    }
  })
  tx()
}

async function safeDelete(filePath: string): Promise<void> {
  try {
    if (fs.existsSync(filePath)) {
      const trash = (await import('trash')).default
      await trash(filePath)
    }
  } catch (err) {
    console.error(`[safeDelete] Failed to send to Recycle Bin: ${filePath}`, err)
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
    } catch {}
  }
}

export async function deleteFilesPermanently(filePaths: string[]): Promise<{ success: string[]; failed: string[] }> {
  const success: string[] = []
  const failed: string[] = []
  for (const p of filePaths) {
    try {
      const file = db.prepare('SELECT * FROM files WHERE path = ?').get(p) as ScannedFile | undefined
      if (file) {
        if (fs.existsSync(p)) {
          await safeDelete(p)
        }
        if (file.vault_path && fs.existsSync(file.vault_path)) {
          await safeDelete(file.vault_path)
        }
        if (file.thumb && fs.existsSync(file.thumb)) {
          fs.unlinkSync(file.thumb)
        }
      }
      db.prepare('DELETE FROM files WHERE path = ?').run(p)
      success.push(p)
    } catch (e) {
      console.error('[deletePermanent] failed for', p, e)
      failed.push(p)
    }
  }
  return { success, failed }
}

export async function emptyTrash(): Promise<{ success: boolean; count: number }> {
  const toPurge = db.prepare('SELECT * FROM files WHERE trashed_at IS NOT NULL').all() as ScannedFile[]
  let count = 0
  for (const file of toPurge) {
    try {
      if (fs.existsSync(file.path)) {
        await safeDelete(file.path)
      }
      if (file.vault_path && fs.existsSync(file.vault_path)) {
        await safeDelete(file.vault_path)
      }
      if (file.thumb && fs.existsSync(file.thumb)) {
        fs.unlinkSync(file.thumb)
      }
      db.prepare('DELETE FROM files WHERE path = ?').run(file.path)
      count++
    } catch (err) {
      console.error(`[emptyTrash] Failed to permanently delete ${file.path}:`, err)
    }
  }
  return { success: true, count }
}

export async function autoPurgeTrash(): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
  const toPurge = db.prepare('SELECT * FROM files WHERE trashed_at IS NOT NULL AND trashed_at < ?').all(cutoff) as ScannedFile[]
  
  if (toPurge.length > 0) {
    console.log(`[auto-purge] Purging ${toPurge.length} files older than 30 days...`)
    let count = 0
    for (const file of toPurge) {
      try {
        if (fs.existsSync(file.path)) {
          await safeDelete(file.path)
        }
        if (file.vault_path && fs.existsSync(file.vault_path)) {
          await safeDelete(file.vault_path)
        }
        if (file.thumb && fs.existsSync(file.thumb)) {
          fs.unlinkSync(file.thumb)
        }
        db.prepare('DELETE FROM files WHERE path = ?').run(file.path)
        count++
      } catch (err) {
        console.error(`[auto-purge] Failed to permanently delete ${file.path}:`, err)
      }
    }
    console.log(`[auto-purge] Purged ${count} files successfully.`)
  } else {
    console.log('[auto-purge] No files older than 30 days to purge.')
  }
}

// ─── GROUPED FILES (exclude hidden and trashed) ──────────────────────────────
// Only the columns the renderer actually reads. `SELECT *` also shipped id,
// locked, hidden, vault_path, mtime, hash and ino for every row - dead weight
// in a payload that is structured-cloned across the IPC boundary and then held
// in the renderer heap for the whole session (measured: ~17MB of JSON for a
// 40k-file drive before this).
const GROUPED_COLS =
  'path, name, ext, size, date, year, month, lat, lng, drive, favourited, thumb'

export function getGroupedFiles(drivePath?: string): Record<string, ScannedFile[]> {
  const files = drivePath
    ? (db
        .prepare(`SELECT ${GROUPED_COLS} FROM files WHERE drive = ? AND hidden = 0 AND trashed_at IS NULL ORDER BY date DESC`)
        .all(drivePath) as ScannedFile[])
    : (db.prepare(`SELECT ${GROUPED_COLS} FROM files WHERE hidden = 0 AND trashed_at IS NULL ORDER BY date DESC`).all() as ScannedFile[])

  const grouped: Record<string, ScannedFile[]> = {}
  for (const file of files) {
    const year = file.year || 'Unknown'
    const month = file.month || 'Unknown'
    const key = `${year}-${month}`
    if (!grouped[key]) grouped[key] = []
    grouped[key].push(file)
  }
  return grouped
}

export function getFavourites(): ScannedFile[] {
  return db
    .prepare('SELECT * FROM files WHERE favourited = 1 AND hidden = 0 AND trashed_at IS NULL ORDER BY date DESC')
    .all() as ScannedFile[]
}

/** Returns the resulting state, so callers don't need a second read. */
export function toggleFavourite(filePath: string): boolean {
  db.prepare(
    'UPDATE files SET favourited = CASE WHEN favourited = 1 THEN 0 ELSE 1 END WHERE path = ?'
  ).run(filePath)
  const row = db.prepare('SELECT favourited FROM files WHERE path = ?').get(filePath) as
    | { favourited: number }
    | undefined
  return (row?.favourited ?? 0) === 1
}

export function getFileCount(drivePath?: string): number {
  if (drivePath) {
    const row = db
      .prepare('SELECT COUNT(*) as count FROM files WHERE drive = ? AND trashed_at IS NULL')
      .get(drivePath) as { count: number }
    return row.count
  }
  const row = db.prepare('SELECT COUNT(*) as count FROM files WHERE trashed_at IS NULL').get() as { count: number }
  return row.count
}

// The drive-select screen's "indexed" status must reflect the real DB count,
// not the renderer's session cache (which is empty for any drive not opened
// yet this session - showing "not indexed" for drives that actually are).
export function getFileCountsByDrive(): Record<string, number> {
  const rows = db
    .prepare("SELECT drive, COUNT(*) as count FROM files WHERE trashed_at IS NULL AND drive IS NOT NULL AND drive != '' GROUP BY drive")
    .all() as { drive: string; count: number }[]
  const result: Record<string, number> = {}
  for (const r of rows) result[r.drive] = r.count
  return result
}

// Restricted to extensions a thumbnail can actually be produced from. The
// unrestricted version handed the backfill thousands of .db/.json/.ts/no-ext
// rows, each costing a failed sharp or ffmpeg spawn at startup.
/** A thumbnail column that does not name a real file on disk. */
const NO_THUMB_SQL = "(thumb IS NULL OR thumb = '' OR thumb = 'NO_FILE')"

export function getAllFilesWithoutThumbs(): ScannedFile[] {
  const thumbable = thumbnailExts
  const placeholders = thumbable.map(() => '?').join(',')
  return db
    .prepare(
      `SELECT * FROM files
       WHERE ${NO_THUMB_SQL} AND trashed_at IS NULL AND ext IN (${placeholders})
       ORDER BY date DESC`
    )
    .all(...thumbable) as ScannedFile[]
}

/**
 * Clears the historical 'NO_FILE' sentinel out of the thumbnail path column.
 *
 * It was written when a file could not be read, but it lives in a column that
 * is supposed to hold a path. The renderer treated it as one, and the
 * "needs a thumbnail" query treated the row as already done - so those rows
 * could never recover, even once the file was readable again. Idempotent.
 */
export function clearThumbSentinels(): number {
  const info = db.prepare("UPDATE files SET thumb = NULL WHERE thumb = 'NO_FILE'").run()
  if (info.changes > 0) {
    console.log(`[thumb] cleared ${info.changes} 'NO_FILE' sentinels back to NULL`)
  }
  return info.changes
}

function makeHash(fullPath: string): string {
  return createHash('md5').update(fullPath).digest('hex')
}

const sharpExts = ['.jpg', '.jpeg', '.png', '.webp']

// ─── THUMBNAIL GENERATION ─────────────────────────────────────────────────────
export async function generateThumbForFile(fullPath: string, ext: string): Promise<string | null> {
  const lowerExt = ext.toLowerCase()

  if (sharpExts.includes(lowerExt)) {
    try {
      const thumbPath = join(thumbDir, `${makeHash(fullPath)}.jpg`)
      if (fs.existsSync(thumbPath)) return thumbPath
      await sharp(fullPath)
        .rotate()
        .resize(300, 300, { fit: 'cover', position: 'centre' })
        .jpeg({ quality: 80 })
        .toFile(thumbPath)
      return fs.existsSync(thumbPath) ? thumbPath : null
    } catch (e) {
      return null
    }
  }

  if (lowerExt === '.heic') {
    try {
      const thumbPath = join(thumbDir, `${makeHash(fullPath)}.jpg`)
      if (fs.existsSync(thumbPath)) return thumbPath
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const convert = require('heic-convert')
      const inputBuffer = fs.readFileSync(fullPath)
      const outputBuffer = await convert({
        buffer: inputBuffer,
        format: 'JPEG',
        quality: 0.8
      })
      await sharp(outputBuffer)
        .rotate()
        .resize(300, 300, { fit: 'cover', position: 'centre' })
        .jpeg({ quality: 80 })
        .toFile(thumbPath)
      return fs.existsSync(thumbPath) ? thumbPath : null
    } catch (err) {
      return null
    }
  }

  if (videoExts.includes(lowerExt)) {
    return generateVideoThumb(fullPath)
  }

  return null
}

function extractRawFrame(fullPath: string, seekSecs: number | string, tempFramePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const args = [
      '-ss',
      seekSecs.toString(),
      '-i',
      fullPath,
      '-vframes',
      '1',
      '-f',
      'image2',
      '-q:v',
      '2',
      '-threads',
      '1',
      '-y',
      tempFramePath
    ]
    const ff = cp.spawn(ffmpegExe, args)
    // Drained but not accumulated: a stalled ffmpeg whose stderr nobody reads
    // blocks on a full pipe, and buffering it was only ever feeding a
    // per-thumbnail debug log.
    ff.stderr.resume()

    const killTimer = setTimeout(() => {
      try {
        ff.kill()
      } catch {}
    }, 15000)

    ff.on('error', () => {
      clearTimeout(killTimer)
      resolve(false)
    })

    ff.on('close', () => {
      clearTimeout(killTimer)
      const exists = fs.existsSync(tempFramePath) && fs.statSync(tempFramePath).size > 0
      resolve(exists)
    })
  })
}

async function generateVideoThumb(fullPath: string): Promise<string | null> {
  const hash = makeHash(fullPath)
  const thumbPath = join(thumbDir, `${hash}.jpg`)
  if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0) {
    return thumbPath
  }

  const osTmp = app.getPath('temp') || require('os').tmpdir()
  const tempFramePath = join(osTmp, `df_raw_${hash}_${Date.now()}.png`)

  try {
    // 1. Extract single frame near 0.2s mark, fall back to 0s if file is short/fails
    let success = await extractRawFrame(fullPath, 0.2, tempFramePath)
    if (!success) {
      success = await extractRawFrame(fullPath, 0, tempFramePath)
    }

    if (!success || !fs.existsSync(tempFramePath)) {
      console.warn(`[DIAG:FRAME_EXTRACT_FAILED] for: "${fullPath}"`)
      return null
    }

    // 2. Resize extracted frame through Sharp
    const ext = fullPath.slice(fullPath.lastIndexOf('.')).toLowerCase()
    let rotationAngle = 0
    if (ext === '.mov') {
      const meta = await getMovMetadata(fullPath)
      if (meta && meta.rotation) {
        rotationAngle = meta.rotation
      }
    }

    const image = sharp(tempFramePath)
    if (ext === '.mov' && rotationAngle) {
      image.rotate(rotationAngle)
    } else {
      image.rotate()
    }

    await image
      .resize(300, 300, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 80 })
      .toFile(thumbPath)

    const created = fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0
    return created ? thumbPath : null
  } catch (err) {
    console.error(`[DIAG:SHARP_FRAME_FAILED] for: "${fullPath}"`, err)
    return null
  } finally {
    // Clean up temporary raw frame image file
    if (fs.existsSync(tempFramePath)) {
      try {
        fs.unlinkSync(tempFramePath)
      } catch {}
    }
  }
}

export function updateThumb(filePath: string, thumbPath: string): void {
  db.prepare('UPDATE files SET thumb = ? WHERE path = ?').run(thumbPath, filePath)
}

const EXIF_EXTS = new Set([
  '.jpg',
  '.jpeg',
  '.heic',
  '.raw',
  '.cr2',
  '.nef',
  '.png',
  '.webp',
  '.mp4',
  '.mov'
])

const updateExifStmt = db.prepare(
  `UPDATE files SET date=?, year=?, month=?, lat=?, lng=? WHERE path=? AND lat IS NULL`
)

// A file with GPS but no capture date must keep whatever date it already has
// (the filesystem mtime from the scan pass). Writing new Date() here stamped it
// with "today", which is why a large share of the library collapsed into the
// current month and sorted above genuinely recent photos.
const updateGpsOnlyStmt = db.prepare(
  `UPDATE files SET lat=?, lng=? WHERE path=? AND lat IS NULL`
)

const markExifCheckedStmt = db.prepare('UPDATE files SET exif_checked = 1 WHERE path = ?')

let exifBackfillRunning = false

/**
 * Reads the real capture date (and GPS) for indexed files that have never been
 * checked, and corrects the placeholder date the scan pass wrote.
 *
 * The scan pass only records filesystem mtime, which is the *copy* time for
 * anything transferred off a phone or camera - that is what collapsed a large
 * share of the library into the current month. This replaces it with
 * DateTimeOriginal / QuickTime creation_time where the file actually has one,
 * and leaves the mtime in place where it doesn't (never "today", never 1970).
 * `exif_checked` makes the pass resumable, so a relaunch continues instead of
 * re-parsing the whole library.
 */
export async function enrichExifBackfill(shouldStop?: () => boolean): Promise<number> {
  if (exifBackfillRunning) return 0
  exifBackfillRunning = true
  try {
    const extList = [...EXIF_EXTS]
    const placeholders = extList.map(() => '?').join(',')
    const pending = db
      .prepare(
        `SELECT path, ext FROM files
         WHERE exif_checked = 0 AND trashed_at IS NULL AND ext IN (${placeholders})
         ORDER BY date DESC`
      )
      .all(...extList) as { path: string; ext: string }[]

    const total = pending.length
    if (total === 0) return 0
    console.log(`[exif:backfill:start] ${total} files need a capture-date check`)

    let checked = 0
    let corrected = 0
    // Bounded like the thumbnail backfill: exifr and ffprobe both compete with
    // the renderer for CPU, and browsing has to stay responsive while this runs.
    const CONCURRENCY = 2
    let cursor = 0

    async function worker(): Promise<void> {
      while (cursor < pending.length) {
        if (shouldStop?.()) return
        const { path: fullPath, ext } = pending[cursor++]
        const lowerExt = ext.toLowerCase()
        try {
          let date: Date | null = null
          let lat: number | null = null
          let lng: number | null = null

          if (lowerExt === '.mov' || lowerExt === '.mp4') {
            const meta = await getMovMetadata(fullPath)
            if (meta) {
              date = meta.date
              lat = meta.lat
              lng = meta.lng
            }
          } else {
            const exif = await exifr.parse(fullPath, {
              pick: ['DateTimeOriginal', 'GPSLatitude', 'GPSLongitude'],
              gps: true
            })
            if (exif) {
              if (exif.DateTimeOriginal) date = new Date(exif.DateTimeOriginal)
              lat = typeof exif.latitude === 'number' ? exif.latitude : null
              lng = typeof exif.longitude === 'number' ? exif.longitude : null
            }
          }

          if (isUsableCaptureDate(date)) {
            const d = date as Date
            updateExifStmt.run(
              d.toISOString(),
              d.getFullYear().toString(),
              d.toLocaleString('default', { month: 'long' }),
              lat,
              lng,
              fullPath
            )
            corrected++
          } else if (lat !== null) {
            updateGpsOnlyStmt.run(lat, lng, fullPath)
          }
        } catch {
          /* unreadable, or simply has no metadata - the mtime date stands */
        }
        // Marked either way, so a file that genuinely has no EXIF is not
        // re-parsed on every launch for the rest of the library's life.
        markExifCheckedStmt.run(fullPath)

        checked++
        if (checked % 500 === 0) {
          console.log(`[exif:backfill] ${checked}/${total} checked, ${corrected} dates corrected`)
        }
        await new Promise((r) => setImmediate(r))
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
    console.log(`[exif:backfill:complete] ${checked} checked, ${corrected} capture dates corrected`)
    return corrected
  } finally {
    exifBackfillRunning = false
  }
}


export function resolveMediaFile(filePath: string): { path: string; relinked: boolean; exists: boolean } {
  if (!filePath) return { path: filePath, relinked: false, exists: false }

  // 1. Direct stat check
  if (fs.existsSync(filePath)) {
    return { path: filePath, relinked: false, exists: true }
  }

  console.warn(`[PathResilience] File not found at target path: "${filePath}". Searching index for moved/renamed file...`)

  const targetName = basename(filePath)

  // 2. Search database for files matching exact filename or path
  const candidates = db
    .prepare('SELECT * FROM files WHERE name = ? OR path = ?')
    .all(targetName, filePath) as ScannedFile[]

  // Check if any candidate's path exists on disk right now
  for (const candidate of candidates) {
    if (fs.existsSync(candidate.path)) {
      console.log(`[PathResilience] Found moved file at indexed path: "${candidate.path}"`)
      db.prepare('UPDATE files SET path = ?, name = ? WHERE path = ?').run(candidate.path, basename(candidate.path), filePath)
      return { path: candidate.path, relinked: true, exists: true }
    }
  }

  // 3. Search sibling directories of the old parent folder (e.g. if parent folder was renamed or moved)
  const dirPath = dirname(filePath)
  const parentDirPath = dirname(dirPath)

  if (fs.existsSync(parentDirPath)) {
    try {
      const subdirs = fs.readdirSync(parentDirPath, { withFileTypes: true })
      for (const sub of subdirs) {
        if (sub.isDirectory()) {
          const candidatePath = join(parentDirPath, sub.name, targetName)
          if (fs.existsSync(candidatePath)) {
            console.log(`[PathResilience] Located moved file in renamed parent folder: "${candidatePath}"`)
            db.prepare('UPDATE files SET path = ?, name = ? WHERE path = ?').run(candidatePath, targetName, filePath)
            return { path: candidatePath, relinked: true, exists: true }
          }
        }
      }
    } catch {}
  }

  return { path: filePath, relinked: false, exists: false }
}

export function removeFileRecord(filePath: string): void {
  const row = db.prepare('SELECT thumb FROM files WHERE path = ?').get(filePath) as { thumb: string | null } | undefined
  if (row?.thumb && fs.existsSync(row.thumb)) {
    try {
      fs.unlinkSync(row.thumb)
    } catch {}
  }
  db.prepare('DELETE FROM files WHERE path = ?').run(filePath)
}

export async function updateFileInPlace(filePath: string, statInput?: fs.Stats): Promise<ScannedFile | null> {
  // The scan pass filters by extension, but this function is also the watcher's
  // entry point and used to index whatever changed - so ordinary desktop
  // activity filed .ts, .json, .db, settings.dat and extensionless files like
  // "Local State" into a media index, then queued each one for thumbnail
  // generation. Guarding here covers every caller at once.
  // Also excludes the app's own thumbnails, cache and temp frames. Indexing
  // those made every photo and video appear twice: once as itself, and once as
  // a tile of its own generated thumbnail.
  if (!isIndexableUserMedia(filePath)) return null

  let stat = statInput
  if (!stat) {
    try {
      if (!fs.existsSync(filePath)) {
        removeFileRecord(filePath)
        return null
      }
      stat = fs.statSync(filePath)
    } catch {
      return null
    }
  }

  const existing = db.prepare('SELECT * FROM files WHERE path = ?').get(filePath) as ScannedFile | undefined

  const mtimeMs = Math.round(stat.mtimeMs)
  const date = new Date(stat.mtime)
  const year = date.getFullYear().toString()
  const month = date.toLocaleString('default', { month: 'long' })
  const ext = extname(filePath).toLowerCase()
  const drive = filePath.slice(0, 2).toUpperCase()

  // Invalidate old thumb if exists
  if (existing?.thumb && fs.existsSync(existing.thumb)) {
    try {
      fs.unlinkSync(existing.thumb)
    } catch {}
  }

  let newThumb: string | null = null
  try {
    newThumb = await generateThumbForFile(filePath, ext)
  } catch (e) {
    console.error(`[updateFileInPlace] Thumb generation failed for ${filePath}:`, e)
  }

  if (existing) {
    db.prepare(`
      UPDATE files
      SET size = ?, date = ?, year = ?, month = ?, thumb = ?, mtime = ?, ino = ?
      WHERE path = ?
    `).run(stat.size, date.toISOString(), year, month, newThumb, mtimeMs, stat.ino ? Number(stat.ino) : null, filePath)
  } else {
    db.prepare(`
      INSERT OR REPLACE INTO files (path, name, ext, size, date, year, month, lat, lng, drive, thumb, locked, hidden, mtime, ino)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
    `).run(filePath, basename(filePath), ext, stat.size, date.toISOString(), year, month, null, null, drive, newThumb, mtimeMs, stat.ino ? Number(stat.ino) : null)
  }

  const updated = db.prepare('SELECT * FROM files WHERE path = ?').get(filePath) as ScannedFile | undefined
  return updated || null
}

/**
 * Records a file that was just copied into `destDrive`, carrying the source
 * row's capture date and GPS across when we already know them.
 *
 * A copy resets the filesystem mtime to "now", so an unknown source would
 * otherwise land the new file in today's group. `exif_checked = 0` leaves it
 * queued for the capture-date backfill, which reads the real date out of the
 * file itself.
 */
export function recordCopiedFile(srcPath: string, destPath: string, destDrive: string): void {
  const row = db.prepare('SELECT * FROM files WHERE path = ?').get(srcPath) as ScannedFile | undefined
  const stat = fs.statSync(destPath)
  const fallback = new Date(stat.mtime)
  const date = row?.date ?? fallback.toISOString()
  const year = row?.year ?? fallback.getFullYear().toString()
  const month = row?.month ?? fallback.toLocaleString('default', { month: 'long' })

  db.prepare(
    `INSERT OR REPLACE INTO files
       (path, name, ext, size, date, year, month, lat, lng, drive, thumb, favourited, locked, hidden, vault_path, trashed_at, mtime, exif_checked)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, NULL, ?, ?)`
  ).run(
    destPath,
    basename(destPath),
    extname(destPath).toLowerCase(),
    stat.size,
    date,
    year,
    month,
    row?.lat ?? null,
    row?.lng ?? null,
    destDrive,
    row?.thumb ?? null,
    Math.round(stat.mtimeMs),
    row ? 1 : 0
  )
}

/** Moves an existing row to its new path, or indexes the file if it was untracked. */
export function recordMovedFile(srcPath: string, destPath: string, destDrive: string): void {
  const exists = db.prepare('SELECT 1 FROM files WHERE path = ?').get(srcPath)
  if (exists) {
    db.prepare('UPDATE files SET path = ?, name = ?, drive = ? WHERE path = ?').run(
      destPath,
      basename(destPath),
      destDrive,
      srcPath
    )
    return
  }
  recordCopiedFile(srcPath, destPath, destDrive)
}

/**
 * Removes index rows for assets DiskFrame generated itself.
 *
 * Deliberately deletes ROWS ONLY. removeFileRecord() unlinks the thumbnail file
 * it finds in the row, and here the row's own path IS a thumbnail that some
 * other row still depends on - using it would delete the thumbnails of the very
 * media we are trying to fix. Nothing on disk is touched.
 *
 * Idempotent, so it can run on every launch as a migration.
 */
export function purgeGeneratedAssetRows(): { removed: number; scanned: number } {
  const candidates = db
    .prepare('SELECT id, path FROM files')
    .all() as { id: number; path: string }[]
  // Two classes of wrongly-indexed row: the app's own generated output, and
  // anything that was never media to begin with (.log/.db/.tmp and
  // extensionless files the old unfiltered watcher swept in).
  const doomed = candidates.filter((r) => !isIndexableUserMedia(r.path))
  if (doomed.length === 0) return { removed: 0, scanned: candidates.length }

  const del = db.prepare('DELETE FROM files WHERE id = ?')
  const tx = db.transaction((rows: { id: number }[]) => {
    for (const r of rows) del.run(r.id)
  })
  tx(doomed)
  console.log(
    `[purge] removed ${doomed.length} wrongly-indexed rows (generated assets + non-media); files on disk untouched`
  )
  return { removed: doomed.length, scanned: candidates.length }
}

// ─── PAGINATED LIBRARY READS ─────────────────────────────────────────────────
/** Hard ceiling on a single page, so a bad or hostile request cannot ask for
 *  the whole library in one call and undo the point of paginating. */
export const MAX_PAGE_SIZE = 500

export function getLibrarySummary(q: LibraryQuery): {
  total: number
  groups: { key: string; count: number; minDate: string; maxDate: string; offset: number }[]
} {
  const s = summarySql(q)
  const rows = db.prepare(s.sql).all(...(s.params as never[])) as {
    gkey: string
    n: number
    min_date: string
    max_date: string
  }[]
  const offsets = groupOffsets(rows)
  let total = 0
  for (const r of rows) total += r.n
  return {
    total,
    groups: rows.map((r) => ({
      key: r.gkey,
      count: r.n,
      minDate: r.min_date,
      maxDate: r.max_date,
      offset: offsets.get(r.gkey) ?? 0
    }))
  }
}

export function getLibraryPage(q: LibraryQuery, offset: number, limit: number): ScannedFile[] {
  const bounded = Math.max(1, Math.min(Math.floor(limit) || 1, MAX_PAGE_SIZE))
  const from = Math.max(0, Math.floor(offset) || 0)
  const p = pageSql(q)
  return db.prepare(p.sql).all(...(p.params as never[]), bounded, from) as ScannedFile[]
}

export function getLibraryCount(q: LibraryQuery): number {
  const c = countSql(q)
  const row = db.prepare(c.sql).get(...(c.params as never[])) as { n: number }
  return row?.n ?? 0
}

/** Drive key used for the diagnostic sample folder, kept apart from real drives. */
export const SAMPLE_DRIVE_KEY = 'SAMPLE:'

/**
 * Indexes one explicitly chosen folder, with a hard ceiling on how many files
 * are admitted. Nothing here touches a real drive, spawns a utility process or
 * starts a watcher - it is the smallest dataset that still exercises the grid,
 * the thumbnail path and the viewer.
 *
 * Rows live under their own drive key so the sample can be re-indexed or
 * cleared without disturbing the user's real index.
 */
export function indexSampleFolder(folder: string, maxFiles: number): { count: number; skipped: number } {
  db.prepare('DELETE FROM files WHERE drive = ?').run(SAMPLE_DRIVE_KEY)

  const insert = db.prepare(
    `INSERT OR IGNORE INTO files
       (path, name, ext, size, date, year, month, lat, lng, drive, thumb, locked, hidden, mtime, exif_checked)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, 0, 0, ?, 1)`
  )

  const rows: Parameters<typeof insert.run>[] = []
  let skipped = 0
  // Iterative walk with an explicit stack and a depth cap: a deep or
  // symlink-looped tree must not become unbounded recursion here.
  const stack: { dir: string; depth: number }[] = [{ dir: folder, depth: 0 }]
  while (stack.length > 0 && rows.length < maxFiles) {
    const { dir, depth } = stack.pop()!
    if (depth > 6) continue
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (rows.length >= maxFiles) break
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) stack.push({ dir: join(dir, entry.name), depth: depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      const fullPath = join(dir, entry.name)
      if (!isIndexableUserMedia(fullPath)) {
        skipped++
        continue
      }
      try {
        const stat = fs.statSync(fullPath)
        const date = new Date(stat.mtime)
        rows.push([
          fullPath,
          entry.name,
          extname(fullPath).toLowerCase(),
          stat.size,
          date.toISOString(),
          date.getFullYear().toString(),
          date.toLocaleString('default', { month: 'long' }),
          SAMPLE_DRIVE_KEY,
          Math.round(stat.mtimeMs)
        ])
      } catch {
        skipped++
      }
    }
  }

  const tx = db.transaction(() => {
    for (const r of rows) insert.run(...r)
  })
  tx()
  return { count: rows.length, skipped }
}

export function getFileIno(filePath: string): number | null {
  const row = db.prepare('SELECT ino FROM files WHERE path = ?').get(filePath) as { ino: number | null } | undefined
  return row?.ino ?? null
}

export function relinkMovedFile(oldPath: string, newPath: string, stat: fs.Stats): ScannedFile | null {
  const existing = db.prepare('SELECT * FROM files WHERE path = ?').get(oldPath) as ScannedFile | undefined
  if (!existing) return null

  const mtimeMs = Math.round(stat.mtimeMs)
  const ext = extname(newPath).toLowerCase()
  const drive = newPath.slice(0, 2).toUpperCase()

  db.prepare(`
    UPDATE files
    SET path = ?, name = ?, ext = ?, drive = ?, size = ?, mtime = ?, ino = ?
    WHERE path = ?
  `).run(newPath, basename(newPath), ext, drive, stat.size, mtimeMs, stat.ino ? Number(stat.ino) : null, oldPath)

  const updated = db.prepare('SELECT * FROM files WHERE path = ?').get(newPath) as ScannedFile | undefined
  return updated || null
}

export function getAllKnownDrives(): string[] {
  const rows = db.prepare("SELECT DISTINCT drive FROM files WHERE drive IS NOT NULL AND drive != ''").all() as {
    drive: string
  }[]
  return rows.map((r) => r.drive)
}

export function getVolumeId(drivePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const letter = drivePath.slice(0, 2).toUpperCase()
    const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Volume | Where-Object { $_.DriveLetter -eq '${letter}' } | Select-Object DeviceID, VolumeSerialNumber, Label | ConvertTo-Json"`
    cp.exec(cmd, (err, stdout) => {
      if (err || !stdout) return resolve(null)
      try {
        const parsed = JSON.parse(stdout)
        const item = Array.isArray(parsed) ? parsed[0] : parsed
        if (item) {
          const serial = item.VolumeSerialNumber ? String(item.VolumeSerialNumber).trim() : ''
          const deviceId = item.DeviceID ? String(item.DeviceID).trim() : ''
          const volId = serial || deviceId || `${letter}_VOLUME`
          return resolve(volId)
        }
        resolve(null)
      } catch {
        resolve(null)
      }
    })
  })
}

export function saveVolumeDrive(volumeId: string, driveLetter: string, label: string = ''): void {
  db.prepare(`
    INSERT OR REPLACE INTO volume_drives (volume_id, drive_letter, label, last_seen)
    VALUES (?, ?, ?, ?)
  `).run(volumeId, driveLetter.toUpperCase(), label, new Date().toISOString())
}

export function getStoredVolumeId(driveLetter: string): string | null {
  const row = db.prepare('SELECT volume_id FROM volume_drives WHERE drive_letter = ?').get(driveLetter.toUpperCase()) as { volume_id: string } | undefined
  return row?.volume_id ?? null
}

// ponytail: module-level guard, single process. Fine for one Electron app instance.
const syncsInProgress = new Set<string>()

export async function incrementalSyncDrive(
  drivePath: string,
  onProgress?: (count: number) => void
): Promise<{ fullScanNeeded: boolean; count: number }> {
  const driveKey = drivePath.slice(0, 2).toUpperCase()
  if (syncsInProgress.has(driveKey)) {
    return { fullScanNeeded: false, count: getFileCount(driveKey) }
  }
  syncsInProgress.add(driveKey)
  try {
    return await incrementalSyncDriveInner(drivePath, onProgress)
  } finally {
    syncsInProgress.delete(driveKey)
  }
}

async function incrementalSyncDriveInner(
  drivePath: string,
  onProgress?: (count: number) => void
): Promise<{ fullScanNeeded: boolean; count: number }> {
  const currentVolId = await getVolumeId(drivePath)
  const storedVolId = getStoredVolumeId(drivePath)

  if (storedVolId && currentVolId && storedVolId !== currentVolId) {
    console.log(`[incrementalSync] Volume ID mismatch for ${drivePath} (stored: ${storedVolId}, current: ${currentVolId}). Full scan required.`)
    return { fullScanNeeded: true, count: 0 }
  }

  if (currentVolId) {
    saveVolumeDrive(currentVolId, drivePath)
  }

  const driveNorm = drivePath.slice(0, 2).toUpperCase()
  const dbFiles = db
    .prepare('SELECT path, size, mtime, ino, thumb FROM files WHERE drive = ? AND trashed_at IS NULL')
    .all(driveNorm) as Pick<ScannedFile, 'path' | 'size' | 'mtime' | 'ino' | 'thumb'>[]

  // The expensive part - stat-ing every known file plus a readdir of every known
  // folder to catch new files - runs in a worker_thread so it never blocks the
  // main process (IPC, window, other drives) while checking thousands of files.
  const { changed, removed, added } = await runIncrementalSyncWorker(dbFiles, onProgress)

  // A drive that was unplugged (or whose letter was reassigned) mid-sync makes
  // every stat fail, so the worker reports the entire index as "removed".
  // Deleting those rows would destroy the user's index - and their cached
  // thumbnails - for media that is still perfectly intact on the volume.
  // Removals are only applied when the volume is still mounted AND the deletion
  // isn't implausibly large for an incremental pass.
  const driveMounted = fs.existsSync(`${driveNorm}\\`)
  if (!driveMounted || isMassRemoval(removed.length, dbFiles.length)) {
    console.warn(
      `[incrementalSync] Skipping ${removed.length} removals for ${driveNorm} ` +
        `(mounted=${driveMounted}, known=${dbFiles.length}). Treating as a disconnected or swapped volume, not a deletion.`
    )
  } else {
    for (const path of removed) {
      removeFileRecord(path)
    }
  }

  // Concurrent, yielding queue (mirrors backfillAllMissingThumbnails' pattern)
  // instead of one-at-a-time awaits - a large changed/added set (routine on a
  // dev drive with heavy file churn) would otherwise serialize thousands of
  // thumbnail regenerations on the main thread with no yielding in between.
  const toUpdate = [...changed, ...added]
  // Measured: 4 concurrent sharp/ffmpeg spawns is enough to starve the
  // renderer of CPU during active browsing - 2 leaves more headroom.
  const CONCURRENCY = 2
  let cursor = 0
  async function updateWorker(): Promise<void> {
    while (cursor < toUpdate.length) {
      const path = toUpdate[cursor++]
      try {
        await updateFileInPlace(path)
      } catch {
        /* skip errors */
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => updateWorker()))

  const totalCount = getFileCount(driveNorm)
  if (onProgress) onProgress(totalCount)
  return { fullScanNeeded: false, count: totalCount }
}

function runIncrementalSyncWorker(
  files: Pick<ScannedFile, 'path' | 'size' | 'mtime' | 'ino' | 'thumb'>[],
  onProgress?: (count: number) => void
): Promise<{ changed: string[]; removed: string[]; added: string[] }> {
  return new Promise((resolve, reject) => {
    const workerScript = join(__dirname, 'incrementalSyncWorker.js')
    const worker = new Worker(workerScript, {
      workerData: { files, allExts }
    })

    worker.on('message', (msg) => {
      if (msg.type === 'progress') {
        if (onProgress) onProgress(msg.count)
      } else if (msg.type === 'complete') {
        // Without this the worker thread (and its copy of the file list) stays
        // resident for the life of the app; one per sync, per drive, forever.
        worker.terminate()
        resolve({ changed: msg.changed, removed: msg.removed, added: msg.added })
      }
    })
    worker.on('error', (err) => {
      console.error('[incrementalSyncWorker error]:', err)
      worker.terminate()
      reject(err)
    })
    worker.on('exit', (code) => {
      if (code !== 0) console.warn(`[incrementalSyncWorker] Worker stopped with exit code ${code}`)
    })
  })
}


export function spawnScanUtilityProcess(
  drivePath: string,
  scanPath: string,
  onProgress: (count: number) => void,
  onElevationStatus?: (status: { isElevated: boolean; message: string }) => void
): Promise<number> {
  return new Promise((resolve, reject) => {
    const utilityScript = join(__dirname, 'scanUtility.js')
    console.log(`[spawnScanUtilityProcess] Spawning Electron utilityProcess for ${drivePath} (script: ${utilityScript})`)

    const child = utilityProcess.fork(utilityScript, [drivePath, scanPath, dbPath])
    let finalCount = 0
    let settled = false

    // The child was previously left running after it reported 'complete', and
    // was never killed on error either - so a scan that failed or was
    // superseded stayed resident holding its own SQLite connection. Each
    // subsequent scan added another.
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      fn()
    }

    child.on('message', (msg: any) => {
      if (msg.type === 'elevation-status' && onElevationStatus) {
        onElevationStatus({ isElevated: msg.isElevated, message: msg.message })
      } else if (msg.type === 'progress') {
        onProgress(msg.count)
      } else if (msg.type === 'complete') {
        finalCount = msg.count
        onProgress(finalCount)
        finish(() => resolve(finalCount))
      } else if (msg.type === 'error') {
        console.error('[scanUtility error]:', msg.error)
        finish(() => reject(new Error(msg.error)))
      }
    })

    child.on('exit', (code) => {
      if (code !== 0) console.warn(`[scanUtility] Process exited with code ${code}`)
      // An exit without 'complete' must not leave the caller awaiting forever.
      finish(() => resolve(finalCount))
    })
  })
}
