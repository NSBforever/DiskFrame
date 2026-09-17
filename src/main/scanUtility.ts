import * as fs from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'

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

interface ScanTaskPayload {
  drivePath: string
  scanPath: string
  dbPath: string
}

function checkElevationWindows(): { isElevated: boolean; message: string } {
  try {
    const cp = require('child_process')
    const stdout = cp.execSync(
      'powershell -NoProfile -Command "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"',
      { encoding: 'utf8', timeout: 3000 }
    )
    const isElevated = stdout.trim().toLowerCase() === 'true'
    return {
      isElevated,
      message: isElevated
        ? 'Process is elevated (Administrator).'
        : 'Process is NOT elevated — opening raw volume \\\\.\\ requiring Admin rights will fail.'
    }
  } catch {
    return { isElevated: false, message: 'Could not determine elevation status.' }
  }
}

async function startUtilityScan() {
  const args = process.argv.slice(2)
  let drivePath = 'C:'
  let scanPath = 'C:\\'
  let dbPath = ''

  if (args.length >= 3) {
    drivePath = args[0]
    scanPath = args[1]
    dbPath = args[2]
  }

  // Also listen for parentPort messages if passed via IPC
  if (process.parentPort) {
    process.parentPort.on('message', (e) => {
      if (e.data && e.data.action === 'start') {
        const payload = e.data as ScanTaskPayload
        executeScan(payload.drivePath, payload.scanPath, payload.dbPath)
      }
    })
  }

  if (dbPath) {
    await executeScan(drivePath, scanPath, dbPath)
  }
}

async function executeScan(drivePath: string, scanPath: string, dbPath: string): Promise<void> {
  const elevation = checkElevationWindows()
  console.log(`[scanUtility] Starting Phase 1 enumeration for ${drivePath} (ScanPath: ${scanPath}). Elevation: ${elevation.message}`)

  if (process.parentPort) {
    process.parentPort.postMessage({
      type: 'elevation-status',
      isElevated: elevation.isElevated,
      message: elevation.message
    })
  }

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

  let nativeMftSuccess = false

  // Attempt native Rust MFT parse if native module compiled
  try {
    const nativeModule = require('../../crates/diskframe-mft')
    if (nativeModule && typeof nativeModule.parseNtfsMft === 'function' && elevation.isElevated) {
      console.log(`[scanUtility] Invoking native Rust napi-rs MFT parser for ${drivePath}...`)
      const mftItems = nativeModule.parseNtfsMft(drivePath)
      if (Array.isArray(mftItems) && mftItems.length > 0) {
        console.log(`[scanUtility] Native MFT parser returned ${mftItems.length} records. Processing...`)
        for (const item of mftItems) {
          if (item.is_dir) continue
          const ext = item.ext ? item.ext.toLowerCase() : ''
          if (!allExts.includes(ext)) continue

          const date = new Date(item.mtime_ms || Date.now())
          batch.push([
            item.path,
            item.name,
            ext,
            item.size,
            date.toISOString(),
            date.getFullYear().toString(),
            date.toLocaleString('default', { month: 'long' }),
            null,
            null,
            drivePath,
            null,
            item.mtime_ms || Date.now(),
            null
          ])
          count++

          const now = Date.now()
          if (now - lastProgressTime >= 250 || count - lastProgressCount >= 200) {
            lastProgressTime = now
            lastProgressCount = count
            if (process.parentPort) {
              process.parentPort.postMessage({ type: 'progress', count, drivePath })
            }
          }

          if (batch.length >= 500) flushBatch()
        }
        flushBatch()
        nativeMftSuccess = true
      }
    }
  } catch (mftErr) {
    console.warn('[scanUtility] Native MFT parser unavailable or failed, falling back to FindFirstFileExW directory walk:', mftErr)
  }

  // Fallback path: Parallel / Directory walk using fast stat semantics
  if (!nativeMftSuccess) {
    console.log(`[scanUtility] Running directory walk fallback for: ${scanPath}`)

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
            if (process.parentPort) {
              process.parentPort.postMessage({ type: 'progress', count, drivePath })
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
  }

  db.close()

  if (process.parentPort) {
    process.parentPort.postMessage({ type: 'complete', count, drivePath })
  }
}

startUtilityScan().catch((err) => {
  console.error('[scanUtility fatal error]:', err)
  if (process.parentPort) {
    process.parentPort.postMessage({ type: 'error', error: String(err) })
  }
})
