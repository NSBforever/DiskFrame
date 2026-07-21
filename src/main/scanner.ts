import { join } from 'path'
import * as fs from 'fs'
import * as cp from 'child_process'
import exifr from 'exifr'
import Database from 'better-sqlite3'
import { app } from 'electron'
import sharp from 'sharp'
import { createHash } from 'crypto'

function resolveFfmpeg(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const p = require('ffmpeg-static') as string
    if (p) {
      const candidates = [p, p.replace('app.asar', 'app.asar.unpacked'), p + '.exe']
      for (const c of candidates) if (fs.existsSync(c)) return c
    }
  } catch {}
  return 'ffmpeg'
}
const ffmpegExe = resolveFfmpeg()

const dbPath = join(app.getPath('userData'), 'diskframe.db')
const db = new Database(dbPath)

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
    trashed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS vault_pin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pin TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS delete_prefs (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    skip_confirm INTEGER DEFAULT 0
  );
`)

// Migrate existing DB — add columns if missing
const cols = (db.prepare('PRAGMA table_info(files)').all() as { name: string }[]).map((c) => c.name)
if (!cols.includes('locked'))
  db.prepare('ALTER TABLE files ADD COLUMN locked INTEGER DEFAULT 0').run()
if (!cols.includes('hidden'))
  db.prepare('ALTER TABLE files ADD COLUMN hidden INTEGER DEFAULT 0').run()
if (!cols.includes('vault_path')) db.prepare('ALTER TABLE files ADD COLUMN vault_path TEXT').run()
if (!cols.includes('trashed_at')) db.prepare('ALTER TABLE files ADD COLUMN trashed_at TEXT').run()

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

export function deleteFileToRecycleBin(filePath: string): boolean {
  try {
    // Use PowerShell to send to recycle bin on Windows
    const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${filePath.replace(/'/g, "''")}', 'OnlyErrorDialogs', 'SendToRecycleBin')`
    cp.execSync(`powershell -Command "${script}"`, { timeout: 10000 })
    db.prepare('DELETE FROM files WHERE path = ?').run(filePath)
    return true
  } catch (e) {
    console.error('[delete] recycle bin failed', e)
    return false
  }
}

export function deleteMultipleToRecycleBin(filePaths: string[]): {
  success: string[]
  failed: string[]
} {
  const success: string[] = []
  const failed: string[] = []
  for (const p of filePaths) {
    if (deleteFileToRecycleBin(p)) success.push(p)
    else failed.push(p)
  }
  return { success, failed }
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

export function deleteFilesPermanently(filePaths: string[]): { success: string[]; failed: string[] } {
  const success: string[] = []
  const failed: string[] = []
  for (const p of filePaths) {
    try {
      const file = db.prepare('SELECT * FROM files WHERE path = ?').get(p) as ScannedFile | undefined
      if (file) {
        if (fs.existsSync(p)) {
          fs.unlinkSync(p)
        }
        if (file.vault_path && fs.existsSync(file.vault_path)) {
          fs.unlinkSync(file.vault_path)
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

export function emptyTrash(): { success: boolean; count: number } {
  const toPurge = db.prepare('SELECT * FROM files WHERE trashed_at IS NOT NULL').all() as ScannedFile[]
  let count = 0
  for (const file of toPurge) {
    try {
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path)
      }
      if (file.vault_path && fs.existsSync(file.vault_path)) {
        fs.unlinkSync(file.vault_path)
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

export function autoPurgeTrash(): void {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
  const toPurge = db.prepare('SELECT * FROM files WHERE trashed_at IS NOT NULL AND trashed_at < ?').all(cutoff) as ScannedFile[]
  
  if (toPurge.length > 0) {
    console.log(`[auto-purge] Purging ${toPurge.length} files older than 30 days...`)
    let count = 0
    for (const file of toPurge) {
      try {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path)
        }
        if (file.vault_path && fs.existsSync(file.vault_path)) {
          fs.unlinkSync(file.vault_path)
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
export function getGroupedFiles(drivePath?: string): Record<string, ScannedFile[]> {
  const files = drivePath
    ? (db
        .prepare('SELECT * FROM files WHERE drive = ? AND hidden = 0 AND trashed_at IS NULL ORDER BY date DESC')
        .all(drivePath) as ScannedFile[])
    : (db.prepare('SELECT * FROM files WHERE hidden = 0 AND trashed_at IS NULL ORDER BY date DESC').all() as ScannedFile[])

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

export function toggleFavourite(filePath: string): void {
  db.prepare(
    'UPDATE files SET favourited = CASE WHEN favourited = 1 THEN 0 ELSE 1 END WHERE path = ?'
  ).run(filePath)
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

export function getFilesWithoutThumbs(drivePath: string): ScannedFile[] {
  return db
    .prepare('SELECT * FROM files WHERE drive = ? AND (thumb IS NULL OR thumb = "") AND trashed_at IS NULL')
    .all(drivePath) as ScannedFile[]
}

function makeHash(fullPath: string): string {
  return createHash('md5').update(fullPath).digest('hex')
}

const photoExts = ['.jpg', '.jpeg', '.png', '.heic', '.raw', '.cr2', '.nef', '.webp']
const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.wmv']
const docExts = ['.pdf', '.docx', '.doc', '.txt', '.xlsx', '.pptx', '.csv']
const allExts = [...photoExts, ...videoExts, ...docExts]
const sharpExts = ['.jpg', '.jpeg', '.png', '.webp']
const MIN_PHOTO_SIZE = 50 * 1024

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
      console.error('[thumb:sharp failed]', fullPath, e)
      return null
    }
  }

  if (videoExts.includes(lowerExt)) {
    return generateVideoThumb(fullPath)
  }

  return null
}

function generateVideoThumb(fullPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const thumbPath = join(thumbDir, `${makeHash(fullPath)}.jpg`)
    if (fs.existsSync(thumbPath)) {
      resolve(thumbPath)
      return
    }

    // Strategy: try at 2s first, fall back to 0s if file is short
    function tryAt(seekSecs: number, fallback: boolean): void {
      const args = [
        '-i',
        fullPath,
        '-ss',
        seekSecs.toString(),
        '-vframes',
        '1',
        '-vf',
        'scale=300:300:force_original_aspect_ratio=increase,crop=300:300',
        '-f',
        'image2',
        '-q:v',
        '3',
        '-threads',
        '1',
        '-y',
        thumbPath
      ]

      const ff = cp.spawn(ffmpegExe, args)
      let stderr = ''
      ff.stderr.on('data', (d: Buffer) => {
        stderr += d.toString()
      })

      const killTimer = setTimeout(() => {
        try {
          ff.kill()
        } catch {}
      }, 20000)

      ff.on('close', (code) => {
        clearTimeout(killTimer)
        if (code === 0 && fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0) {
          resolve(thumbPath)
        } else if (!fallback && seekSecs > 0) {
          // Retry at 0s
          console.warn(`[thumb:video] retry at 0s for ${fullPath}`)
          tryAt(0, true)
        } else {
          console.warn(`[thumb:video] failed code=${code} for ${fullPath}`, stderr.slice(-200))
          resolve(null)
        }
      })

      ff.on('error', (err) => {
        clearTimeout(killTimer)
        if (!fallback && seekSecs > 0) tryAt(0, true)
        else {
          console.warn('[thumb:video] spawn error', err)
          resolve(null)
        }
      })
    }

    tryAt(2, false)
  })
}

export function updateThumb(filePath: string, thumbPath: string): void {
  db.prepare('UPDATE files SET thumb = ? WHERE path = ?').run(thumbPath, filePath)
}

// ─── SCANNER ──────────────────────────────────────────────────────────────────
const SKIP_DIRS = [
  'windows',
  'program files',
  'program files (x86)',
  '$recycle.bin',
  'system volume information',
  'programdata',
  'node_modules',
  '.git',
  'appdata'
]

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

// Insert stmt reused for perf
const insertStmt = db.prepare(
  `INSERT OR IGNORE INTO files (path, name, ext, size, date, year, month, lat, lng, drive, thumb, locked, hidden)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`
)

const updateExifStmt = db.prepare(
  `UPDATE files SET date=?, year=?, month=?, lat=?, lng=? WHERE path=? AND lat IS NULL`
)

export async function scanDrive(
  drivePath: string,
  scanPath: string,
  onProgress: (count: number) => void,
  onExifProgress?: (enriched: number, total: number) => void
): Promise<void> {
  // ── PASS 1: fast walk, insert with mtime only, no EXIF ──────────────────
  const newPaths: { path: string; ext: string }[] = []
  let count = 0

  function walkSync(dir: string): void {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    // Batch inserts in a transaction for speed
    const batch: Parameters<typeof insertStmt.run>[] = []

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const nameLower = entry.name.toLowerCase()
        if (SKIP_DIRS.some((s) => nameLower === s)) continue
        if (entry.name.startsWith('.')) continue
        walkSync(join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase()
      if (!allExts.includes(ext)) continue
      const fullPath = join(dir, entry.name)
      try {
        const stat = fs.statSync(fullPath)
        if (photoExts.includes(ext) && stat.size < MIN_PHOTO_SIZE) continue

        const exists = db.prepare('SELECT 1 FROM files WHERE path = ?').get(fullPath)
        if (!exists) {
          const date = new Date(stat.mtime)
          const year = date.getFullYear().toString()
          const month = date.toLocaleString('default', { month: 'long' })
          batch.push([
            fullPath,
            entry.name,
            ext,
            stat.size,
            date.toISOString(),
            year,
            month,
            null,
            null,
            drivePath,
            null
          ])
          if (EXIF_EXTS.has(ext)) newPaths.push({ path: fullPath, ext })
        }

        count++
        if (count % 50 === 0) onProgress(count)
      } catch {
        /* skip */
      }
    }

    // Commit batch
    if (batch.length > 0) {
      const tx = db.transaction(() => {
        for (const row of batch) insertStmt.run(...row)
      })
      tx()
    }
  }

  walkSync(scanPath)
  onProgress(count)

  // ── PASS 2: async EXIF enrichment in background ───────────────────────────
  // Don't await — caller returns immediately, EXIF fills in behind the scenes
  enrichExifBackground(newPaths, onExifProgress).catch((e) => console.error('[exif enrich]', e))
}

async function enrichExifBackground(
  files: { path: string; ext: string }[],
  onProgress?: (enriched: number, total: number) => void
): Promise<void> {
  let enriched = 0
  const total = files.length

  for (const { path: fullPath } of files) {
    try {
      const exif = await exifr.parse(fullPath, {
        pick: ['DateTimeOriginal', 'GPSLatitude', 'GPSLongitude'],
        gps: true
      })
      if (!exif) {
        enriched++
        continue
      }

      let date: Date | null = null
      if (exif.DateTimeOriginal) date = new Date(exif.DateTimeOriginal)
      const lat = typeof exif.latitude === 'number' ? exif.latitude : null
      const lng = typeof exif.longitude === 'number' ? exif.longitude : null

      if (date || lat !== null) {
        const d = date || new Date()
        updateExifStmt.run(
          d.toISOString(),
          d.getFullYear().toString(),
          d.toLocaleString('default', { month: 'long' }),
          lat,
          lng,
          fullPath
        )
      }
    } catch {
      /* skip */
    }

    enriched++
    if (enriched % 100 === 0 && onProgress) onProgress(enriched, total)
  }

  if (onProgress) onProgress(total, total)
}
