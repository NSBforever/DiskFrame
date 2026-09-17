import { parentPort, workerData } from 'worker_threads'
import * as fs from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'

interface ScanWorkerData {
  drivePath: string
  scanPath: string
  dbPath: string
}

const photoExts = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.raw', '.cr2', '.nef']
const videoExts = ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.wmv', '.webm']
const docExts = ['.pdf', '.docx', '.doc', '.txt', '.xlsx', '.pptx', '.csv']
const allExts = [...photoExts, ...videoExts, ...docExts]
const MIN_PHOTO_SIZE = 50 * 1024

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

async function runScanWorker(): Promise<void> {
  const { drivePath, scanPath, dbPath } = workerData as ScanWorkerData

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO files (path, name, ext, size, date, year, month, lat, lng, drive, thumb, locked, hidden, mtime, ino)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
  `)

  let count = 0
  let lastProgressCount = 0
  let lastProgressTime = Date.now()

  const batch: any[] = []

  function flushBatch(): void {
    if (batch.length === 0) return
    const tx = db.transaction((rows: any[]) => {
      for (const row of rows) insertStmt.run(...row)
    })
    tx(batch)
    batch.length = 0
  }

  function walkSync(dir: string): void {
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

        const mtimeMs = Math.round(stat.mtimeMs)
        const ino = typeof stat.ino === 'number' ? stat.ino : (stat.ino ? Number(stat.ino) : null)
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
          null,
          mtimeMs,
          ino
        ])

        count++

        const now = Date.now()
        if (now - lastProgressTime >= 250 || count - lastProgressCount >= 200) {
          lastProgressTime = now
          lastProgressCount = count
          if (parentPort) {
            parentPort.postMessage({ type: 'progress', count, drivePath })
          }
        }

        if (batch.length >= 500) {
          flushBatch()
        }
      } catch {
        /* skip unreadable file */
      }
    }
  }

  walkSync(scanPath)
  flushBatch()

  db.close()

  if (parentPort) {
    parentPort.postMessage({ type: 'complete', count, drivePath })
  }
}

runScanWorker().catch((err) => {
  if (parentPort) {
    parentPort.postMessage({ type: 'error', error: String(err) })
  }
})
