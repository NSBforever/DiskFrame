/**
 * SQL for browsing the library without loading it.
 *
 * The renderer used to receive every row for a drive (~17MB for 40k files),
 * then filter, group and sort them in JavaScript on every change. That put the
 * whole index in the renderer heap and made a single favourite toggle re-sort
 * the library. Filtering, grouping, ordering and counting now happen in SQLite,
 * and the renderer asks for one bounded page at a time.
 *
 * Builders are pure and take no database handle, so they can be tested directly.
 */

export type NavFilter =
  | 'all'
  | 'photos'
  | 'videos'
  | 'docs'
  | 'screenshots'
  | 'places'
  | 'favourites'
export type GroupBy = 'day' | 'month' | 'year' | 'location' | 'favorites'
export type SortOrder = 'default' | 'reverse'

export interface MapBounds {
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
}

export interface LibraryQuery {
  drive: string
  nav: NavFilter
  search: string
  groupBy: GroupBy
  order: SortOrder
  /**
   * Restricts the query to one geographic box. Opening a place on the map is
   * then just an ordinary library query, so it gets the existing grouping,
   * ordering and pagination for free instead of a parallel code path.
   */
  bbox?: MapBounds | null
}

export const PHOTO_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.heic']
export const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.m4v', '.webm']
export const DOC_EXTS = ['.pdf', '.docx', '.doc', '.txt', '.xlsx', '.pptx', '.csv']

function inList(column: string, values: string[]): { sql: string; params: string[] } {
  return { sql: `${column} IN (${values.map(() => '?').join(',')})`, params: values }
}

/**
 * Extensions with no visual preview. The grid packs four of these into the
 * space of one normal tile, because a screen of identical generic icons at
 * full size is a screen that shows almost nothing.
 *
 * This is classified by extension, never by whether a thumbnail happens to be
 * present: a photo whose thumbnail is still generating, or whose drive is
 * disconnected, is still a photo and keeps its full tile.
 */
export const COMPACT_EXTS = DOC_EXTS

// These are module constants, never user input, so they are written into the
// SQL rather than bound - the alternative is threading four more positional
// parameters through every builder in a specific order. Asserted at load so a
// future edit cannot smuggle anything else in.
const COMPACT_EXT_LIST = (() => {
  for (const e of COMPACT_EXTS) {
    if (!/^\.[a-z0-9]{1,8}$/.test(e)) throw new Error(`unsafe compact extension: ${e}`)
  }
  return COMPACT_EXTS.map((e) => `'${e}'`).join(',')
})()

/** 1 for a file the grid draws compactly, 0 otherwise. */
export function compactExpr(): string {
  return `(CASE WHEN ext IN (${COMPACT_EXT_LIST}) THEN 1 ELSE 0 END)`
}

/**
 * WHERE clause for a query, as SQL plus positional parameters.
 * Every value is bound, never interpolated.
 */
export function buildWhere(q: LibraryQuery): { sql: string; params: unknown[] } {
  const clauses: string[] = ['drive = ?', 'hidden = 0', 'trashed_at IS NULL']
  const params: unknown[] = [q.drive]

  switch (q.nav) {
    case 'photos': {
      const p = inList('ext', PHOTO_EXTS)
      clauses.push(p.sql)
      params.push(...p.params)
      break
    }
    case 'videos': {
      const p = inList('ext', VIDEO_EXTS)
      clauses.push(p.sql)
      params.push(...p.params)
      break
    }
    case 'docs': {
      const p = inList('ext', DOC_EXTS)
      clauses.push(p.sql)
      params.push(...p.params)
      break
    }
    case 'screenshots':
      clauses.push("(instr(lower(path), 'screenshot') > 0 OR instr(lower(path), 'screen shot') > 0)")
      break
    case 'places':
      clauses.push('lat IS NOT NULL AND lng IS NOT NULL')
      break
    case 'favourites':
      clauses.push('favourited = 1')
      break
  }

  const raw = q.search.trim().toLowerCase()
  if (raw) {
    if (raw === 'is:fav' || raw === 'fav:true') {
      clauses.push('favourited = 1')
    } else if (raw.startsWith('ext:')) {
      const e = raw.slice(4).trim()
      clauses.push('ext = ?')
      params.push(e.startsWith('.') ? e : '.' + e)
    } else if (raw.startsWith('date:')) {
      const d = raw.slice(5).trim()
      clauses.push('(instr(lower(date), ?) > 0 OR instr(lower(month), ?) > 0 OR year = ?)')
      params.push(d, d, d)
    } else if (raw.startsWith('camera:') || raw.startsWith('loc:')) {
      const term = raw.slice(raw.indexOf(':') + 1).trim()
      clauses.push('instr(lower(path), ?) > 0')
      params.push(term)
    } else {
      clauses.push('(instr(lower(name), ?) > 0 OR instr(lower(path), ?) > 0)')
      params.push(raw, raw)
    }
  }

  if (q.bbox) {
    const b = q.bbox
    clauses.push('lat IS NOT NULL AND lng IS NOT NULL AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?')
    params.push(
      Math.min(b.minLat, b.maxLat),
      Math.max(b.minLat, b.maxLat),
      Math.min(b.minLng, b.maxLng),
      Math.max(b.minLng, b.maxLng)
    )
  }

  return { sql: clauses.join(' AND '), params }
}

/**
 * SQL expression producing a group key. Day/month/year slice the ISO date so
 * the key sorts identically to the date itself; the renderer turns the key
 * into a human label so locale formatting stays out of SQL.
 */
export function groupKeyExpr(groupBy: GroupBy): string {
  switch (groupBy) {
    case 'day':
      return "substr(date, 1, 10)"
    case 'month':
      return "substr(date, 1, 7)"
    case 'year':
      return "substr(date, 1, 4)"
    case 'location':
      return "CASE WHEN lat IS NULL OR lng IS NULL THEN 'none' ELSE (CAST(ROUND(lat * 2) / 2 AS TEXT) || ',' || CAST(ROUND(lng * 2) / 2 AS TEXT)) END"
    case 'favorites':
      return "CASE WHEN favourited = 1 THEN 'fav' ELSE 'other' END"
  }
}

/**
 * Row ordering. `date` alone is not unique, so equal dates could be returned in
 * different orders by different page queries, which makes a paginated read skip
 * or repeat files at page boundaries. `path` is UNIQUE, so it is a total
 * tie-break and pagination is stable.
 */
export function orderExpr(order: SortOrder): string {
  return order === 'reverse' ? 'date ASC, path ASC' : 'date DESC, path ASC'
}

/** Groups ordered consistently with the rows inside them. */
export function summarySql(q: LibraryQuery): { sql: string; params: unknown[] } {
  const where = buildWhere(q)
  const key = groupKeyExpr(q.groupBy)
  const dir = q.order === 'reverse' ? 'ASC' : 'DESC'
  return {
    sql: `SELECT ${key} AS gkey, COUNT(*) AS n,
                 SUM(${compactExpr()}) AS n_compact,
                 MIN(date) AS min_date, MAX(date) AS max_date
          FROM files WHERE ${where.sql}
          GROUP BY gkey
          ORDER BY ${q.order === 'reverse' ? 'MIN(date)' : 'MAX(date)'} ${dir}, gkey ${dir}`,
    params: where.params
  }
}

export const PAGE_COLUMNS =
  'path, name, ext, size, date, year, month, lat, lng, drive, favourited, thumb'

/**
 * Whether the group key is a prefix of `date`.
 *
 * For day, month and year it is, so ordering rows by date already clusters
 * them into their groups in the same order the summary lists them, and the
 * covering index on (drive, hidden, trashed_at, date DESC, path ASC) can
 * serve the page directly. Location and Favourites keys have nothing to do
 * with date, so they need explicit group ordering.
 */
export function groupIsDateDerived(groupBy: GroupBy): boolean {
  return groupBy === 'day' || groupBy === 'month' || groupBy === 'year'
}

/**
 * One bounded window of rows, in the same order the summary implies.
 *
 * The summary orders GROUPS by MAX(date) (or MIN when reversed); rows were
 * ordered by date alone. For a date-derived key those agree. For Location and
 * Favourites they do not: rows from different groups interleave by date, while
 * groupOffsets() assumes the rows are laid out group after group. The headings
 * were right and the files under them were whatever happened to sit at that
 * offset. Ranking rows by the same aggregate the summary uses makes the two
 * agree by construction.
 */
export function pageSql(q: LibraryQuery): { sql: string; params: unknown[] } {
  const where = buildWhere(q)
  const rowOrder = orderExpr(q.order)
  const key = groupKeyExpr(q.groupBy)
  const dir = q.order === 'reverse' ? 'ASC' : 'DESC'

  // Files that get a compact cell are placed after the previewable ones inside
  // their own group. The grid needs that: it reserves one cell per previewable
  // file and one per four compact files, so a page has to hand it back in that
  // arrangement for cell N to mean the same rows on both sides. Grouping is
  // unaffected - nothing crosses a group boundary.
  if (groupIsDateDerived(q.groupBy)) {
    return {
      sql: `SELECT ${PAGE_COLUMNS} FROM files WHERE ${where.sql}
          ORDER BY ${key} ${dir}, ${compactExpr()} ASC, ${rowOrder} LIMIT ? OFFSET ?`,
      params: where.params
    }
  }

  const agg = q.order === 'reverse' ? 'MIN' : 'MAX'
  return {
    sql: `SELECT ${PAGE_COLUMNS} FROM (
            SELECT ${PAGE_COLUMNS},
                   ${key} AS gkey,
                   ${compactExpr()} AS is_compact,
                   ${agg}(date) OVER (PARTITION BY ${key}) AS gsort
            FROM files WHERE ${where.sql}
          )
          ORDER BY gsort ${dir}, gkey ${dir}, is_compact ASC, ${rowOrder} LIMIT ? OFFSET ?`,
    params: where.params
  }
}

export function countSql(q: LibraryQuery): { sql: string; params: unknown[] } {
  const where = buildWhere(q)
  return { sql: `SELECT COUNT(*) AS n FROM files WHERE ${where.sql}`, params: where.params }
}

/**
 * Offset of the first row of a group, derived from the summary. Lets the
 * timeline scrubber jump straight to a date without reading the rows in
 * between.
 */
export function groupOffsets(groups: { gkey: string; n: number }[]): Map<string, number> {
  const offsets = new Map<string, number>()
  let running = 0
  for (const g of groups) {
    offsets.set(g.gkey, running)
    running += g.n
  }
  return offsets
}


/**
 * Width of one cluster cell, in degrees, for a map zoom level.
 *
 * Web Mercator puts 360 degrees of longitude across 256 * 2^zoom pixels, so
 * this is the degree span of a roughly 70px square. Clustering on that grid
 * keeps the number of markers proportional to the size of the viewport rather
 * than to the size of the library: zooming in splits cells, zooming out merges
 * them, and neither ever asks for a marker per file.
 */
export function clusterCellSize(zoom: number): number {
  const z = Math.max(0, Math.min(22, Number.isFinite(zoom) ? zoom : 2))
  return Math.max(0.00005, (360 / (256 * Math.pow(2, z))) * 70)
}

/** Ceiling on markers returned for one viewport, whatever the zoom. */
export const MAX_CLUSTERS = 120

/**
 * Counts and bounds per cluster cell inside the visible box.
 *
 * Rows with no coordinates are excluded here rather than plotted at (0, 0):
 * the map must never invent a location for a file that does not have one.
 */
export function mapClustersSql(
  q: LibraryQuery,
  cell: number
): { sql: string; params: unknown[] } {
  const where = buildWhere(q)
  return {
    sql: `SELECT CAST(lat / ? AS INTEGER) AS cy,
                 CAST(lng / ? AS INTEGER) AS cx,
                 COUNT(*) AS n,
                 AVG(lat) AS lat, AVG(lng) AS lng,
                 MIN(lat) AS min_lat, MAX(lat) AS max_lat,
                 MIN(lng) AS min_lng, MAX(lng) AS max_lng,
                 MAX(date) AS max_date
          FROM files
          WHERE ${where.sql} AND lat IS NOT NULL AND lng IS NOT NULL
          GROUP BY cy, cx
          ORDER BY n DESC
          LIMIT ?`,
    // The two cell parameters bind first because they appear first in the SQL.
    params: [cell, cell, ...where.params]
  }
}

/**
 * One representative row per cluster cell: the newest file that actually has a
 * thumbnail, so a cluster shows a picture rather than a blank square whenever
 * any of its files can supply one.
 */
export function clusterThumbsSql(
  q: LibraryQuery,
  cell: number
): { sql: string; params: unknown[] } {
  const where = buildWhere(q)
  return {
    sql: `SELECT cy, cx, thumb, path, ext FROM (
            SELECT CAST(lat / ? AS INTEGER) AS cy,
                   CAST(lng / ? AS INTEGER) AS cx,
                   thumb, path, ext,
                   ROW_NUMBER() OVER (
                     PARTITION BY CAST(lat / ? AS INTEGER), CAST(lng / ? AS INTEGER)
                     ORDER BY (thumb IS NULL) ASC, date DESC, path ASC
                   ) AS rn
            FROM files
            WHERE ${where.sql} AND lat IS NOT NULL AND lng IS NOT NULL
          ) WHERE rn = 1`,
    params: [cell, cell, cell, cell, ...where.params]
  }
}
