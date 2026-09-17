import { parentPort, workerData } from 'worker_threads'
import * as fs from 'fs'
import { join, dirname } from 'path'

interface FileRow {
  path: string
  size: number
  mtime: number | null
  ino: number | null
  thumb: string | null
}

interface WorkerInput {
  files: FileRow[]
  allExts: string[]
}

/**
 * Does the I/O-heavy part of incremental sync (stat every known file, look for
 * new files in known folders) off the main thread. Deliberately does NOT touch
 * the database or generate thumbnails - those still happen on the main thread
 * via the existing updateFileInPlace()/removeFileRecord(), applied only to the
 * small "changed" diff this returns, not the whole file list.
 */
function main(): void {
  const { files, allExts } = workerData as WorkerInput

  const changed: string[] = []
  const removed: string[] = []
  const scannedFolders = new Set<string>()
  const known = new Set(files.map((f) => f.path))

  let checked = 0
  for (const f of files) {
    checked++
    if (checked % 500 === 0 && parentPort) {
      parentPort.postMessage({ type: 'progress', count: checked })
    }

    scannedFolders.add(dirname(f.path))

    if (!fs.existsSync(f.path)) {
      removed.push(f.path)
      continue
    }

    try {
      const stat = fs.statSync(f.path)
      const mtimeMs = Math.round(stat.mtimeMs)
      const ino = typeof stat.ino === 'number' ? stat.ino : stat.ino ? Number(stat.ino) : null

      const isSizeChanged = stat.size !== f.size
      const isMtimeChanged = f.mtime ? mtimeMs !== f.mtime : false
      const isInoChanged = f.ino && ino ? ino !== f.ino : false
      const isThumbMissing = !f.thumb || !fs.existsSync(f.thumb)

      if (isSizeChanged || isMtimeChanged || isInoChanged || isThumbMissing) {
        changed.push(f.path)
      }
    } catch {
      /* skip unreadable file */
    }
  }

  const added: string[] = []
  for (const folder of scannedFolders) {
    if (!fs.existsSync(folder)) continue
    try {
      const entries = fs.readdirSync(folder, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase()
        if (!allExts.includes(ext)) continue
        const fullPath = join(folder, entry.name)
        if (!known.has(fullPath)) added.push(fullPath)
      }
    } catch {
      /* skip unreadable folder */
    }
  }

  if (parentPort) {
    parentPort.postMessage({ type: 'complete', changed, removed, added })
  }
}

main()
