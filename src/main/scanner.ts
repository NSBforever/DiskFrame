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
  mapClustersSql,
  clusterThumbsSql,
  clusterCellSize,
  MAX_CLUSTERS,
  groupOffsets,
  type LibraryQuery
} from './libraryQuery'
import {
  applyMappings,
  missingRootOf,
  normalisePrefix,
  scoreMapping,
  type FolderMapping
} from './pathMapping'
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
    path TEXT NOT NULL,
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

  -- Favourites keyed by (path, volume_id), independent of the files row.
  -- A favourite must survive an unresolved path, an offline volume, and any
  -- future record repair; keeping it only as a column on files ties it to a
  -- row that reconciliation might legitimately replace. volume_id keeps two
  -- different volumes that share a literal path from fighting over one
  -- favourite entry, the same reason files.path stopped being unique alone.
  CREATE TABLE IF NOT EXISTS favourite_paths (
    path TEXT NOT NULL,
    volume_id TEXT,
    added_at TEXT,
    PRIMARY KEY (path, volume_id)
  );

  CREATE TABLE IF NOT EXISTS volume_drives (
    volume_id TEXT PRIMARY KEY,
    drive_letter TEXT,
    label TEXT,
    last_seen TEXT
  );

  /* Folders the user has explicitly pointed at a new location. Only ever
     written from a folder the user picked in a dialog - never inferred. */
  CREATE TABLE IF NOT EXISTS folder_mappings (
    from_prefix TEXT PRIMARY KEY,
    to_prefix TEXT NOT NULL,
    drive TEXT,
    volume_id TEXT,
    created_at TEXT
  );

`)
// Every index `files` needs is created further down, once the volume_id
// column is guaranteed to exist (a brand new database has only the literal
// columns declared above at this point).
// volume_id-dependent indexes are created further down, after the column
// migration that adds it - a brand new database has no such column yet at
// this point, only the literal columns declared above.

/**
 * Backs the database up before the first schema change of a new app version.
 *
 * VACUUM INTO writes a consistent copy while WAL is active, so it is safe with
 * the app running and does not need the journal checkpointed first. Only taken
 * when there is actually a migration to run, so a normal launch costs nothing.
 */
function backupBeforeMigration(tag: string): void {
  try {
    const dir = join(app.getPath('userData'), 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = join(dir, `diskframe-${stamp}-pre-${tag}.db`)
    if (fs.existsSync(target)) return
    db.prepare('VACUUM INTO ?').run(target)
    console.log('[migrate] backup written:', target)
    // Keep the five most recent; these are full copies of the library.
    const kept = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('diskframe-') && f.endsWith('.db'))
      .sort()
      .reverse()
    for (const old of kept.slice(5)) {
      try {
        fs.unlinkSync(join(dir, old))
      } catch {
        /* a backup we cannot remove is not a reason to block startup */
      }
    }
  } catch (e) {
    console.error('[migrate] backup FAILED, skipping migration:', e)
    throw e
  }
}

// Migrate existing DB — add columns if missing.
//
// Every step is guarded by a check of the current schema, so the whole block is
// safe to run on every launch and safe to re-run after a partial failure. The
// work runs inside one transaction: SQLite makes ALTER TABLE ADD COLUMN
// transactional, so a crash midway leaves the schema as it was rather than
// half-migrated.
const cols = (db.prepare('PRAGMA table_info(files)').all() as { name: string }[]).map((c) => c.name)

// Which physical volume a record was indexed from.
//
// Until now a record was identified by its drive LETTER alone, and letters are
// assigned by Windows in connection order. Two volumes that were each mounted
// as E: at different times produce two record sets that look like one drive,
// and a path that no longer resolves is indistinguishable from a path that
// belongs to a volume which is not plugged in.
//
// Deliberately NOT backfilled. A historical row keeps volume_id NULL, meaning
// "the volume this came from was never recorded" - which is the truth. Filling
// those in from the letter that happens to be mounted now would assert exactly
// the thing that cannot be established, and would turn an unresolved record
// into a confident wrong one.
const pendingColumns: { name: string; sql: string }[] = [
  { name: 'locked', sql: 'ALTER TABLE files ADD COLUMN locked INTEGER DEFAULT 0' },
  { name: 'hidden', sql: 'ALTER TABLE files ADD COLUMN hidden INTEGER DEFAULT 0' },
  { name: 'vault_path', sql: 'ALTER TABLE files ADD COLUMN vault_path TEXT' },
  { name: 'trashed_at', sql: 'ALTER TABLE files ADD COLUMN trashed_at TEXT' },
  { name: 'mtime', sql: 'ALTER TABLE files ADD COLUMN mtime INTEGER' },
  { name: 'hash', sql: 'ALTER TABLE files ADD COLUMN hash TEXT' },
  { name: 'ino', sql: 'ALTER TABLE files ADD COLUMN ino INTEGER' },
  { name: 'volume_id', sql: 'ALTER TABLE files ADD COLUMN volume_id TEXT' }
].filter((c) => !cols.includes(c.name))

const favouritesNeedSeeding =
  (
    db
      .prepare(
        'SELECT COUNT(*) n FROM files WHERE favourited = 1 AND path NOT IN (SELECT path FROM favourite_paths)'
      )
      .get() as { n: number }
  ).n > 0

if (pendingColumns.length > 0 || favouritesNeedSeeding) {
  // Back up first. If the copy cannot be written the migration does not run:
  // browsing an older schema is recoverable, an interrupted migration with no
  // copy to fall back to is not.
  backupBeforeMigration(pendingColumns.map((c) => c.name).join('-') || 'favourites')
  db.transaction(() => {
    for (const c of pendingColumns) db.prepare(c.sql).run()
    // Seed favourite_paths from records favourited before that table existed.
    // Only ever adds; a favourite is never dropped here.
    db.prepare(
      `INSERT OR IGNORE INTO favourite_paths (path, added_at)
       SELECT path, datetime('now') FROM files WHERE favourited = 1`
    ).run()
  })()
  console.log('[migrate] applied:', pendingColumns.map((c) => c.name).join(', ') || '(favourites only)')
}
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

// `path` was the sole identity of a record: UNIQUE on its own, so two
// volumes could never each keep a row at the same relative path (a second
// camera's DCIM\...\IMG_0001.JPG would simply fail to record once the first
// camera's had claimed that path). Identity is now (volume_id, path) - two
// verified-different volumes can each hold their own row there, while a
// legacy row (volume_id NULL) still cannot collide with another legacy row
// at the same path, since SQLite never treats two NULLs as equal in a unique
// index. Nothing is deleted or reassigned; every existing row keeps its id,
// its favourites (kept in the separate favourite_paths table, untouched by
// this rebuild) and every other column exactly as it was.
//
// SQLite cannot drop a column-level UNIQUE constraint with ALTER TABLE, so a
// table that still has one is rebuilt: a fresh table, the same rows copied
// across by name, the old one dropped, the new one renamed into place - the
// standard, safe pattern for a constraint change, done inside one
// transaction after the file backup above.
const filesTableSql =
  (
    db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='files'").get() as
      | { sql: string }
      | undefined
  )?.sql ?? ''

if (/path\s+TEXT\s+UNIQUE\b/i.test(filesTableSql)) {
  backupBeforeMigration('path-volume-identity')
  db.transaction(() => {
    db.exec(`
      CREATE TABLE files_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
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
        ino INTEGER,
        volume_id TEXT,
        exif_checked INTEGER DEFAULT 0
      );
      INSERT INTO files_new
        (id, path, name, ext, size, date, year, month, lat, lng, drive, favourited, thumb, locked, hidden, vault_path, trashed_at, mtime, hash, ino, volume_id, exif_checked)
      SELECT
        id, path, name, ext, size, date, year, month, lat, lng, drive, favourited, thumb, locked, hidden, vault_path, trashed_at, mtime, hash, ino, volume_id, exif_checked
      FROM files;
      DROP TABLE files;
      ALTER TABLE files_new RENAME TO files;
    `)
  })()
  console.log('[migrate] rebuilt files table: identity is now (volume_id, path), not path alone')
}

// Every index files needs. Rebuilding the table above drops its indexes with
// it, so these always run after - CREATE INDEX IF NOT EXISTS is a no-op when
// the table was not touched, and recreates everything when it was.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_files_identity ON files (volume_id, path);
  CREATE INDEX IF NOT EXISTS idx_files_drive_hidden_trashed_date ON files (drive, hidden, trashed_at, date DESC);
  CREATE INDEX IF NOT EXISTS idx_files_trashed ON files (trashed_at) WHERE trashed_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_files_favourited ON files (favourited) WHERE favourited = 1;
  -- Covers the exact ORDER BY pagination uses (date, then the unique path
  -- tie-break). Without the path column SQLite has to re-sort each page, which
  -- is what makes deep OFFSET queries degrade on a large library.
  CREATE INDEX IF NOT EXISTS idx_files_page ON files (drive, hidden, trashed_at, date DESC, path ASC);
  CREATE INDEX IF NOT EXISTS idx_files_volume_page ON files (volume_id, hidden, trashed_at, date DESC, path ASC);
`)

// favourite_paths needs the same (path, volume_id) identity as files, for the
// same reason: two different volumes can now share a literal path, and a
// favourite keyed on path alone could not tell them apart. Existing rows are
// backfilled from the current files.volume_id for that exact path - safe and
// unambiguous, since before this migration files.path was itself unique, so
// there is at most one candidate per row.
const favouritePathsSql =
  (
    db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='favourite_paths'").get() as
      | { sql: string }
      | undefined
  )?.sql ?? ''

if (favouritePathsSql && !/volume_id/i.test(favouritePathsSql)) {
  backupBeforeMigration('favourite-paths-volume-identity')
  db.transaction(() => {
    db.exec(`
      CREATE TABLE favourite_paths_new (
        path TEXT NOT NULL,
        volume_id TEXT,
        added_at TEXT,
        PRIMARY KEY (path, volume_id)
      );
      INSERT INTO favourite_paths_new (path, volume_id, added_at)
      SELECT fp.path, f.volume_id, fp.added_at
      FROM favourite_paths fp
      LEFT JOIN files f ON f.path = fp.path;
      DROP TABLE favourite_paths;
      ALTER TABLE favourite_paths_new RENAME TO favourite_paths;
    `)
  })()
  console.log('[migrate] rebuilt favourite_paths: identity is now (path, volume_id)')
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
if (!deletePrefsCols.includes('ai_search_button')) {
  try {
    db.prepare('ALTER TABLE delete_prefs ADD COLUMN ai_search_button INTEGER DEFAULT 1').run()
  } catch (e) {
    console.error('Error migrating delete_prefs (ai_search_button):', e)
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
  volume_id?: string | null
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

/** The floating bottom-right button that opens the fuzzy/place-name search overlay. */
export function getAiSearchButtonPref(): boolean {
  try {
    const row = db.prepare('SELECT ai_search_button FROM delete_prefs WHERE id = 1').get() as
      | { ai_search_button: number }
      | undefined
    return (row?.ai_search_button ?? 1) === 1
  } catch {
    return true
  }
}

export function setAiSearchButtonPref(enabled: boolean): void {
  try {
    const exists = db.prepare('SELECT id FROM delete_prefs WHERE id = 1').get()
    if (exists) {
      db.prepare('UPDATE delete_prefs SET ai_search_button = ? WHERE id = 1').run(enabled ? 1 : 0)
    } else {
      db.prepare('INSERT OR REPLACE INTO delete_prefs (id, ai_search_button) VALUES (1, ?)').run(enabled ? 1 : 0)
    }
  } catch (e) {
    console.error('Error saving AI search button pref:', e)
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
/** Trashed rows for one volume - see getFavourites for why a legacy row with
 *  no recorded identity is left out rather than guessed. */
export function getTrashedFiles(volumeId: string | null): ScannedFile[] {
  if (!volumeId) return []
  return db
    .prepare('SELECT * FROM files WHERE trashed_at IS NOT NULL AND volume_id = ? ORDER BY trashed_at DESC')
    .all(volumeId) as ScannedFile[]
}

export function getTrashCount(volumeId: string | null): number {
  if (!volumeId) return 0
  const row = db
    .prepare('SELECT COUNT(*) as count FROM files WHERE trashed_at IS NOT NULL AND volume_id = ?')
    .get(volumeId) as { count: number }
  return row?.count ?? 0
}

/** A path, or a path plus the volume it must belong to (see toggleFavourite). */
export type PathRef = string | { path: string; volumeId?: string | null }
function refPath(r: PathRef): string {
  return typeof r === 'string' ? r : r.path
}
function refVolumeId(r: PathRef): string | null | undefined {
  return typeof r === 'string' ? undefined : r.volumeId
}

export function softDeleteFiles(refs: PathRef[]): void {
  const stmt = db.prepare('UPDATE files SET trashed_at = ? WHERE path = ?')
  const stmtScoped = db.prepare('UPDATE files SET trashed_at = ? WHERE path = ? AND volume_id IS ?')
  const now = new Date().toISOString()
  const tx = db.transaction(() => {
    for (const r of refs) {
      const volumeId = refVolumeId(r)
      if (volumeId !== undefined) stmtScoped.run(now, refPath(r), volumeId)
      else stmt.run(now, refPath(r))
    }
  })
  tx()
}

export function restoreFiles(refs: PathRef[]): void {
  const stmt = db.prepare('UPDATE files SET trashed_at = NULL WHERE path = ?')
  const stmtScoped = db.prepare('UPDATE files SET trashed_at = NULL WHERE path = ? AND volume_id IS ?')
  const tx = db.transaction(() => {
    for (const r of refs) {
      const volumeId = refVolumeId(r)
      if (volumeId !== undefined) stmtScoped.run(refPath(r), volumeId)
      else stmt.run(refPath(r))
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

export async function deleteFilesPermanently(refs: PathRef[]): Promise<{ success: string[]; failed: string[] }> {
  const success: string[] = []
  const failed: string[] = []
  const selectAll = db.prepare('SELECT * FROM files WHERE path = ?')
  const selectScoped = db.prepare('SELECT * FROM files WHERE path = ? AND volume_id IS ?')
  const deletePlain = db.prepare('DELETE FROM files WHERE path = ?')
  const deleteScoped = db.prepare('DELETE FROM files WHERE path = ? AND volume_id IS ?')
  for (const r of refs) {
    const p = refPath(r)
    const requestedVolumeId = refVolumeId(r)
    try {
      // Row identity is now (volume_id, path): when the caller told us which
      // volume, look up exactly that row. If it no longer matches (the row
      // was backfilled with a real identity since the caller last read it),
      // fall back to path alone only when that is unambiguous - exactly one
      // row still at this path. Two or more candidates with no exact match
      // is a genuine collision: refuse rather than guess which one to
      // delete. A caller with no volume context at all (a legacy batch
      // action) keeps the old plain-path behaviour outright.
      let file: ScannedFile | undefined
      if (requestedVolumeId !== undefined) {
        file = selectScoped.get(p, requestedVolumeId) as ScannedFile | undefined
        if (!file) {
          const candidates = selectAll.all(p) as ScannedFile[]
          if (candidates.length === 1) file = candidates[0]
          else if (candidates.length > 1) {
            console.error(`[deletePermanent] ${p}: ${candidates.length} rows collide with no exact identity match - refusing to guess`)
            failed.push(p)
            continue
          }
        }
      } else {
        file = selectAll.get(p) as ScannedFile | undefined
      }
      if (file) {
        // A path can exist and still be the wrong file - a legacy row and an
        // unrelated device can share a common camera path (DCIM\...\IMG_0001.JPG).
        // Only delete once identity says this really is the recorded file.
        const availability = checkPathAvailability(p, file.volume_id ?? null).status
        if (availability !== 'ok' && availability !== 'missing') {
          // Cannot verify this is the recorded file (offline drive, unresolved
          // identity, a folder that moved). Forgetting the DB row now would
          // both leave the real file undeleted forever AND make it reappear,
          // no longer marked trashed, the next time its real volume is
          // properly scanned. Leave it queued in trash for a later attempt.
          failed.push(p)
          continue
        }
        if (availability === 'ok') {
          await safeDelete(p)
        }
        if (file.vault_path && fs.existsSync(file.vault_path)) {
          await safeDelete(file.vault_path)
        }
        if (file.thumb && fs.existsSync(file.thumb)) {
          fs.unlinkSync(file.thumb)
        }
        // Deletes exactly the row just inspected above, by its own identity -
        // not a fresh path-only DELETE, which would remove every row at a
        // colliding path instead of only this one.
        deleteScoped.run(p, file.volume_id ?? null)
      } else {
        deletePlain.run(p)
      }
      success.push(p)
    } catch (e) {
      console.error('[deletePermanent] failed for', p, e)
      failed.push(p)
    }
  }
  return { success, failed }
}

/**
 * Empties trash for one volume only - "Empty Trash" inside a selected drive
 * must never touch another drive's trashed files. `volumeId` null (identity
 * unresolved) empties nothing rather than guessing.
 */
export async function emptyTrash(volumeId: string | null): Promise<{ success: boolean; count: number }> {
  if (!volumeId) return { success: true, count: 0 }
  const toPurge = db
    .prepare('SELECT * FROM files WHERE trashed_at IS NOT NULL AND volume_id = ?')
    .all(volumeId) as ScannedFile[]
  let count = 0
  for (const file of toPurge) {
    try {
      const availability = checkPathAvailability(file.path, file.volume_id ?? null).status
      if (availability !== 'ok' && availability !== 'missing') {
        // Can't verify this is the recorded file yet (offline drive, unresolved
        // identity). Leave it trashed rather than forgetting the row - that
        // would both skip the real delete and let the file reappear,
        // un-trashed, the next time its real volume is scanned.
        continue
      }
      if (availability === 'ok') {
        await safeDelete(file.path)
      }
      if (file.vault_path && fs.existsSync(file.vault_path)) {
        await safeDelete(file.vault_path)
      }
      if (file.thumb && fs.existsSync(file.thumb)) {
        fs.unlinkSync(file.thumb)
      }
      // Scoped to this exact row's identity - a bare path DELETE would remove
      // every row at a colliding path, not only the one just inspected above.
      db.prepare('DELETE FROM files WHERE path = ? AND volume_id IS ?').run(file.path, file.volume_id ?? null)
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
        const availability = checkPathAvailability(file.path, file.volume_id ?? null).status
        if (availability !== 'ok' && availability !== 'missing') {
          continue
        }
        if (availability === 'ok') {
          await safeDelete(file.path)
        }
        if (file.vault_path && fs.existsSync(file.vault_path)) {
          await safeDelete(file.vault_path)
        }
        if (file.thumb && fs.existsSync(file.thumb)) {
          fs.unlinkSync(file.thumb)
        }
        db.prepare('DELETE FROM files WHERE path = ? AND volume_id IS ?').run(file.path, file.volume_id ?? null)
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
  'path, name, ext, size, date, year, month, lat, lng, drive, favourited, thumb, volume_id'

/**
 * Files for one open drive, or the whole library when no drive is given.
 *
 * A drive letter is a mount point, not an identity - two different volumes can
 * each be "D:" at different times. Real drives are therefore scoped by
 * `volumeId`, resolved live by the caller for whatever is mounted at that
 * letter right now; rows from a volume that is not currently proven to be the
 * one at that letter (including pre-identity legacy rows with no volume_id at
 * all) are never included just because the letter matches. When identity
 * cannot be established (`volumeId` is null/undefined for a real drive) this
 * returns nothing rather than guessing - an honest empty catalogue, not a
 * borrowed one. The diagnostic sample bypasses this entirely: it has its own
 * key and no physical volume to verify.
 */
export function getGroupedFiles(drivePath?: string, volumeId?: string | null): Record<string, ScannedFile[]> {
  let files: ScannedFile[]
  if (!drivePath) {
    files = db
      .prepare(`SELECT ${GROUPED_COLS} FROM files WHERE hidden = 0 AND trashed_at IS NULL ORDER BY date DESC`)
      .all() as ScannedFile[]
  } else if (drivePath === SAMPLE_DRIVE_KEY) {
    files = db
      .prepare(`SELECT ${GROUPED_COLS} FROM files WHERE drive = ? AND hidden = 0 AND trashed_at IS NULL ORDER BY date DESC`)
      .all(drivePath) as ScannedFile[]
  } else if (volumeId) {
    files = db
      .prepare(`SELECT ${GROUPED_COLS} FROM files WHERE volume_id = ? AND hidden = 0 AND trashed_at IS NULL ORDER BY date DESC`)
      .all(volumeId) as ScannedFile[]
  } else {
    files = []
  }

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

/**
 * Favourites for one volume - never every drive at once. A file with no
 * recorded identity (a legacy row never re-verified by a scan) is left out
 * rather than guessed into whichever volume happens to be open; it reappears
 * here on its own once that file is rediscovered by a real walk of its real
 * volume, the same self-healing backfill the rest of the library relies on.
 */
export function getFavourites(volumeId: string | null): ScannedFile[] {
  if (!volumeId) return []
  return db
    .prepare('SELECT * FROM files WHERE favourited = 1 AND volume_id = ? AND hidden = 0 AND trashed_at IS NULL ORDER BY date DESC')
    .all(volumeId) as ScannedFile[]
}


/**
 * Keeps path-keyed side tables in step when a record's path changes.
 *
 * favourite_paths is keyed by (path, volume_id) so it can outlive the files
 * row, which also means a relink would orphan it - the favourite would
 * silently point at a location that no longer holds the file. Every place
 * that rewrites files.path must call this. `volumeId` scopes the move to the
 * one row actually being renamed; passed as `undefined` it falls back to
 * moving every favourite at `oldPath`, which is only safe when the caller
 * cannot know which volume it belongs to.
 */
function repointPath(oldPath: string, newPath: string, volumeId?: string | null): void {
  if (!oldPath || !newPath || oldPath === newPath) return
  if (volumeId !== undefined) {
    db.prepare('UPDATE OR REPLACE favourite_paths SET path = ? WHERE path = ? AND volume_id IS ?').run(
      newPath,
      oldPath,
      volumeId
    )
  } else {
    db.prepare('UPDATE OR REPLACE favourite_paths SET path = ? WHERE path = ?').run(newPath, oldPath)
  }
}

/**
 * Returns the resulting state, so callers don't need a second read.
 *
 * `volumeId` disambiguates when two different, verified volumes each hold a
 * row at the same path (possible since identity became (volume_id, path) -
 * see the migration note by the files table). Passed as `undefined` (not
 * supplied) this matches on path alone, same as before; passed `null` or a
 * real id, it only ever touches the one row that actually has that identity,
 * so a batch action working from paths alone never toggles a stranger's file
 * that happens to share one.
 */
export function toggleFavourite(filePath: string, volumeId?: string | null): boolean {
  if (volumeId !== undefined) {
    db.prepare(
      'UPDATE files SET favourited = CASE WHEN favourited = 1 THEN 0 ELSE 1 END WHERE path = ? AND volume_id IS ?'
    ).run(filePath, volumeId)
  } else {
    db.prepare(
      'UPDATE files SET favourited = CASE WHEN favourited = 1 THEN 0 ELSE 1 END WHERE path = ?'
    ).run(filePath)
  }
  const row = (
    volumeId !== undefined
      ? db.prepare('SELECT favourited, volume_id FROM files WHERE path = ? AND volume_id IS ?').get(filePath, volumeId)
      : db.prepare('SELECT favourited, volume_id FROM files WHERE path = ?').get(filePath)
  ) as { favourited: number; volume_id: string | null } | undefined
  const on = (row?.favourited ?? 0) === 1
  // Mirror into the standalone table. The files row stays authoritative for
  // the UI; this copy is what survives if the record is ever replaced.
  // volume_id is stored even when the caller didn't supply one, read back
  // from the row just toggled - so this table stays as identity-scoped as
  // files itself, regardless of which callers know their volume up front.
  const rowVolumeId = volumeId !== undefined ? volumeId : (row?.volume_id ?? null)
  if (on) {
    db.prepare('INSERT OR REPLACE INTO favourite_paths (path, volume_id, added_at) VALUES (?, ?, ?)').run(
      filePath,
      rowVolumeId,
      new Date().toISOString()
    )
  } else {
    db.prepare('DELETE FROM favourite_paths WHERE path = ? AND volume_id IS ?').run(filePath, rowVolumeId)
  }
  return on
}

/** Every favourited path, including ones whose file does not currently resolve. */
export function getFavouritePaths(): string[] {
  return (db.prepare('SELECT path FROM favourite_paths ORDER BY added_at').all() as { path: string }[]).map(
    (r) => r.path
  )
}

/**
 * Count for one volume's catalogue, or the whole library with no argument.
 *
 * Scoped by `volumeId`, not by letter, for the same reason as
 * {@link getGroupedFiles}. Pass `null`/`undefined` for a real drive whose
 * identity could not be verified and this reports 0, never a legacy or
 * foreign volume's count.
 */
export function getFileCount(volumeId?: string | null): number {
  if (volumeId === undefined) {
    const row = db.prepare('SELECT COUNT(*) as count FROM files WHERE trashed_at IS NULL').get() as {
      count: number
    }
    return row.count
  }
  if (!volumeId) return 0
  const row = db
    .prepare('SELECT COUNT(*) as count FROM files WHERE volume_id = ? AND trashed_at IS NULL')
    .get(volumeId) as { count: number }
  return row.count
}

// Restricted to extensions a thumbnail can actually be produced from. The
// unrestricted version handed the backfill thousands of .db/.json/.ts/no-ext
// rows, each costing a failed sharp or ffmpeg spawn at startup.
/** A thumbnail column that does not name a real file on disk. */
const NO_THUMB_SQL = "(thumb IS NULL OR thumb = '' OR thumb = 'NO_FILE')"

/** Ceiling on one backfill pass, so a freshly scanned 2 TB volume cannot pull
 *  a hundred thousand rows into main-process memory in one query. The pass is
 *  re-run (newest-first again) when it finishes, so nothing is lost. */
export const THUMB_BACKFILL_BATCH = 2000

/**
 * Rows still owing a thumbnail, newest first.
 *
 * `volumeId` scopes the pass to the volume the user is actually looking at.
 * Unscoped, finishing a scan of a large external drive meant the backfill then
 * worked through every other drive's missing thumbnails too - spending the
 * machine's two thumbnail slots on files nobody was looking at.
 */
export function getAllFilesWithoutThumbs(
  volumeId?: string | null,
  limit: number = THUMB_BACKFILL_BATCH
): ScannedFile[] {
  const thumbable = thumbnailExts
  const placeholders = thumbable.map(() => '?').join(',')
  const scope = volumeId ? 'AND volume_id = ?' : ''
  const params: unknown[] = volumeId ? [...thumbable, volumeId] : [...thumbable]
  return db
    .prepare(
      `SELECT * FROM files
       WHERE ${NO_THUMB_SQL} AND trashed_at IS NULL AND ext IN (${placeholders}) ${scope}
       ORDER BY date DESC LIMIT ?`
    )
    .all(...(params as never[]), Math.max(1, Math.floor(limit))) as ScannedFile[]
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

// Scoped to (path, volume_id): the file actually read from disk belongs to
// whichever volume is mounted right now, and a bare path WHERE would write
// its EXIF onto every row at a colliding path, including another volume's
// that is not even connected.
const updateExifStmt = db.prepare(
  `UPDATE files SET date=?, year=?, month=?, lat=?, lng=? WHERE path=? AND volume_id IS ? AND lat IS NULL`
)

// A file with GPS but no capture date must keep whatever date it already has
// (the filesystem mtime from the scan pass). Writing new Date() here stamped it
// with "today", which is why a large share of the library collapsed into the
// current month and sorted above genuinely recent photos.
const updateGpsOnlyStmt = db.prepare(
  `UPDATE files SET lat=?, lng=? WHERE path=? AND volume_id IS ? AND lat IS NULL`
)

const markExifCheckedStmt = db.prepare('UPDATE files SET exif_checked = 1 WHERE path = ? AND volume_id IS ?')

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
        `SELECT path, ext, volume_id FROM files
         WHERE exif_checked = 0 AND trashed_at IS NULL AND ext IN (${placeholders})
         ORDER BY date DESC`
      )
      .all(...extList) as { path: string; ext: string; volume_id: string | null }[]

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
        const { path: fullPath, ext, volume_id: rowVolumeId } = pending[cursor++]
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
              fullPath,
              rowVolumeId
            )
            corrected++
          } else if (lat !== null) {
            updateGpsOnlyStmt.run(lat, lng, fullPath, rowVolumeId)
          }
        } catch {
          /* unreadable, or simply has no metadata - the mtime date stands */
        }
        // Marked either way, so a file that genuinely has no EXIF is not
        // re-parsed on every launch for the rest of the library's life.
        markExifCheckedStmt.run(fullPath, rowVolumeId)

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
  // The specific row this call is about, so a relink below touches exactly
  // this one - never every row a bare `path = filePath` WHERE would match if
  // another volume happens to have had the same relative path.
  const missingRow = db.prepare('SELECT * FROM files WHERE path = ?').get(filePath) as ScannedFile | undefined
  const missingVolumeId = missingRow?.volume_id ?? null
  const relinkStmt = db.prepare('UPDATE files SET path = ?, name = ? WHERE path = ? AND volume_id IS ?')

  // 2. Search database for files matching exact filename or path
  const candidates = db
    .prepare('SELECT * FROM files WHERE name = ? OR path = ?')
    .all(targetName, filePath) as ScannedFile[]

  // Check if any candidate's path exists on disk right now
  for (const candidate of candidates) {
    if (fs.existsSync(candidate.path)) {
      console.log(`[PathResilience] Found moved file at indexed path: "${candidate.path}"`)
      relinkStmt.run(candidate.path, basename(candidate.path), filePath, missingVolumeId)
      repointPath(filePath, candidate.path, missingVolumeId)
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
            relinkStmt.run(candidatePath, targetName, filePath, missingVolumeId)
            repointPath(filePath, candidatePath, missingVolumeId)
            return { path: candidatePath, relinked: true, exists: true }
          }
        }
      }
    } catch {}
  }

  return { path: filePath, relinked: false, exists: false }
}

/** `volumeId` disambiguates a colliding path the same way toggleFavourite does. */
export function removeFileRecord(filePath: string, volumeId?: string | null): void {
  // Matches the live volume's own row OR a still-legacy one at this path -
  // never a different, already-identified volume's row. A confirmed-gone
  // file might not have been backfilled with an identity yet (only a scan
  // walk does that), and an exact-only match would silently leave that row
  // behind forever as a ghost, believing nothing needed deleting.
  const row = (
    volumeId !== undefined
      ? db
          .prepare(
            'SELECT thumb FROM files WHERE path = ? AND (volume_id IS ? OR volume_id IS NULL) ORDER BY (volume_id IS NULL) LIMIT 1'
          )
          .get(filePath, volumeId)
      : db.prepare('SELECT thumb FROM files WHERE path = ?').get(filePath)
  ) as { thumb: string | null } | undefined
  if (row?.thumb && fs.existsSync(row.thumb)) {
    try {
      fs.unlinkSync(row.thumb)
    } catch {}
  }
  if (volumeId !== undefined) {
    db.prepare('DELETE FROM files WHERE path = ? AND (volume_id IS ? OR volume_id IS NULL)').run(filePath, volumeId)
  } else {
    db.prepare('DELETE FROM files WHERE path = ?').run(filePath)
  }
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
        removeFileRecord(filePath, getCachedVolumeId(filePath.slice(0, 2)))
        return null
      }
      stat = fs.statSync(filePath)
    } catch {
      return null
    }
  }

  const ext = extname(filePath).toLowerCase()
  const drive = filePath.slice(0, 2).toUpperCase()
  // Whatever is currently live at this letter, verified by the watcher
  // actually seeing this file appear/change there just now - never inferred
  // from the letter alone for a row that already has a different identity.
  const volumeId = getCachedVolumeId(drive)

  // Prefers the row that already carries this exact identity; failing that,
  // a legacy row at the path with no recorded identity is the backfill
  // candidate. Never a row that already belongs to a DIFFERENT verified
  // volume - two devices can share a relative path, and this is exactly the
  // case identity now keeps apart (see the files-table migration note).
  const existing = db
    .prepare(
      `SELECT * FROM files WHERE path = ? AND (volume_id IS ? OR volume_id IS NULL)
       ORDER BY (volume_id IS NULL) LIMIT 1`
    )
    .get(filePath, volumeId) as ScannedFile | undefined

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

  const mtimeMs = Math.round(stat.mtimeMs)
  const date = new Date(stat.mtime)
  const year = date.getFullYear().toString()
  const month = date.toLocaleString('default', { month: 'long' })

  if (existing) {
    // Scoped to the exact row resolved above, by its own (possibly still
    // legacy-null) identity - never a bare path WHERE, which would touch
    // every row at a colliding path instead of only this one.
    db.prepare(`
      UPDATE files
      SET size = ?, date = ?, year = ?, month = ?, thumb = ?, mtime = ?, ino = ?,
          volume_id = COALESCE(volume_id, ?)
      WHERE path = ? AND volume_id IS ?
    `).run(
      stat.size,
      date.toISOString(),
      year,
      month,
      newThumb,
      mtimeMs,
      stat.ino ? Number(stat.ino) : null,
      volumeId,
      filePath,
      existing.volume_id ?? null
    )
  } else {
    db.prepare(`
      INSERT OR REPLACE INTO files (path, name, ext, size, date, year, month, lat, lng, drive, thumb, locked, hidden, mtime, ino, volume_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
    `).run(filePath, basename(filePath), ext, stat.size, date.toISOString(), year, month, null, null, drive, newThumb, mtimeMs, stat.ino ? Number(stat.ino) : null, volumeId)
  }

  const updated = db
    .prepare('SELECT * FROM files WHERE path = ? AND (volume_id IS ? OR volume_id IS NULL) ORDER BY (volume_id IS NULL) LIMIT 1')
    .get(filePath, volumeId) as ScannedFile | undefined
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
       (path, name, ext, size, date, year, month, lat, lng, drive, thumb, favourited, locked, hidden, vault_path, trashed_at, mtime, exif_checked, volume_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, NULL, ?, ?, ?)`
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
    row ? 1 : 0,
    getCachedVolumeId(destDrive)
  )
}

/** Moves an existing row to its new path, or indexes the file if it was untracked. */
export function recordMovedFile(srcPath: string, destPath: string, destDrive: string): void {
  const exists = db.prepare('SELECT 1 FROM files WHERE path = ?').get(srcPath)
  if (exists) {
    db.prepare('UPDATE files SET path = ?, name = ?, drive = ?, volume_id = ? WHERE path = ?').run(
      destPath,
      basename(destPath),
      destDrive,
      getCachedVolumeId(destDrive),
      srcPath
    )
    repointPath(srcPath, destPath)
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
  groups: {
    key: string
    count: number
    compactCount: number
    minDate: string
    maxDate: string
    offset: number
  }[]
} {
  const s = summarySql(q)
  const rows = db.prepare(s.sql).all(...(s.params as never[])) as {
    gkey: string
    n: number
    n_compact: number
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
      compactCount: r.n_compact ?? 0,
      minDate: r.min_date,
      maxDate: r.max_date,
      offset: offsets.get(r.gkey) ?? 0
    }))
  }
}

/**
 * A fingerprint of the catalogue's current contents.
 *
 * Changes whenever anything writes to `files`, from any connection:
 * PRAGMA data_version moves when ANOTHER connection commits (the scan utility
 * is a separate process with its own connection, which is the case that matters
 * during discovery), and total_changes() moves when this connection writes (the
 * watcher, favourites, trash). Either is enough to tell the renderer that the
 * pages it already holds were read against a different set of rows.
 *
 * Two cheap reads, no table scan - this is called once per summary/page request.
 */
export function getCatalogueVersion(): string {
  const dv = db.prepare('PRAGMA data_version').get() as { data_version?: number } | undefined
  const tc = db.prepare('SELECT total_changes() AS n').get() as { n?: number } | undefined
  return `${dv?.data_version ?? 0}:${tc?.n ?? 0}`
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

export interface MapCluster {
  /** Cell coordinates, stable for a given zoom - the renderer keys markers on them. */
  cx: number
  cy: number
  count: number
  lat: number
  lng: number
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
  /** Representative thumbnail path, if any file in the cell has one. */
  thumb: string | null
  path: string | null
}

/**
 * Clusters for one map viewport at one zoom level.
 *
 * Two bounded queries whatever the size of the library: one aggregate for the
 * counts and bounds, one windowed read for a single representative row per
 * cell. Nothing here returns a row per file, so panning a map over a hundred
 * thousand photos costs the same as panning over a hundred.
 */
export function getMapClusters(q: LibraryQuery, zoom: number): MapCluster[] {
  const cell = clusterCellSize(zoom)
  const c = mapClustersSql(q, cell)
  const cells = db.prepare(c.sql).all(...(c.params as never[]), MAX_CLUSTERS) as {
    cy: number
    cx: number
    n: number
    lat: number
    lng: number
    min_lat: number
    max_lat: number
    min_lng: number
    max_lng: number
  }[]
  if (cells.length === 0) return []

  const t = clusterThumbsSql(q, cell)
  const reps = db.prepare(t.sql).all(...(t.params as never[])) as {
    cy: number
    cx: number
    thumb: string | null
    path: string | null
  }[]
  const byCell = new Map<string, { thumb: string | null; path: string | null }>()
  for (const r of reps) byCell.set(r.cy + ':' + r.cx, { thumb: r.thumb, path: r.path })

  return cells.map((r) => {
    const rep = byCell.get(r.cy + ':' + r.cx)
    return {
      cx: r.cx,
      cy: r.cy,
      count: r.n,
      lat: r.lat,
      lng: r.lng,
      minLat: r.min_lat,
      maxLat: r.max_lat,
      minLng: r.min_lng,
      maxLng: r.max_lng,
      thumb: rep?.thumb ?? null,
      path: rep?.path ?? null
    }
  })
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

/**
 * Indexes ONE folder into the real library, bounded by file count and depth.
 *
 * This is the production path, not the diagnostic sample: records carry the
 * folder's actual drive letter and the volume id read from the mounted volume,
 * so they are identified by the disk they came from rather than by a letter
 * Windows happened to assign. Nothing outside `folder` is touched and no
 * existing record is modified - INSERT OR IGNORE leaves any row already
 * present exactly as it is, which keeps favourites, thumbs and EXIF intact.
 *
 * Thumbnails are deliberately NOT generated here. They are produced on demand
 * for what is actually on screen plus a buffer, so indexing a large folder
 * cannot turn into a long decode queue.
 */
let cancelIndexRequested = false
/** Asks an in-progress indexFolderBounded to stop at the next entry. */
export function cancelFolderIndex(): void {
  cancelIndexRequested = true
}

export interface FolderIndexResult {
  added: number
  /** Media files considered for indexing. */
  seen: number
  /** Directory entries visited, media or not. This is what bounds the walk. */
  visited: number
  skipped: number
  drive: string
  volumeId: string | null
  /** Why the walk stopped early, if it did. */
  stoppedBy: 'files' | 'entries' | 'cancelled' | null
  /** False when the walk stopped early, so callers never treat it as complete. */
  complete: boolean
}

/**
 * Indexes ONE folder into the real library, bounded by visited entries as well
 * as indexed files, and cancellable.
 *
 * This is the production path, not the diagnostic sample: records carry the
 * folder's actual drive letter and the volume id read from the mounted volume,
 * so they are identified by the disk they came from rather than by a letter
 * Windows happened to assign.
 *
 * Two separate bounds matter. A file cap alone does not bound the walk - a
 * folder of a million non-media files would be traversed in full while adding
 * nothing - so entries visited is capped too.
 *
 * Nothing is ever marked missing here. The walk may stop early, so anything
 * not visited is simply unknown; concluding otherwise would turn a truncated
 * walk into a claim that files were deleted. Only INSERT OR IGNORE is used, so
 * existing records keep their favourites, thumbnails and EXIF untouched.
 *
 * Thumbnails are deliberately NOT generated here - they are produced on demand
 * for what is on screen plus a small buffer.
 */
export async function indexFolderBounded(
  folder: string,
  maxFiles = 5000,
  maxEntries = 200000
): Promise<FolderIndexResult> {
  cancelIndexRequested = false
  const drive = folder.slice(0, 2).toUpperCase()
  const volumeId = await getVolumeId(drive)
  if (volumeId) {
    primeVolumeCache(drive, volumeId)
    reconcileDriveLetterForVolume(volumeId, drive)
  }

  // Identity is (volume_id, path), not path alone (see the migration note by
  // the files table), so a legacy row and a fresh insert for the volume this
  // walk is scanning are different keys and would never collide under ON
  // CONFLICT - and SQLite's unique index never treats two NULLs as equal, so
  // with volumeId unresolved (getVolumeId() can fail), a plain INSERT OR
  // IGNORE would stop deduping against an existing NULL-volume_id row and
  // duplicate it on every re-index instead. The backfill runs as its own
  // step first - claiming a legacy row at this exact path, verified by this
  // walk actually finding the file there - and the insert is conditioned on
  // an explicit existence check rather than relying on a constraint that no
  // longer covers the unresolved-identity case.
  const backfill = db.prepare(`UPDATE files SET volume_id = ? WHERE path = ? AND volume_id IS NULL`)
  const insert = volumeId
    ? db.prepare(
        `INSERT INTO files
           (path, name, ext, size, date, year, month, lat, lng, drive, thumb, locked, hidden, mtime, ino, volume_id, exif_checked)
         SELECT ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, 0, 0, ?, ?, ?, 0
         WHERE NOT EXISTS (SELECT 1 FROM files WHERE path = ? AND volume_id IS ?)`
      )
    : db.prepare(
        `INSERT INTO files
           (path, name, ext, size, date, year, month, lat, lng, drive, thumb, locked, hidden, mtime, ino, volume_id, exif_checked)
         SELECT ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, 0, 0, ?, ?, ?, 0
         WHERE NOT EXISTS (SELECT 1 FROM files WHERE path = ?)`
      )

  const rows: Parameters<typeof insert.run>[] = []
  let skipped = 0
  let seen = 0
  let visited = 0
  let stoppedBy: 'files' | 'entries' | 'cancelled' | null = null
  const stack: { dir: string; depth: number }[] = [{ dir: folder, depth: 0 }]

  outer: while (stack.length > 0) {
    const { dir, depth } = stack.pop()!
    if (depth > 8) continue
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (cancelIndexRequested) {
        stoppedBy = 'cancelled'
        break outer
      }
      if (rows.length >= maxFiles) {
        stoppedBy = 'files'
        break outer
      }
      if (visited >= maxEntries) {
        stoppedBy = 'entries'
        break outer
      }
      visited++
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) stack.push({ dir: fullPath, depth: depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      if (!isIndexableUserMedia(fullPath)) {
        skipped++
        continue
      }
      seen++
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
          drive,
          Math.round(stat.mtimeMs),
          stat.ino ? Number(stat.ino) : null,
          volumeId
        ])
      } catch {
        skipped++
      }
    }
  }

  // Whatever was gathered before stopping is still committed - a cancelled or
  // truncated run reports partial progress rather than discarding it.
  let added = 0
  db.transaction(() => {
    for (const r of rows) {
      if (volumeId) {
        backfill.run(volumeId, r[0])
        added += insert.run(...r, r[0], volumeId).changes
      } else {
        added += insert.run(...r, r[0]).changes
      }
    }
  })()
  cancelIndexRequested = false
  return { added, seen, visited, skipped, drive, volumeId, stoppedBy, complete: stoppedBy === null }
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
    SET path = ?, name = ?, ext = ?, drive = ?, size = ?, mtime = ?, ino = ?, volume_id = COALESCE(volume_id, ?)
    WHERE path = ? AND volume_id IS ?
  `).run(
    newPath,
    basename(newPath),
    ext,
    drive,
    stat.size,
    mtimeMs,
    stat.ino ? Number(stat.ino) : null,
    getCachedVolumeId(drive),
    oldPath,
    existing.volume_id ?? null
  )
  repointPath(oldPath, newPath, existing.volume_id ?? null)

  const updated = db
    .prepare('SELECT * FROM files WHERE path = ? AND (volume_id IS ? OR volume_id IS NULL) ORDER BY (volume_id IS NULL) LIMIT 1')
    .get(newPath, existing.volume_id ?? null) as ScannedFile | undefined
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
): Promise<{ fullScanNeeded: boolean; count: number; volumeId: string | null }> {
  const driveKey = drivePath.slice(0, 2).toUpperCase()
  if (syncsInProgress.has(driveKey)) {
    const volumeId = getCachedVolumeId(driveKey)
    return { fullScanNeeded: false, count: getFileCount(volumeId), volumeId }
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
): Promise<{ fullScanNeeded: boolean; count: number; volumeId: string | null }> {
  const currentVolId = await getVolumeId(drivePath)
  primeVolumeCache(drivePath, currentVolId)

  // No identity, no honest scope to sync against - require an explicit scan
  // rather than falling back to whatever the letter happens to hold.
  if (!currentVolId) {
    console.warn(`[incrementalSync] Could not verify volume identity for ${drivePath}; requiring an explicit scan.`)
    return { fullScanNeeded: true, count: 0, volumeId: null }
  }

  const storedVolId = getStoredVolumeId(drivePath)
  if (storedVolId && storedVolId !== currentVolId) {
    console.log(`[incrementalSync] Volume ID mismatch for ${drivePath} (stored: ${storedVolId}, current: ${currentVolId}). Full scan required.`)
    return { fullScanNeeded: true, count: 0, volumeId: currentVolId }
  }

  reconcileDriveLetterForVolume(currentVolId, drivePath)
  saveVolumeDrive(currentVolId, drivePath)

  const driveNorm = drivePath.slice(0, 2).toUpperCase()
  const dbFiles = db
    .prepare('SELECT path, size, mtime, ino, thumb FROM files WHERE volume_id = ? AND trashed_at IS NULL')
    .all(currentVolId) as Pick<ScannedFile, 'path' | 'size' | 'mtime' | 'ino' | 'thumb'>[]

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
      removeFileRecord(path, currentVolId)
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

  const totalCount = getFileCount(currentVolId)
  if (onProgress) onProgress(totalCount)
  return { fullScanNeeded: false, count: totalCount, volumeId: currentVolId }
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


/**
 * Scan utility processes currently running, by drive.
 *
 * A first scan of a large external drive is minutes long. Without a handle on
 * it there was no way to stop one: switching drives, or deciding the scan was a
 * mistake, left it walking the volume (and writing rows) with the UI offering
 * nothing but "wait".
 */
const liveScanProcesses = new Map<string, { kill: () => void }>()

/** Stops an in-flight scan of this drive. Rows already committed are kept -
 *  they are real files that were really found. Returns whether one was running. */
export function cancelScanUtilityProcess(drivePath: string): boolean {
  const child = liveScanProcesses.get(drivePath)
  if (!child) return false
  liveScanProcesses.delete(drivePath)
  try {
    child.kill()
  } catch {
    /* already gone */
  }
  return true
}

export function spawnScanUtilityProcess(
  drivePath: string,
  scanPath: string,
  volumeId: string | null,
  onProgress: (count: number) => void,
  onElevationStatus?: (status: { isElevated: boolean; message: string }) => void
): Promise<number> {
  return new Promise((resolve, reject) => {
    const utilityScript = join(__dirname, 'scanUtility.js')
    console.log(`[spawnScanUtilityProcess] Spawning Electron utilityProcess for ${drivePath} (script: ${utilityScript}, volume: ${volumeId ?? 'unresolved'})`)

    const child = utilityProcess.fork(utilityScript, [drivePath, scanPath, dbPath, volumeId ?? ''])
    liveScanProcesses.set(drivePath, { kill: () => child.kill() })
    let finalCount = 0
    let settled = false

    // The child was previously left running after it reported 'complete', and
    // was never killed on error either - so a scan that failed or was
    // superseded stayed resident holding its own SQLite connection. Each
    // subsequent scan added another.
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      liveScanProcesses.delete(drivePath)
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

/**
 * Per-drive availability, so the UI can say why a record does not resolve.
 *
 * A path that fails to resolve because its volume is not plugged in is not the
 * same thing as a path that fails on a volume which IS plugged in, and the app
 * previously showed both as the same blank tile. The first is recoverable by
 * connecting the drive; only the second says anything about the file.
 *
 * `volumeMatches` is null when no record for that letter carries a volume id -
 * historical rows are deliberately left NULL, so the honest answer is "not
 * known", never "yes, because the letter is the same".
 */
export interface DriveAvailability {
  drive: string
  rows: number
  mounted: boolean
  currentVolumeId: string | null
  recordedVolumeIds: string[]
  volumeMatches: boolean | null
}

export async function getDriveAvailability(): Promise<DriveAvailability[]> {
  const counts = db
    .prepare(
      "SELECT drive, COUNT(*) n FROM files WHERE trashed_at IS NULL AND drive IS NOT NULL AND drive != '' GROUP BY drive"
    )
    .all() as { drive: string; n: number }[]

  const out: DriveAvailability[] = []
  for (const c of counts) {
    if (c.drive === SAMPLE_DRIVE_KEY) continue
    let mounted = false
    try {
      fs.statSync(c.drive + '\\')
      mounted = true
    } catch {
      mounted = false
    }
    const recorded = (
      db
        .prepare(
          "SELECT DISTINCT volume_id FROM files WHERE drive = ? AND volume_id IS NOT NULL AND volume_id != ''"
        )
        .all(c.drive) as { volume_id: string }[]
    ).map((r) => r.volume_id)

    const currentVolumeId = mounted ? await getVolumeId(c.drive) : null
    const volumeMatches =
      recorded.length === 0 || !currentVolumeId ? null : recorded.includes(currentVolumeId)

    out.push({
      drive: c.drive,
      rows: c.n,
      mounted,
      currentVolumeId,
      recordedVolumeIds: recorded,
      volumeMatches
    })
  }
  return out
}

/** True when no volume is mounted at that letter at all. */
export function isDriveMounted(drive: string): boolean {
  try {
    fs.statSync(drive.slice(0, 2).toUpperCase() + '\\')
    return true
  } catch {
    return false
  }
}

/**
 * Cached letter -> volume id, so availability can be decided synchronously.
 *
 * Reading the real volume id shells out to PowerShell, which is far too slow
 * to do per file. This is refreshed when drives change and consulted by
 * everything that resolves a path.
 */
const volumeByLetter = new Map<string, string | null>()

/**
 * Refreshes the letter -> volume id cache.
 *
 * Covers every previously-indexed drive plus `extraLetters` - the currently
 * mounted letters, so a drive that has never been indexed (a brand new
 * pendrive) still gets its live identity cached before the user can click it,
 * rather than only after its first scan.
 */
export async function refreshVolumeCache(extraLetters: string[] = []): Promise<void> {
  const letters = new Set<string>(getAllKnownDrives().map((d) => d.slice(0, 2).toUpperCase()))
  for (const l of extraLetters) letters.add(l.slice(0, 2).toUpperCase())
  for (const l of letters) {
    if (!/^[A-Z]:$/.test(l)) continue
    volumeByLetter.set(l, isDriveMounted(l) ? await getVolumeId(l) : null)
  }
}

export function getCachedVolumeId(letter: string): string | null {
  return volumeByLetter.get(letter.slice(0, 2).toUpperCase()) ?? null
}

/**
 * Whether this letter has ever been resolved, so a caller can tell "checked,
 * unresolved" (cached as null - trust it) apart from "never looked at" (not
 * in the map at all - a live check is the only honest answer). `sendDrives`
 * primes every currently mounted letter before the renderer can see it in the
 * drive list, so in practice this is warm by the time a real click reaches
 * open-drive; only a letter no `drives-updated` tick has covered yet falls
 * through to a live PowerShell call.
 */
export function hasCachedVolumeId(letter: string): boolean {
  return volumeByLetter.has(letter.slice(0, 2).toUpperCase())
}

/** Sets one letter's cached identity immediately, from an already-resolved read. */
export function primeVolumeCache(letter: string, volumeId: string | null): void {
  volumeByLetter.set(letter.slice(0, 2).toUpperCase(), volumeId)
}

/**
 * Brings a volume's records onto its current letter when Windows has moved
 * it - "same volume, new letter" rather than a different device that happens
 * to share the old one.
 *
 * Gated entirely on a verified `volumeId` match, never on the letter alone:
 * this only ever touches rows the caller has already confirmed belong to the
 * volume now mounted at `newLetter`. Rows under any other volume, including
 * legacy rows with no recorded identity, are untouched.
 */
export function reconcileDriveLetterForVolume(volumeId: string, newLetter: string): void {
  const letter = newLetter.slice(0, 2).toUpperCase()
  const oldLetters = (
    db
      .prepare('SELECT DISTINCT drive FROM files WHERE volume_id = ? AND drive IS NOT NULL AND drive != ?')
      .all(volumeId, letter) as { drive: string }[]
  )
    .map((r) => r.drive)
    .filter((d) => /^[A-Z]:$/.test(d))

  if (oldLetters.length === 0) {
    saveVolumeDrive(volumeId, letter)
    return
  }

  // Scoped by volume_id as well as path: two different volumes can now share
  // a literal path (see the files-table migration note), and a bare path
  // WHERE would move both of them, not only the one actually being
  // reconciled here.
  const updateFile = db.prepare('UPDATE files SET drive = ?, path = ? WHERE path = ? AND volume_id = ?')
  // No OR REPLACE: a destination collision here must fail loudly (caught
  // below) rather than silently deleting whatever other file was favourited
  // at that path.
  const updateFav = db.prepare('UPDATE favourite_paths SET path = ? WHERE path = ? AND volume_id IS ?')
  let moved = 0
  let collided = 0
  db.transaction(() => {
    for (const old of oldLetters) {
      const rows = db
        .prepare('SELECT path FROM files WHERE volume_id = ? AND drive = ?')
        .all(volumeId, old) as { path: string }[]
      for (const { path } of rows) {
        const newPath = letter + path.slice(2)
        // Each row is its own failure unit - SQLite's default ABORT
        // resolution undoes only the statement that violated the UNIQUE
        // constraint on `path`, not the whole transaction, so one colliding
        // file (two volumes sharing a folder layout, e.g. DCIM\...\IMG_0001.JPG)
        // does not strand every other row on its old, now-wrong letter.
        try {
          updateFile.run(letter, newPath, path, volumeId)
        } catch (err) {
          collided++
          console.error(`[reconcile] ${path} -> ${newPath} collided, left on ${old}:`, err)
          continue
        }
        try {
          updateFav.run(newPath, path, volumeId)
        } catch (err) {
          console.error(`[reconcile] favourite at ${path} could not follow to ${newPath}:`, err)
        }
        moved++
      }
    }
    saveVolumeDrive(volumeId, letter)
  })()
  clearPathStateCache()
  console.log(
    `[reconcile] ${volumeId} moved from ${oldLetters.join(', ')} to ${letter}: ${moved} rows moved, ${collided} left in place`
  )
}

/**
 * Why a stored path did not open. Deliberately not collapsed into one
 * "missing": a disconnected drive, a moved folder, a permission refusal and a
 * genuinely deleted file each need a different answer from the user.
 */
export type PathStatus =
  | 'ok'
  | 'drive-offline'
  | 'volume-mismatch'
  | 'folder-missing'
  | 'no-access'
  | 'missing'

/**
 * Single answer to "can this record's file be used right now", shared by
 * thumbnails, the media protocol and file actions.
 *
 * The distinction that matters: a path that fails because its volume is not
 * connected, or because the letter now points at a DIFFERENT volume than the
 * record came from, says nothing about the file. Only a failure on the right,
 * mounted volume does. Treating those the same is what made unplugged and
 * relettered drives look like deleted files.
 *
 * A record with no recorded volume id is never claimed for whatever volume
 * happens to be mounted - it is reported honestly as unverified.
 */
/** Explicit relinks, cached because every tile asks. */
let mappingCache: FolderMapping[] | null = null

export function getFolderMappings(): FolderMapping[] {
  if (mappingCache) return mappingCache
  const rows = db
    .prepare('SELECT from_prefix, to_prefix FROM folder_mappings')
    .all() as { from_prefix: string; to_prefix: string }[]
  mappingCache = rows.map((r) => ({ from: r.from_prefix, to: r.to_prefix }))
  return mappingCache
}

function invalidateMappings(): void {
  mappingCache = null
}

/**
 * The path a stored row lives at today.
 *
 * Everything that touches a file on disk - thumbnails, the media protocol,
 * playback, reveal - goes through this, so they cannot disagree about where a
 * relinked file is.
 */
export function resolveStoredPath(storedPath: string): string {
  const maps = getFolderMappings()
  if (maps.length === 0) return storedPath
  return applyMappings(storedPath, maps)
}

/** Cheap memo so classifying a screenful of rows is a handful of stat calls. */
const dirExistsCache = new Map<string, boolean>()
let dirCacheStamp = 0
function dirExists(p: string): boolean {
  const now = Date.now()
  // Short-lived: a drive that comes back, or a folder the user just relinked,
  // must not stay "missing" because of a cached answer.
  if (now - dirCacheStamp > 5000) {
    dirExistsCache.clear()
    dirCacheStamp = now
  }
  const key = p.toLowerCase()
  const hit = dirExistsCache.get(key)
  if (hit !== undefined) return hit
  let ok = false
  try {
    ok = fs.existsSync(p)
  } catch {
    ok = false
  }
  dirExistsCache.set(key, ok)
  return ok
}

/** Forget cached existence answers, e.g. after a reconnect or a relink. */
export function clearPathStateCache(): void {
  dirExistsCache.clear()
  dirCacheStamp = 0
}

export function checkPathAvailability(
  filePath: string,
  recordedVolumeId?: string | null
): {
  status: PathStatus
  volumeKnown: boolean
  /** Where the file was looked for, after any relink. */
  resolved: string
  /** For 'folder-missing', the folder the user would be asked to locate. */
  missingRoot?: string
} {
  const letter = filePath.slice(0, 2).toUpperCase()
  const isLetterPath = /^[A-Z]:$/.test(letter)
  const recorded =
    recordedVolumeId !== undefined
      ? recordedVolumeId
      : ((
          db.prepare('SELECT volume_id FROM files WHERE path = ?').get(filePath) as
            | { volume_id: string | null }
            | undefined
        )?.volume_id ?? null)

  const resolved = resolveStoredPath(filePath)

  if (isLetterPath && !isDriveMounted(letter)) {
    return { status: 'drive-offline', volumeKnown: !!recorded, resolved }
  }
  if (recorded) {
    const current = getCachedVolumeId(letter)
    if (current && current !== recorded) {
      return { status: 'volume-mismatch', volumeKnown: true, resolved }
    }
  }

  // Separate "cannot read it" from "it is not there": a permission problem on
  // a file that exists is not a missing file, and saying so sends the user
  // looking for the wrong thing.
  try {
    fs.accessSync(resolved, fs.constants.R_OK)
    // A path that resolves but never had a recorded identity is not proof of
    // anything - a legacy row and an unrelated file on a different, currently
    // mounted device can share the exact same path (camera folders reuse
    // names like DCIM\100APPLE\IMG_0001.JPG constantly). Treated the same as
    // a confirmed mismatch: recoverable, never served or deleted as if it
    // were verified.
    if (!recorded && isLetterPath && isDriveMounted(letter)) {
      return { status: 'volume-mismatch', volumeKnown: false, resolved }
    }
    return { status: 'ok', volumeKnown: !!recorded, resolved }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') {
      return { status: 'no-access', volumeKnown: !!recorded, resolved }
    }
  }

  const root = missingRootOf(resolved, dirExists)
  if (root) {
    return {
      status: 'folder-missing',
      volumeKnown: !!recorded,
      resolved,
      missingRoot: root.missingRoot
    }
  }
  return { status: 'missing', volumeKnown: !!recorded, resolved }
}

/**
 * Folders the index expects that are not on the drive, with how many files
 * each accounts for.
 *
 * Grouped by the folder rather than listed per file, because one answer from
 * the user fixes thousands of rows. Reads only the index and one existence
 * check per distinct folder.
 */
export function listUnresolvedRoots(
  volumeId: string | null
): { root: string; count: number; sample: string }[] {
  if (!volumeId) return []
  const rows = db
    .prepare(
      'SELECT path FROM files WHERE volume_id = ? AND hidden = 0 AND trashed_at IS NULL LIMIT 250000'
    )
    .all(volumeId) as { path: string }[]

  const byRoot = new Map<string, { count: number; sample: string }>()
  for (const r of rows) {
    const resolved = resolveStoredPath(r.path)
    // Only the first absent component matters; dirExists memoises so this is
    // a few stat calls per distinct folder, not one per file.
    const root = missingRootOf(resolved, dirExists)
    if (!root) continue
    const cur = byRoot.get(root.missingRoot)
    if (cur) cur.count++
    else byRoot.set(root.missingRoot, { count: 1, sample: r.path })
  }
  return [...byRoot.entries()]
    .map(([root, v]) => ({ root, count: v.count, sample: v.sample }))
    .sort((a, b) => b.count - a.count)
}

/**
 * Records a relink the user chose, once the files actually under it agree.
 *
 * The folder is always the user's pick. This only refuses one that clearly is
 * not the same folder, so a stray selection cannot silently redirect thousands
 * of rows at unrelated files.
 */
export function saveFolderMapping(
  fromPrefix: string,
  toPrefix: string
): { saved: boolean; checked: number; found: number; sizeMatches: number; reason?: string } {
  const from = normalisePrefix(fromPrefix)
  const to = normalisePrefix(toPrefix)
  if (!from || !to) return { saved: false, checked: 0, found: 0, sizeMatches: 0, reason: 'empty path' }
  if (from.toLowerCase() === to.toLowerCase()) {
    return { saved: false, checked: 0, found: 0, sizeMatches: 0, reason: 'same folder' }
  }

  const samples = db
    .prepare(
      'SELECT path, size FROM files WHERE path LIKE ? AND hidden = 0 AND trashed_at IS NULL LIMIT 40'
    )
    .all(from + '\\%') as { path: string; size: number }[]

  const score = scoreMapping(
    samples.map((r) => ({ storedPath: r.path, size: r.size })),
    { from, to },
    (p) => {
      try {
        const st = fs.statSync(p)
        return { size: st.size }
      } catch {
        return null
      }
    }
  )

  if (score.checked === 0) {
    return { saved: false, ...score, reason: 'no indexed files under that folder' }
  }
  // At least half of a sample must be present at the new location. A genuine
  // move matches nearly everything; an unrelated folder matches almost none.
  if (score.ratio < 0.5) {
    return {
      saved: false,
      ...score,
      reason: `only ${score.found} of ${score.checked} sampled files were found there`
    }
  }

  db.prepare(
    'INSERT OR REPLACE INTO folder_mappings (from_prefix, to_prefix, drive, volume_id, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(from, to, from.slice(0, 2).toUpperCase(), getCachedVolumeId(from.slice(0, 2).toUpperCase()), new Date().toISOString())
  invalidateMappings()
  clearPathStateCache()
  return { saved: true, ...score }
}

/** Drops a relink, e.g. if the user pointed it at the wrong folder. */
export function removeFolderMapping(fromPrefix: string): void {
  db.prepare('DELETE FROM folder_mappings WHERE from_prefix = ?').run(normalisePrefix(fromPrefix))
  invalidateMappings()
  clearPathStateCache()
}

