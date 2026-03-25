import { join } from 'path'
import * as fs from 'fs'
import exifr from 'exifr'
import Database from 'better-sqlite3'
import { app } from 'electron'

const dbPath = join(app.getPath('userData'), 'diskframe.db')
const db = new Database(dbPath)

// Create table if not exists
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

// Get all files from DB
export function getFiles(drive?: string): ScannedFile[] {
  if (drive) {
    return db.prepare('SELECT * FROM files WHERE drive = ? ORDER BY date DESC').all(drive) as ScannedFile[]
  }
  return db.prepare('SELECT * FROM files ORDER BY date DESC').all() as ScannedFile[]
}

// Get files grouped by year/month
export function getGroupedFiles(drive?: string): Record<string, ScannedFile[]> {
  const files = getFiles(drive)
  const grouped: Record<string, ScannedFile[]> = {}
  for (const file of files) {
    const key = `${file.year}-${file.month}`
    if (!grouped[key]) grouped[key] = []
    grouped[key].push(file)
  }
  return grouped
}

// Scan a directory recursively
export async function scanDrive(drivePath: string, onProgress: (count: number) => void): Promise<void> {
  const photoExts = ['.jpg', '.jpeg', '.png', '.heic', '.raw', '.cr2', '.nef']
  const videoExts = ['.mp4', '.mov', '.avi', '.mkv']
  const allExts = [...photoExts, ...videoExts]

  let count = 0

  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile()) {
        const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase()
        if (!allExts.includes(ext)) continue

        try {
          const stat = fs.statSync(fullPath)
          let date = new Date(stat.mtime)
          let lat = null
          let lng = null

          // Try to read EXIF for photos
          if (photoExts.includes(ext)) {
            try {
              const exif = await exifr.parse(fullPath, ['DateTimeOriginal', 'latitude', 'longitude'])
              if (exif?.DateTimeOriginal) date = new Date(exif.DateTimeOriginal)
              if (exif?.latitude) lat = exif.latitude
              if (exif?.longitude) lng = exif.longitude
            } catch {
              // no exif, use file date
            }
          }

          const year = date.getFullYear().toString()
          const month = date.toLocaleString('default', { month: 'long' })

          db.prepare(`
            INSERT OR IGNORE INTO files (path, name, ext, size, date, year, month, lat, lng, drive)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(fullPath, entry.name, ext, stat.size, date.toISOString(), year, month, lat, lng, drivePath)

          count++
          if (count % 50 === 0) onProgress(count)
        } catch {
          // skip file
        }
      }
    }
  }

  await walk(drivePath)
  onProgress(count)
}