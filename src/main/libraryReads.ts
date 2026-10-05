/**
 * Summary, page and map reads for one database connection, with the expensive
 * part done once per catalogue version.
 *
 * A page used to be `ORDER BY <group key>, <compact flag>, date, path LIMIT 200
 * OFFSET n`, which no index can serve, so every page re-sorted the whole volume:
 * 86-231ms each on a 41,000-file drive, ~7 pages per scroll arrival, all on the
 * main thread. Here the ordering is computed once as row ids for (query,
 * version) and each page is a lookup of 200 ids. The version is the database's
 * own epoch (see the catalogue_epoch triggers in scanner.ts), so a cached
 * ordering can never outlive a change to what it orders.
 *
 * Connection-agnostic (anything with prepare().all/get), so it runs in the
 * library worker, as the main-thread fallback, and under node:test. The caller
 * runs each call inside one read transaction, so the version and the rows come
 * from the same snapshot.
 */
import {
  summarySql,
  orderedSql,
  groupOffsets,
  dependsOnFavourites,
  PAGE_COLUMNS,
  mapClustersSql,
  clusterThumbsSql,
  clusterCellSize,
  MAX_CLUSTERS,
  type LibraryQuery
} from './libraryQuery.ts'

/**
 * The epoch the cached orderings are checked against: moved by the database
 * itself on every change to which rows a query returns or their order, from
 * any connection, and not by thumbnail or failure bookkeeping. Favourites are
 * deliberately left out (see dependsOnFavourites). Applied by scanner.ts after
 * any rebuild of the files table, which would drop the triggers with it.
 */
export const EPOCH_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS catalogue_epoch (n INTEGER NOT NULL);
  INSERT INTO catalogue_epoch (n) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM catalogue_epoch);
  CREATE TRIGGER IF NOT EXISTS files_epoch_insert AFTER INSERT ON files
    BEGIN UPDATE catalogue_epoch SET n = n + 1; END;
  CREATE TRIGGER IF NOT EXISTS files_epoch_delete AFTER DELETE ON files
    BEGIN UPDATE catalogue_epoch SET n = n + 1; END;
  CREATE TRIGGER IF NOT EXISTS files_epoch_update
    AFTER UPDATE OF volume_id, drive, path, name, ext, date, month, year, lat, lng, hidden, trashed_at ON files
    BEGIN UPDATE catalogue_epoch SET n = n + 1; END;
`

export interface ReadDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown }
}

export interface LibrarySummary {
  total: number
  groups: { key: string; count: number; compactCount: number; minDate: string; maxDate: string; offset: number }[]
  version: string
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

/** Orderings and summaries kept per connection; a handful of queries is all
 *  one gallery switches between. */
const MAX_CACHED = 4

const queryKey = (q: LibraryQuery): string =>
  JSON.stringify([q.drive, q.volumeId, q.nav, q.search, q.groupBy, q.order, q.bbox ?? null])

export class LibraryReads {
  private orderings = new Map<string, { version: string; ids: number[] }>()
  private summaries = new Map<string, { version: string; value: LibrarySummary }>()

  private db: ReadDb

  constructor(db: ReadDb) {
    this.db = db
  }

  version(): string {
    const row = this.db.prepare('SELECT n FROM catalogue_epoch').get() as { n: number } | undefined
    return String(row?.n ?? 0)
  }

  summary(q: LibraryQuery): LibrarySummary {
    const version = this.version()
    const key = queryKey(q)
    const hit = this.summaries.get(key)
    if (hit && hit.version === version && !dependsOnFavourites(q)) return hit.value
    const s = summarySql(q)
    const rows = this.db.prepare(s.sql).all(...s.params) as {
      gkey: string
      n: number
      n_compact: number
      min_date: string
      max_date: string
    }[]
    const offsets = groupOffsets(rows)
    let total = 0
    for (const r of rows) total += r.n
    const value: LibrarySummary = {
      total,
      groups: rows.map((r) => ({
        key: r.gkey,
        count: r.n,
        compactCount: r.n_compact ?? 0,
        minDate: r.min_date,
        maxDate: r.max_date,
        offset: offsets.get(r.gkey) ?? 0
      })),
      version
    }
    remember(this.summaries, key, { version, value })
    return value
  }

  page(q: LibraryQuery, offset: number, limit: number): { rows: Record<string, unknown>[]; version: string } {
    const version = this.version()
    if (dependsOnFavourites(q)) {
      const o = orderedSql(q)
      return { rows: this.db.prepare(o.sql + ' LIMIT ? OFFSET ?').all(...o.params, limit, offset) as Record<string, unknown>[], version }
    }
    const key = queryKey(q)
    let ordering = this.orderings.get(key)
    if (!ordering || ordering.version !== version) {
      const o = orderedSql(q, 'id')
      const ids = (this.db.prepare(o.sql).all(...o.params) as { id: number }[]).map((r) => r.id)
      ordering = { version, ids }
      remember(this.orderings, key, ordering)
    }
    const slice = ordering.ids.slice(offset, offset + limit)
    if (slice.length === 0) return { rows: [], version }
    const found = this.db
      .prepare(`SELECT id, ${PAGE_COLUMNS} FROM files WHERE id IN (${slice.map(() => '?').join(',')})`)
      .all(...slice) as ({ id: number } & Record<string, unknown>)[]
    const byId = new Map(found.map((r) => [r.id, r]))
    const rows: Record<string, unknown>[] = []
    for (const id of slice) {
      const r = byId.get(id)
      if (!r) continue
      const { id: _id, ...row } = r
      rows.push(row)
    }
    return { rows, version }
  }

  /** Paths on a volume still owed a thumbnail, newest first - the background
   *  thumbnail tier's next batch. Rows that have used up their attempts are
   *  left out, so a pass never re-fails the same undecodable files. */
  owedThumbnails(volumeId: string, exts: string[], maxAttempts: number, limit: number): string[] {
    const ph = exts.map(() => '?').join(',')
    return (
      this.db
        .prepare(
          `SELECT path FROM files
           WHERE (thumb IS NULL OR thumb = '' OR thumb = 'NO_FILE') AND trashed_at IS NULL
             AND ext IN (${ph}) AND volume_id = ? AND IFNULL(thumb_fail_count, 0) < ?
           ORDER BY date DESC LIMIT ?`
        )
        .all(...exts, volumeId, maxAttempts, limit) as { path: string }[]
    ).map((r) => r.path)
  }

  /** Catalogued files per folder for one volume (one sample path each) - a few
   *  hundred groups instead of every row, for the missing-folder check. */
  folders(volumeId: string): { folder: string; count: number; sample: string }[] {
    const byFolder = new Map<string, { folder: string; count: number; sample: string }>()
    for (const { path } of this.db
      .prepare('SELECT path FROM files WHERE volume_id = ? AND hidden = 0 AND trashed_at IS NULL LIMIT 250000')
      .all(volumeId) as { path: string }[]) {
      const folder = path.slice(0, path.lastIndexOf('\\'))
      const g = byFolder.get(folder)
      if (g) g.count++
      else byFolder.set(folder, { folder, count: 1, sample: path })
    }
    return [...byFolder.values()]
  }

  clusters(q: LibraryQuery, zoom: number): MapCluster[] {
    const cell = clusterCellSize(zoom)
    const c = mapClustersSql(q, cell)
    const cells = this.db.prepare(c.sql).all(...c.params, MAX_CLUSTERS) as {
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
    const reps = this.db.prepare(t.sql).all(...t.params) as { cy: number; cx: number; thumb: string | null; path: string | null }[]
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
}

/** Insert as most recent, dropping the least recently stored beyond MAX_CACHED. */
function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_CACHED) map.delete(map.keys().next().value as string)
}
