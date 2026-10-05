import * as fs from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import { isGeneratedAsset, photoExts, allExts, MIN_PHOTO_SIZE, SKIP_DIRS } from './validation'

interface ScanTaskPayload {
  drivePath: string
  scanPath: string
  dbPath: string
  volumeId: string | null
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
  let volumeId: string | null = null

  if (args.length >= 3) {
    drivePath = args[0]
    scanPath = args[1]
    dbPath = args[2]
    volumeId = args[3] || null
  }

  // Also listen for parentPort messages if passed via IPC
  if (process.parentPort) {
    process.parentPort.on('message', (e) => {
      if (e.data && e.data.action === 'start') {
        const payload = e.data as ScanTaskPayload
        executeScan(payload.drivePath, payload.scanPath, payload.dbPath, payload.volumeId)
      }
    })
  }

  if (dbPath) {
    await executeScan(drivePath, scanPath, dbPath, volumeId)
  }
}

async function executeScan(drivePath: string, scanPath: string, dbPath: string, volumeId: string | null): Promise<void> {
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

  // Identity is (volume_id, path), not path alone (see the migration note in
  // scanner.ts), and SQLite's unique index never treats two NULLs as equal -
  // so with an unresolved volume id (getVolumeId() can and does fail: no
  // PowerShell, WMI down), INSERT OR IGNORE would no longer dedupe against an
  // existing NULL-volume_id row at the same path the way plain path
  // uniqueness used to, and every rescan of that drive would insert a fresh
  // duplicate. The existence check below is what actually dedupes, in both
  // directions:
  //  - identity known: claim any legacy row at this path first (verified by
  //    this walk finding the file there, never inferred from the letter),
  //    then only insert if nothing still matches this exact identity.
  //  - identity unknown: never insert a second row at a path anything is
  //    already recorded at - the same "one row per path" guarantee the old
  //    schema gave for free when nothing could be verified either way.
  const backfillStmt = db.prepare(`UPDATE files SET volume_id = ? WHERE path = ? AND volume_id IS NULL`)
  const insertKnownStmt = db.prepare(`
    INSERT INTO files (path, name, ext, size, date, year, month, lat, lng, drive, thumb, locked, hidden, mtime, ino, volume_id)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM files WHERE path = ? AND volume_id IS ?)
  `)
  const insertUnknownStmt = db.prepare(`
    INSERT INTO files (path, name, ext, size, date, year, month, lat, lng, drive, thumb, locked, hidden, mtime, ino, volume_id)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM files WHERE path = ?)
  `)

  let count = 0
  let lastProgressCount = 0
  let lastProgressTime = Date.now()
  const batch: any[] = []

  function flushBatch(): void {
    if (batch.length === 0) return
    const tx = db.transaction((rows: any[]) => {
      for (const row of rows) {
        const rowPath = row[0]
        const rowVolumeId = row[row.length - 1]
        if (rowVolumeId) {
          backfillStmt.run(rowVolumeId, rowPath)
          insertKnownStmt.run(...row, rowPath, rowVolumeId)
        } else {
          insertUnknownStmt.run(...row, rowPath)
        }
      }
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
          if (isGeneratedAsset(item.path)) continue

          // A missing MFT timestamp used to fall back to Date.now(), which
          // filed the record under today. Records without a usable timestamp
          // are skipped so the incremental pass can pick them up from a real
          // stat() instead of inventing a date.
          if (!item.mtime_ms) continue
          const date = new Date(item.mtime_ms)
          if (isNaN(date.getTime())) continue
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
            item.mtime_ms,
            null,
            volumeId
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
        // The app's own output is not user media. Only the watcher applied this
        // predicate; the walk did not, so every generated thumbnail was indexed
        // as a photo in its own right and each video and photo appeared twice -
        // once as itself, once as a tile showing its own thumbnail (measured on
        // a real library: 25,974 such rows, 25,873 of them exactly some other
        // row's `thumb`). purgeGeneratedAssetRows() cleaned that up at the next
        // launch; not creating the rows is the actual fix.
        if (isGeneratedAsset(fullPath)) continue
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
            ino,
            volumeId
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
