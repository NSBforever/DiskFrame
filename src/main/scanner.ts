import { join } from 'path'
import * as fs from 'fs'
import exifr from 'exifr'
import Database from 'better-sqlite3'
import { app } from 'electron'

const dbPath = join(app.getPath('userData'), 'diskframe.db')
const db = new Database(dbPath)

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
    drive TEXT
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
}

// Check if a drive has already been scanned
export function isDriveScanned(drivePath: string): boolean {
  const row = db.prepare('SELECT COUNT(*) as count FROM files WHERE drive = ?').get(drivePath) as { count: number }
  return row.count > 0
}

// Clear files for a specific drive only
export function clearDrive(drivePath: string): void {
  db.prepare('DELETE FROM files WHERE drive = ?').run(drivePath)
}

export function getGroupedFiles(drivePath?: string): Record<string, ScannedFile[]> {
  const files = drivePath
    ? db.prepare('SELECT * FROM files WHERE drive = ? ORDER BY date DESC').all(drivePath) as ScannedFile[]
    : db.prepare('SELECT * FROM files ORDER BY date DESC').all() as ScannedFile[]

  const grouped: Record<string, ScannedFile[]> = {}
  for (const file of files) {
    const key = `${file.year}-${file.month}`
    if (!grouped[key]) grouped[key] = []
    grouped[key].push(file)
  }
  return grouped
}

export function getFileCount(drivePath: string): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM files WHERE drive = ?').get(drivePath) as { count: number }
  return row.count
}

const SKIP_DIRS = [
  'windows', 'program files', 'program files (x86)',
  '$recycle.bin', 'system volume information', 'programdata',
  'node_modules', '.git', 'appdata'
]

// Only real image/video files — skip tiny PNGs under 50KB (icons, assets)
const photoExts = ['.jpg', '.jpeg', '.heic', '.raw', '.cr2', '.nef']
const photoExtsWithPng = ['.jpg', '.jpeg', '.png', '.heic', '.raw', '.cr2', '.nef', '.webp']
const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.wmv']
const allExts = [...photoExtsWithPng, ...videoExts]

const MIN_PHOTO_SIZE = 50 * 1024 // 50KB — skip tiny icons/assets

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
        if (SKIP_DIRS.some(s => nameLower === s)) continue
        if (entry.name.startsWith('.')) continue
        await walk(join(dir, entry.name))
      } else if (entry.isFile()) {
        const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase()
        if (!allExts.includes(ext)) continue

        const fullPath = join(dir, entry.name)
        try {
          const stat = fs.statSync(fullPath)

          // Skip tiny files — they're icons, not real photos
          if (photoExtsWithPng.includes(ext) && stat.size < MIN_PHOTO_SIZE) continue

          let date = new Date(stat.mtime)
          let lat = null
          let lng = null

          if (photoExts.includes(ext)) {
            try {
              const exif = await exifr.parse(fullPath, ['DateTimeOriginal', 'latitude', 'longitude'])
              if (exif?.DateTimeOriginal) date = new Date(exif.DateTimeOriginal)
              if (exif?.latitude) lat = exif.latitude
              if (exif?.longitude) lng = exif.longitude
            } catch {
              // use file date
            }
          }

          const year = date.getFullYear().toString()
          const month = date.toLocaleString('default', { month: 'long' })

          db.prepare(`
            INSERT OR IGNORE INTO files (path, name, ext, size, date, year, month, lat, lng, drive)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(fullPath, entry.name, ext, stat.size, date.toISOString(), year, month, lat, lng, drivePath)

          count++
          if (count % 20 === 0) onProgress(count)
        } catch {
          // skip
        }
      }
    }
  }

  await walk(scanPath)
  onProgress(count)
}