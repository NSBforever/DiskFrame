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
      const candidates = [
        p,
        p.replace('app.asar', 'app.asar.unpacked'),
        p + '.exe'
      ]
      for (const c of candidates) {
        if (fs.existsSync(c)) return c
      }
    }
  } catch {}
  return 'ffmpeg' // system ffmpeg fallback
}
const ffmpegExe = resolveFfmpeg()

const dbPath = join(app.getPath('userData'), 'diskframe.db')
const db = new Database(dbPath)

const thumbDir = join(app.getPath('userData'), 'thumbs')
if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true })

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
    thumb TEXT
  )
`)

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
}

export function getGroupedFiles(drivePath?: string): Record<string, ScannedFile[]> {
  const files = drivePath
    ? (db
        .prepare('SELECT * FROM files WHERE drive = ? ORDER BY date DESC')
        .all(drivePath) as ScannedFile[])
    : (db.prepare('SELECT * FROM files ORDER BY date DESC').all() as ScannedFile[])

  const grouped: Record<string, ScannedFile[]> = {}
  let videoLogs = 0
  for (const file of files) {
    if (file.ext === '.mp4' || file.ext === '.mov') {
      if (videoLogs++ < 5) console.log(`[DB] Video: ${file.path} | Thumb: ${file.thumb}`)
    }
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
    .prepare('SELECT * FROM files WHERE favourited = 1 ORDER BY date DESC')
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
      .prepare('SELECT COUNT(*) as count FROM files WHERE drive = ?')
      .get(drivePath) as { count: number }
    return row.count
  }
  const row = db.prepare('SELECT COUNT(*) as count FROM files').get() as { count: number }
  return row.count
}

export function getFilesWithoutThumbs(drivePath: string): ScannedFile[] {
  return db
    .prepare('SELECT * FROM files WHERE drive = ? AND (thumb IS NULL OR thumb = "")')
    .all(drivePath) as ScannedFile[]
}

function makeHash(fullPath: string): string {
  return createHash('md5').update(fullPath).digest('hex')
}

export async function generateThumbForFile(fullPath: string, ext: string): Promise<string | null> {
  const lowerExt = ext.toLowerCase()
  if (sharpExts.includes(lowerExt)) {
    try {
      const thumbPath = join(thumbDir, `${makeHash(fullPath)}.jpg`)
      if (fs.existsSync(thumbPath)) return thumbPath
      await sharp(fullPath)
        .rotate()
        .resize(240, 240, { fit: 'cover', position: 'centre' })
        .jpeg({ quality: 75 })
        .toFile(thumbPath)
      if (fs.existsSync(thumbPath)) return thumbPath
      return null
    } catch (e) {
      console.error('[thumb failed]', fullPath, e)
      return null
    }
  } else if (videoExts.includes(lowerExt)) {
    return new Promise((resolve) => {
      try {
        const thumbPath = join(thumbDir, `${makeHash(fullPath)}.jpg`)
        if (fs.existsSync(thumbPath)) {
          resolve(thumbPath)
          return
        }

        const ffmpeg = cp.spawn(ffmpegExe, [
          '-ss', '00:00:02',
          '-i', fullPath,
          '-vframes', '1',
          '-vf', 'scale=240:240:force_original_aspect_ratio=increase,crop=240:240',
          '-f', 'image2',
          '-q:v', '2',
          '-y',
          thumbPath
        ])

        ffmpeg.stderr.on('data', (d: Buffer) =>
          console.log('[ffmpeg thumb]', d.toString().slice(0, 100))
        )

        const killTimer = setTimeout(() => {
          try { ffmpeg.kill() } catch {}
        }, 15000)

        ffmpeg.on('close', (code) => {
          clearTimeout(killTimer)
          if (code === 0 && fs.existsSync(thumbPath)) resolve(thumbPath)
          else {
            console.warn(`[Scanner] FFmpeg close code ${code} for ${fullPath}`)
            resolve(null)
          }
        })
        ffmpeg.on('error', (err) => {
          clearTimeout(killTimer)
          console.warn(`[Scanner] FFmpeg error for ${fullPath}:`, err)
          resolve(null)
        })
      } catch (err) {
        console.warn(`[Scanner] Sync error generating video thumb for ${fullPath}:`, err)
        resolve(null)
      }
    })
  }
  return null
}

export function updateThumb(filePath: string, thumbPath: string): void {
  db.prepare('UPDATE files SET thumb = ? WHERE path = ?').run(thumbPath, filePath)
}

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

const photoExts = ['.jpg', '.jpeg', '.png', '.heic', '.raw', '.cr2', '.nef', '.webp']
const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.wmv']
const docExts = ['.pdf', '.docx', '.doc', '.txt', '.xlsx', '.pptx', '.csv']
const allExts = [...photoExts, ...videoExts, ...docExts]
const sharpExts = ['.jpg', '.jpeg', '.png', '.webp']
const MIN_PHOTO_SIZE = 50 * 1024

export async function scanDrive(
  drivePath: string,
  scanPath: string,
  onProgress: (count: number) => void
): Promise<void> {
  let count = 0

  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const nameLower = entry.name.toLowerCase()
        if (SKIP_DIRS.some((s) => nameLower === s)) continue
        if (entry.name.startsWith('.')) continue
        await walk(join(dir, entry.name))
      } else if (entry.isFile()) {
        const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase()
        if (!allExts.includes(ext)) continue
        const fullPath = join(dir, entry.name)
        try {
          const stat = fs.statSync(fullPath)
          if (photoExts.includes(ext) && stat.size < MIN_PHOTO_SIZE) continue

          const existingFile = db
            .prepare('SELECT thumb FROM files WHERE path = ?')
            .get(fullPath) as { thumb: string | null } | undefined

          let date = new Date(stat.mtime)
          let lat = null,
            lng = null

          if (!existingFile) {
            if (['.jpg', '.jpeg', '.heic', '.raw', '.cr2', '.nef'].includes(ext)) {
              try {
                const exif = await exifr.parse(fullPath, [
                  'DateTimeOriginal',
                  'latitude',
                  'longitude'
                ])
                if (exif?.DateTimeOriginal) date = new Date(exif.DateTimeOriginal)
                if (exif?.latitude) lat = exif.latitude
                if (exif?.longitude) lng = exif.longitude
              } catch {
                /* use file date */
              }
            }

            const year = date.getFullYear().toString()
            const month = date.toLocaleString('default', { month: 'long' })

            db.prepare(
              `INSERT OR IGNORE INTO files (path, name, ext, size, date, year, month, lat, lng, drive, thumb) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
              fullPath,
              entry.name,
              ext,
              stat.size,
              date.toISOString(),
              year,
              month,
              lat,
              lng,
              drivePath,
              null
            )
          }

          count++
          if (count % 20 === 0) onProgress(count)
        } catch {
          /* skip */
        }
      }
    }
  }

  await walk(scanPath)
  onProgress(count)
}
