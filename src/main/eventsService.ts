/**
 * The Events section's main-process side: Places, Trips and custom
 * collections (collections.ts) and local discovery (discovery.ts).
 *
 * Everything stays on this machine. Nothing here makes a network request:
 * no reverse geocoding, no upload of coordinates, paths or pictures. Place
 * names are whatever the user types.
 *
 * Every renderer input is validated here: ids are integers, kinds and states
 * come from fixed lists, names are trimmed and capped, and file references
 * must be local paths with a volume id.
 */
import type { IpcMain } from 'electron'
import {
  createCollectionWithFiles,
  updateCollection,
  addFiles,
  removeFiles,
  mergeCollections,
  splitCollection,
  deleteCollection,
  type ColDb,
  type CollectionCard,
  type CollectionKind,
  type CollectionStatus,
  type FileRef
} from './collections'
import type { DiscoveryPrefs, DiscoveryScope } from './discovery'

export interface EventsDeps {
  ipcMain: IpcMain
  db: ColDb
  /** Volume ids in view for a drive key (a letter, or All Drives). */
  volumesFor: (drive: unknown) => Promise<string[]>
  listCards: (volumeIds: string[], crossDrive: boolean) => Promise<CollectionCard[]>
  members: (id: number) => Promise<Record<string, unknown>[]>
  discover: (scopes: DiscoveryScope[], home: DiscoveryPrefs['home']) => Promise<unknown>
  /** Marks rows whose volume is not the one mounted at their letter now. */
  annotate: <T extends Record<string, unknown>>(rows: T[]) => T[]
  /** A larger picture for a card, from the file itself - only when the file is on its own volume now. */
  cover: (ref: FileRef) => Promise<string | null>
  getPrefs: () => DiscoveryPrefs
  setPrefs: (p: Partial<DiscoveryPrefs>) => DiscoveryPrefs
  isSafeLocalPath: (p: unknown) => p is string
  log: (m: string) => void
}

const KINDS: CollectionKind[] = ['place', 'trip', 'custom']
const STATUSES: CollectionStatus[] = ['suggested', 'accepted', 'dismissed']
const MAX_REFS = 10_000

export function initEvents(d: EventsDeps): void {
  const id = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : null)
  const text = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null)
  // A reference must name a file the catalogue has: a collection never holds,
  // and a cover is never made from, an arbitrary path the renderer invents.
  const catalogued = d.db.prepare('SELECT 1 FROM files WHERE volume_id = ? AND path = ?')
  const refs = (v: unknown): FileRef[] => {
    if (!Array.isArray(v)) return []
    const out: FileRef[] = []
    for (const r of v.slice(0, MAX_REFS)) {
      const o = r as { path?: unknown; volumeId?: unknown } | null
      if (!o || !d.isSafeLocalPath(o.path) || typeof o.volumeId !== 'string' || !o.volumeId || o.volumeId.length > 512) continue
      if (!catalogued.get(o.volumeId, o.path)) continue
      out.push({ path: o.path, volumeId: o.volumeId })
    }
    return out
  }
  const now = (): string => new Date().toISOString()
  const guard = <T>(what: string, fn: () => T, fallback: T): T => {
    try {
      return fn()
    } catch (e) {
      d.log(`${what} failed: ${String(e)}`)
      return fallback
    }
  }

  d.ipcMain.handle('events-list', async (_e, drive: unknown) => {
    const volumeIds = await d.volumesFor(drive)
    const prefs = d.getPrefs()
    const cross = prefs.crossDrive && volumeIds.length > 1
    // Suggestions from the other discovery mode are left out (in SQL, see
    // listCollections); anything the user kept always shows.
    const cards = await d.listCards(volumeIds, cross)
    return { cards, volumeIds, prefs }
  })

  d.ipcMain.handle('events-discover', async (_e, drive: unknown) => {
    const volumeIds = await d.volumesFor(drive)
    if (!volumeIds.length) return []
    const prefs = d.getPrefs()
    const scopes: DiscoveryScope[] =
      prefs.crossDrive && volumeIds.length > 1 ? [{ scope: '*', volumeIds }] : volumeIds.map((v) => ({ scope: v, volumeIds: [v] }))
    const t = Date.now()
    const r = await d.discover(scopes, prefs.home)
    d.log(`discovery ${scopes.length} scope(s) in ${Date.now() - t}ms: ${JSON.stringify(r)}`)
    return r
  })

  d.ipcMain.handle('collection-files', async (_e, raw: unknown) => {
    const cid = id(raw)
    return cid ? d.annotate(await d.members(cid)) : []
  })

  d.ipcMain.handle('collection-create', (_e, raw: unknown) => {
    const o = (raw ?? {}) as { kind?: unknown; name?: unknown; refs?: unknown }
    const kind = KINDS.includes(o.kind as CollectionKind) ? (o.kind as CollectionKind) : 'custom'
    return guard(
      'create',
      () => {
        return createCollectionWithFiles(d.db, { kind, name: text(o.name, 200) ?? '' }, refs(o.refs), now())
      },
      null
    )
  })

  d.ipcMain.handle('collection-update', (_e, raw: unknown) => {
    const o = (raw ?? {}) as { id?: unknown; name?: unknown; note?: unknown; status?: unknown; kind?: unknown; cover?: unknown; startMs?: unknown; endMs?: unknown }
    const cid = id(o.id)
    if (!cid) return false
    const patch: Parameters<typeof updateCollection>[2] = {}
    if (o.name !== undefined) patch.name = text(o.name, 200)
    if (o.note !== undefined) patch.note = text(o.note, 500)
    if (STATUSES.includes(o.status as CollectionStatus)) patch.status = o.status as CollectionStatus
    if (KINDS.includes(o.kind as CollectionKind)) patch.kind = o.kind as CollectionKind
    // A date is a finite epoch ms in a sane range, or null to clear.
    const when = (v: unknown): number | null | undefined =>
      v === null ? null : typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 8.64e15 ? Math.round(v) : undefined
    if (o.startMs !== undefined && when(o.startMs) !== undefined) patch.startMs = when(o.startMs)
    if (o.endMs !== undefined && when(o.endMs) !== undefined) patch.endMs = when(o.endMs)
    if (o.cover === null) patch.cover = null
    else if (o.cover !== undefined) {
      const [c] = refs([o.cover])
      if (c) patch.cover = c
    }
    return guard('update', () => (updateCollection(d.db, cid, patch, now()), true), false)
  })

  d.ipcMain.handle('collection-add', (_e, raw: unknown) => {
    const o = (raw ?? {}) as { id?: unknown; refs?: unknown }
    const cid = id(o.id)
    return cid ? guard('add', () => addFiles(d.db, cid, refs(o.refs)), 0) : 0
  })

  d.ipcMain.handle('collection-remove', (_e, raw: unknown) => {
    const o = (raw ?? {}) as { id?: unknown; refs?: unknown }
    const cid = id(o.id)
    return cid ? guard('remove', () => removeFiles(d.db, cid, refs(o.refs)), 0) : 0
  })

  d.ipcMain.handle('collection-merge', (_e, raw: unknown) => {
    const o = (raw ?? {}) as { into?: unknown; from?: unknown }
    const into = id(o.into)
    const from = id(o.from)
    return into && from ? guard('merge', () => (mergeCollections(d.db, into, from, now()), true), false) : false
  })

  d.ipcMain.handle('collection-split', (_e, raw: unknown) => {
    const o = (raw ?? {}) as { id?: unknown; refs?: unknown; name?: unknown }
    const cid = id(o.id)
    const r = refs(o.refs)
    return cid && r.length ? guard('split', () => splitCollection(d.db, cid, r, text(o.name, 200) ?? '', now()), null) : null
  })

  d.ipcMain.handle('collection-delete', (_e, raw: unknown) => {
    const cid = id(raw)
    return cid ? guard('delete', () => (deleteCollection(d.db, cid), true), false) : false
  })

  d.ipcMain.handle('collection-cover', async (_e, raw: unknown) => {
    const [r] = refs([raw])
    return r ? d.cover(r).catch(() => null) : null
  })

  d.ipcMain.handle('discovery-prefs', () => d.getPrefs())
  d.ipcMain.handle('set-discovery-prefs', (_e, raw: unknown) => {
    const o = (raw ?? {}) as { crossDrive?: unknown; home?: unknown }
    const p: Partial<DiscoveryPrefs> = {}
    if (typeof o.crossDrive === 'boolean') p.crossDrive = o.crossDrive
    if (o.home === null) p.home = null
    else if (o.home && typeof o.home === 'object') {
      const h = o.home as { lat?: unknown; lng?: unknown }
      const lat = Number(h.lat)
      const lng = Number(h.lng)
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) p.home = { lat, lng }
    }
    return d.setPrefs(p)
  })
}
