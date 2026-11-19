/**
 * Places, Trips and custom collections: the user's own groupings of files,
 * plus the suggestions local discovery (discovery.ts) makes for them.
 *
 * A member is a (volume_id, path) pair, the same identity as a `files` row, so
 * two volumes that share a literal path never stand in for each other. Rows
 * are never copied: everything shown is joined back to `files`, so a trashed
 * or hidden file drops out on its own and an offline drive's files stay
 * listed with whatever thumbnail they already had.
 *
 * Member states:
 *   auto     - put there by discovery; refreshed while the collection is a suggestion
 *   added    - put there by the user
 *   removed  - the user took an auto member out; kept so discovery does not put it back
 *
 * Pure SQL over the passed connection (better-sqlite3 in the app, node:sqlite
 * under `npm test`).
 */

export interface ColDb {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
}

export type CollectionKind = 'place' | 'trip' | 'custom'
export type CollectionStatus = 'suggested' | 'accepted' | 'dismissed'
export type Confidence = 'high' | 'medium' | 'low'
export interface FileRef {
  path: string
  volumeId: string
}

export const COLLECTIONS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('place', 'trip', 'custom')),
    status TEXT NOT NULL CHECK (status IN ('suggested', 'accepted', 'dismissed')),
    origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'auto', 'calendar')),
    name TEXT,
    note TEXT,
    signature TEXT UNIQUE,
    scope TEXT,
    confidence TEXT,
    lat REAL,
    lng REAL,
    radius_m REAL,
    start_ms INTEGER,
    end_ms INTEGER,
    cover_path TEXT,
    cover_volume_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_collections_scope ON collections (scope, origin);
  CREATE TABLE IF NOT EXISTS collection_files (
    collection_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    volume_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('auto', 'added', 'removed')),
    PRIMARY KEY (collection_id, path, volume_id)
  );
  CREATE INDEX IF NOT EXISTS idx_collection_files_file ON collection_files (volume_id, path);
`

/** Runs `fn` atomically. A savepoint rather than BEGIN, so it nests inside a caller's transaction. */
function atomically<T>(db: ColDb, fn: () => T): T {
  db.exec('SAVEPOINT collections_op')
  try {
    const r = fn()
    db.exec('RELEASE collections_op')
    return r
  } catch (e) {
    db.exec('ROLLBACK TO collections_op')
    db.exec('RELEASE collections_op')
    throw e
  }
}

const n = (v: number | bigint): number => Number(v)

// ── User actions ────────────────────────────────────────────────────────────

export function createCollection(
  db: ColDb,
  c: { kind: CollectionKind; name: string; note?: string | null; lat?: number | null; lng?: number | null },
  nowIso: string
): number {
  return n(
    db
      .prepare(
        `INSERT INTO collections (kind, status, origin, name, note, lat, lng, created_at, updated_at)
         VALUES (?, 'accepted', 'manual', ?, ?, ?, ?, ?, ?)`
      )
      .run(c.kind, cleanName(c.name), c.note ?? null, c.lat ?? null, c.lng ?? null, nowIso, nowIso).lastInsertRowid
  )
}

function cleanName(name: string | null | undefined): string | null {
  const s = (name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
  return s || null
}

export function updateCollection(
  db: ColDb,
  id: number,
  patch: {
    name?: string | null
    note?: string | null
    status?: CollectionStatus
    cover?: FileRef | null
    kind?: CollectionKind
    /** A user-given date range (epoch ms); null clears it. */
    startMs?: number | null
    endMs?: number | null
  },
  nowIso: string
): void {
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.name !== undefined) {
    sets.push('name = ?')
    params.push(cleanName(patch.name))
  }
  if (patch.note !== undefined) {
    sets.push('note = ?')
    params.push(patch.note === null ? null : String(patch.note).slice(0, 500))
  }
  if (patch.status !== undefined) {
    sets.push('status = ?')
    params.push(patch.status)
  }
  if (patch.kind !== undefined) {
    sets.push('kind = ?')
    params.push(patch.kind)
  }
  if (patch.startMs !== undefined || patch.endMs !== undefined) {
    const a = patch.startMs ?? null
    const b = patch.endMs ?? null
    sets.push('start_ms = ?', 'end_ms = ?')
    params.push(a !== null && b !== null ? Math.min(a, b) : a, a !== null && b !== null ? Math.max(a, b) : b)
  }
  if (patch.cover !== undefined) {
    sets.push('cover_path = ?', 'cover_volume_id = ?')
    params.push(patch.cover?.path ?? null, patch.cover?.volumeId ?? null)
  }
  if (!sets.length) return
  db.prepare(`UPDATE collections SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...params, nowIso, id)
}

/** Adds files as the user's own members; puts back any the user had removed. Returns how many changed. */
export function addFiles(db: ColDb, id: number, refs: FileRef[]): number {
  const st = db.prepare(
    `INSERT INTO collection_files (collection_id, path, volume_id, state) VALUES (?, ?, ?, 'added')
     ON CONFLICT (collection_id, path, volume_id) DO UPDATE SET state = 'added' WHERE state = 'removed'`
  )
  return atomically(db, () => refs.reduce((sum, r) => sum + n(st.run(id, r.path, r.volumeId).changes), 0))
}

/** Takes files out. A discovered member is remembered as removed so discovery does not put it back. */
export function removeFiles(db: ColDb, id: number, refs: FileRef[]): number {
  const tomb = db.prepare("UPDATE collection_files SET state = 'removed' WHERE collection_id = ? AND path = ? AND volume_id = ? AND state = 'auto'")
  const del = db.prepare("DELETE FROM collection_files WHERE collection_id = ? AND path = ? AND volume_id = ? AND state = 'added'")
  return atomically(db, () =>
    refs.reduce((sum, r) => sum + n(tomb.run(id, r.path, r.volumeId).changes) + n(del.run(id, r.path, r.volumeId).changes), 0)
  )
}

/** Moves every member of `fromId` into `intoId` and deletes `fromId`. Merging is a decision, so `intoId` becomes accepted. */
export function mergeCollections(db: ColDb, intoId: number, fromId: number, nowIso: string): void {
  if (intoId === fromId) return
  atomically(db, () => {
    const members = db
      .prepare("SELECT path, volume_id AS volumeId FROM collection_files WHERE collection_id = ? AND state != 'removed'")
      .all(fromId) as FileRef[]
    addFiles(db, intoId, members)
    deleteCollection(db, fromId)
    db.prepare("UPDATE collections SET status = 'accepted', updated_at = ? WHERE id = ? AND status = 'suggested'").run(nowIso, intoId)
  })
}

/** Moves `refs` out of `id` into a new accepted collection of the same kind. Returns the new id. */
export function splitCollection(db: ColDb, id: number, refs: FileRef[], name: string, nowIso: string): number {
  return atomically(db, () => {
    const src = db.prepare('SELECT kind FROM collections WHERE id = ?').get(id) as { kind: CollectionKind } | undefined
    if (!src) throw new Error('no such collection')
    const created = createCollection(db, { kind: src.kind, name }, nowIso)
    addFiles(db, created, refs)
    removeFiles(db, id, refs)
    return created
  })
}

/** A new collection and its first files, all or nothing. */
export function createCollectionWithFiles(
  db: ColDb,
  c: Parameters<typeof createCollection>[1],
  refs: FileRef[],
  nowIso: string
): number {
  return atomically(db, () => {
    const id = createCollection(db, c, nowIso)
    addFiles(db, id, refs)
    return id
  })
}

export function deleteCollection(db: ColDb, id: number): void {
  atomically(db, () => {
    db.prepare('DELETE FROM collection_files WHERE collection_id = ?').run(id)
    db.prepare('DELETE FROM collections WHERE id = ?').run(id)
  })
}

// ── Reads ───────────────────────────────────────────────────────────────────

export interface CollectionCard {
  id: number
  kind: CollectionKind
  status: CollectionStatus
  origin: 'manual' | 'auto' | 'calendar'
  name: string | null
  note: string | null
  confidence: Confidence | null
  scope: string | null
  lat: number | null
  lng: number | null
  radiusM: number | null
  startMs: number | null
  endMs: number | null
  /** Visible members (not hidden, not trashed), on any volume. */
  count: number
  minDate: string | null
  maxDate: string | null
  /** Volumes the visible members are on - each photo keeps its source drive. */
  volumes: string[]
  coverPath: string | null
  coverVolumeId: string | null
  coverThumb: string | null
  coverExt: string | null
}

const VISIBLE = 'f.hidden = 0 AND f.trashed_at IS NULL'

/**
 * Collections to show for the volumes in view: those with a visible member on
 * one of them, plus collections the user made that have no members yet (a
 * new, empty Place is still theirs to fill). Dismissed suggestions are left out.
 */
export function listCollections(db: ColDb, volumeIds: string[], opts: { crossDrive?: boolean } = {}): CollectionCard[] {
  const ph = volumeIds.map(() => '?').join(',') || 'NULL'
  // Suggestions from the discovery mode not in use stay stored (the user may
  // switch back) but are never joined: on a 200k-file library their members
  // were most of the listing's cost. Kept or user-made collections always show.
  const mode =
    opts.crossDrive === undefined
      ? ''
      : `AND NOT (c.origin = 'auto' AND c.status = 'suggested' AND (c.scope = '*') != ${opts.crossDrive ? 1 : 0})`
  const rows = db
    .prepare(
      `SELECT c.id, c.kind, c.status, c.origin, c.name, c.note, c.confidence, c.scope, c.lat, c.lng, c.radius_m,
              c.start_ms, c.end_ms, c.cover_path, c.cover_volume_id, c.updated_at,
              COUNT(f.id) AS n, MIN(f.date) AS min_date, MAX(f.date) AS max_date,
              group_concat(DISTINCT f.volume_id) AS vols,
              COUNT(cf.path) AS refs,
              SUM(f.volume_id IN (${ph})) AS in_scope
       FROM collections c
       LEFT JOIN collection_files cf ON cf.collection_id = c.id AND cf.state != 'removed'
       LEFT JOIN files f ON f.volume_id = cf.volume_id AND f.path = cf.path AND ${VISIBLE}
       WHERE c.status != 'dismissed' ${mode}
       GROUP BY c.id
       HAVING in_scope > 0 OR (refs = 0 AND c.origin != 'auto')
       ORDER BY COALESCE(MAX(f.date), c.updated_at) DESC, c.id DESC`
    )
    .all(...volumeIds) as Record<string, unknown>[]
  const chosenCover = db.prepare(`SELECT f.path, f.volume_id, f.thumb, f.ext FROM files f WHERE f.volume_id = ? AND f.path = ? AND ${VISIBLE}`)
  // A bounded sample, preferring one that already has a thumbnail: sorting
  // every member of a 30k-photo place for one picture was ~3 ms a card.
  const fallbackCover = db.prepare(
    `SELECT f.path, f.volume_id, f.thumb, f.ext
     FROM (SELECT path, volume_id FROM collection_files WHERE collection_id = ? AND state != 'removed' LIMIT 64) cf
     JOIN files f ON f.volume_id = cf.volume_id AND f.path = cf.path AND ${VISIBLE}
     ORDER BY (f.thumb IS NULL OR f.thumb IN ('', 'NO_FILE')), f.date DESC LIMIT 1`
  )
  return rows.map((r) => {
    type Cover = { path: string; volume_id: string; thumb: string | null; ext: string | null }
    const cover = ((r.cover_path ? chosenCover.get(r.cover_volume_id, r.cover_path) : undefined) ?? fallbackCover.get(r.id)) as
      | Cover
      | undefined
    return {
      id: r.id as number,
      kind: r.kind as CollectionKind,
      status: r.status as CollectionStatus,
      origin: r.origin as CollectionCard['origin'],
      name: (r.name as string) ?? null,
      note: (r.note as string) ?? null,
      confidence: (r.confidence as Confidence) ?? null,
      scope: (r.scope as string) ?? null,
      lat: (r.lat as number) ?? null,
      lng: (r.lng as number) ?? null,
      radiusM: (r.radius_m as number) ?? null,
      startMs: (r.start_ms as number) ?? null,
      endMs: (r.end_ms as number) ?? null,
      count: Number(r.n ?? 0),
      minDate: (r.min_date as string) ?? null,
      maxDate: (r.max_date as string) ?? null,
      volumes: r.vols ? String(r.vols).split(',').sort() : [],
      coverPath: cover?.path ?? null,
      coverVolumeId: cover?.volume_id ?? null,
      coverThumb: cover?.thumb ?? null,
      coverExt: cover?.ext ?? null
    }
  })
}

export const MEMBER_COLUMNS = 'f.path, f.name, f.ext, f.size, f.date, f.year, f.month, f.lat, f.lng, f.drive, f.favourited, f.thumb, f.volume_id'

export type MemberRow = Record<string, unknown> & { path: string; volume_id: string }

/** A collection's visible files, oldest first (a trip reads in order), as gallery rows. */
export function collectionFiles(db: ColDb, id: number, limit = 20000): MemberRow[] {
  return db
    .prepare(
      `SELECT ${MEMBER_COLUMNS} FROM collection_files cf
       JOIN files f ON f.volume_id = cf.volume_id AND f.path = cf.path AND ${VISIBLE}
       WHERE cf.collection_id = ? AND cf.state != 'removed'
       ORDER BY f.date ASC, f.path ASC, f.volume_id ASC LIMIT ?`
    )
    .all(id, limit) as MemberRow[]
}

// ── Discovery bookkeeping ───────────────────────────────────────────────────

export interface Discovered {
  kind: 'place' | 'trip'
  members: FileRef[]
  lat: number
  lng: number
  radiusM: number
  startMs: number
  endMs: number
  confidence: Confidence
}

/** Two groupings are "the same one" when at least half of the smaller is in the other. */
const SAME_OVERLAP = 0.5

/**
 * Applies one discovery run for `scope` (a volume id, or '*' for the opt-in
 * cross-drive run). Matching is by members, not by coordinates, so a place
 * whose centre drifts as photos are added is still recognised.
 *
 * - new grouping               -> a suggestion
 * - matches a suggestion       -> refreshed (geometry, confidence, auto members); user removals stay
 * - matches accepted/dismissed -> left exactly as the user left it
 * - untouched suggestion no longer found -> removed
 */
export function applyDiscovery(
  db: ColDb,
  scope: string,
  found: Discovered[],
  nowIso: string
): { added: number; updated: number; removed: number } {
  return atomically(db, () => {
    const out = { added: 0, updated: 0, removed: 0 }
    type Existing = { id: number; kind: string; status: CollectionStatus; touched: boolean; members: Set<string> }
    const existing = (
      db
        .prepare(
          `SELECT c.id, c.kind, c.status,
                  (c.name IS NOT NULL OR c.cover_path IS NOT NULL OR c.note IS NOT NULL
                   OR EXISTS (SELECT 1 FROM collection_files x WHERE x.collection_id = c.id AND x.state != 'auto')) AS touched
           FROM collections c WHERE c.scope = ? AND c.origin = 'auto'`
        )
        .all(scope) as { id: number; kind: string; status: CollectionStatus; touched: number }[]
    ).map((r): Existing => ({ id: r.id, kind: r.kind, status: r.status, touched: !!r.touched, members: new Set() }))
    const memberRows = db.prepare("SELECT path, volume_id FROM collection_files WHERE collection_id = ? AND state IN ('auto', 'removed')")
    for (const e of existing) for (const m of memberRows.all(e.id) as { path: string; volume_id: string }[]) e.members.add(m.volume_id + '|' + m.path)

    const matched = new Set<number>()
    const insertCol = db.prepare(
      `INSERT INTO collections (kind, status, origin, scope, confidence, lat, lng, radius_m, start_ms, end_ms, created_at, updated_at)
       VALUES (?, 'suggested', 'auto', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const refresh = db.prepare(
      'UPDATE collections SET confidence = ?, lat = ?, lng = ?, radius_m = ?, start_ms = ?, end_ms = ?, updated_at = ? WHERE id = ?'
    )
    const insertAuto = db.prepare("INSERT OR IGNORE INTO collection_files (collection_id, path, volume_id, state) VALUES (?, ?, ?, 'auto')")
    const dropAuto = db.prepare("DELETE FROM collection_files WHERE collection_id = ? AND path = ? AND volume_id = ? AND state = 'auto'")

    // Which existing groupings each file is in, so overlap is counted once per
    // member rather than (found x existing x members).
    const owners = new Map<string, Existing[]>()
    for (const e of existing)
      for (const k of e.members) {
        const o = owners.get(k)
        if (o) o.push(e)
        else owners.set(k, [e])
      }

    for (const f of found) {
      const keys = new Set(f.members.map((m) => m.volumeId + '|' + m.path))
      const common = new Map<Existing, number>()
      for (const k of keys) for (const e of owners.get(k) ?? []) common.set(e, (common.get(e) ?? 0) + 1)
      let best: Existing | null = null
      let bestScore = 0
      for (const [e, shared] of common) {
        if (e.kind !== f.kind || matched.has(e.id)) continue
        const score = shared / Math.min(keys.size, e.members.size)
        if (score >= SAME_OVERLAP && score > bestScore) {
          best = e
          bestScore = score
        }
      }
      if (!best) {
        const id = n(insertCol.run(f.kind, scope, f.confidence, f.lat, f.lng, f.radiusM, f.startMs, f.endMs, nowIso, nowIso).lastInsertRowid)
        for (const m of f.members) insertAuto.run(id, m.path, m.volumeId)
        out.added++
        continue
      }
      matched.add(best.id)
      if (best.status !== 'suggested') continue
      refresh.run(f.confidence, f.lat, f.lng, f.radiusM, f.startMs, f.endMs, nowIso, best.id)
      for (const k of best.members) {
        if (keys.has(k)) continue
        const bar = k.indexOf('|')
        dropAuto.run(best.id, k.slice(bar + 1), k.slice(0, bar))
      }
      for (const m of f.members) insertAuto.run(best.id, m.path, m.volumeId)
      out.updated++
    }
    for (const e of existing) {
      if (matched.has(e.id) || e.status !== 'suggested' || e.touched) continue
      deleteCollection(db, e.id)
      out.removed++
    }
    return out
  })
}
