import { useCallback, useEffect, useRef, useState } from 'react'
import type { ScannedFile } from '../App'
import { pickEvictionVictim, reconcileCacheVersion, removeResidentRows } from '../../../main/pageCache'
import { COMPACT_EXTS } from '../../../main/libraryQuery'
import { resolveAnchorRow, type GalleryAnchor } from '../../../main/galleryAnchor'

const isCompactExt = (ext: string): boolean => COMPACT_EXTS.includes((ext || '').toLowerCase())

/**
 * Reads the library through SQLite instead of holding it in memory.
 *
 * The renderer previously received every row for a drive and re-derived the
 * whole view in JavaScript on each change. This keeps only the group summary
 * (one small record per group) plus a bounded window of pages around what is
 * actually visible.
 */

export interface LibraryQuery {
  drive: string
  nav: string
  search: string
  groupBy: string
  order: string
  /** 'date' | 'size-desc' | 'size-asc' - see libraryQuery.SortKey. */
  sort: string
}

export interface LibraryGroup {
  key: string
  count: number
  /** How many of those files have no preview and share compact cells. */
  compactCount: number
  minDate: string
  maxDate: string
  /** Index of this group's first row in the overall ordering. */
  offset: number
}

/**
 * The local calendar year a group belongs to. maxDate is a UTC ISO string, so
 * slicing it gave the UTC year: a photo taken on the evening of 31 December
 * east of Greenwich counted toward the next year. Group keys are local days
 * (libraryQuery.groupKeyExpr), so the year must be local too.
 */
export function groupYear(g: Pick<LibraryGroup, 'key' | 'maxDate'>): string {
  const t = g.maxDate ? new Date(g.maxDate) : null
  if (t && !isNaN(t.getTime())) return String(t.getFullYear())
  return /^\d{4}/.test(g.key) ? g.key.slice(0, 4) : 'Unknown'
}

export const PAGE_SIZE = 200
/** Pages kept resident. 12 x 200 rows is far more than any viewport needs, and
 *  is the ceiling on how much file metadata the renderer holds at once. */
const MAX_CACHED_PAGES = 12

/**
 * Where to put the viewport after a rearrangement: bring absolute row `row`
 * to `offsetPx` below the top (file mode), or show the top of its group
 * (`toGroupTop`). Delivered in the same render as the groups it refers to.
 */
export interface AnchorTarget {
  row: number
  groupIndex: number
  offsetPx: number
  toGroupTop: boolean
  nonce: number
}

export interface Library {
  groups: LibraryGroup[]
  /** Set together with `groups` after a rearrangement that carried an anchor. */
  anchorTarget: AnchorTarget | null
  total: number
  /** 'loading' until the first summary lands, so callers never report a confident 0. */
  state: 'loading' | 'ready' | 'error'
  /** Changes whenever resident pages change. getRow is intentionally a stable
   *  callback and `groups` does not change when a page lands, so memoized
   *  consumers need this to know there is new data to read. */
  pageVersion: number
  getRow: (index: number) => ScannedFile | undefined
  ensureRange: (start: number, end: number) => void
  /** Row for a path, if it happens to be resident. Used for in-place patches. */
  patchThumb: (path: string, thumb: string, volumeId?: string | null) => boolean
  /**
   * Index of a path in the current ordering, searching resident pages only.
   * -1 when it is not resident. Shift-range selection only ever spans what the
   * user can see, and what the user can see is resident by definition.
   */
  indexOfPath: (path: string) => number
  /**
   * Rows in an index range, read straight from SQLite and NOT cached.
   *
   * For the few things that genuinely need a list rather than a viewport:
   * select-a-whole-group, shift-range selection, the map and the search
   * overlay. Capped, because the point of this hook is that the renderer never
   * holds the whole catalogue - the caller is told when it was truncated so it
   * can say so rather than present a partial list as complete.
   */
  fetchRange: (
    start: number,
    count: number,
    queryOverride?: LibraryQuery
  ) => Promise<{ rows: ScannedFile[]; truncated: boolean }>
  reload: () => void
  /** Re-read without blanking what is on screen; see the implementation. */
  refresh: () => Promise<void>
  /** Takes rows off the screen now, ahead of the database; returns how many were resident. */
  removePaths: (paths: Iterable<string>) => number
}

/** Ceiling on one fetchRange call. 5000 rows is far more than any of its
 *  callers can usefully show, and small enough that it cannot reintroduce
 *  "hold the whole drive in the renderer". */
export const MAX_RANGE_ROWS = 5000

/**
 * Same files, different arrangement: only grouping, view order or sort moved.
 * The gallery keeps its current layout on screen until the new one is known,
 * instead of dropping back to a loading screen (which unmounted the grid and
 * lost the user's place - see galleryAnchor.ts).
 */
function sameFiles(a: LibraryQuery, b: LibraryQuery): boolean {
  return a.drive === b.drive && a.nav === b.nav && a.search === b.search
}

function sameQuery(a: LibraryQuery | null, b: LibraryQuery | null): boolean {
  if (!a || !b) return a === b
  return (
    a.drive === b.drive &&
    a.nav === b.nav &&
    a.search === b.search &&
    a.groupBy === b.groupBy &&
    a.order === b.order &&
    a.sort === b.sort
  )
}

export function useLibrary(
  query: LibraryQuery | null,
  /**
   * Set by the caller just before it changes the query; consumed (and cleared)
   * by the next query change. See galleryAnchor.ts.
   */
  anchorRef?: React.MutableRefObject<GalleryAnchor | null>
): Library {
  const [groups, setGroups] = useState<LibraryGroup[]>([])
  const [anchorTarget, setAnchorTarget] = useState<AnchorTarget | null>(null)
  // Read synchronously by removePaths, which can run twice before a render.
  const groupsRef = useRef(groups)
  groupsRef.current = groups
  const [total, setTotal] = useState(0)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  // Bumped on every query change. Responses carrying an older generation are
  // discarded, so switching drive or filter mid-flight cannot paint stale rows.
  const generationRef = useRef(0)
  const pagesRef = useRef(new Map<number, ScannedFile[]>())
  const inFlightRef = useRef(new Set<number>())
  // Catalogue fingerprint the resident pages were read at. Pages read against a
  // different one are from a different snapshot and may overlap, so the cache is
  // emptied rather than mixed - see reconcileCacheVersion.
  const cacheVersionRef = useRef<string | null>(null)
  // Page window the grid last asked for. Drives eviction so a page that is
  // on screen is never the one thrown away.
  const wantRef = useRef({ first: 0, last: 0 })
  // The query the resident pages and groups belong to.
  const queryRef = useRef<LibraryQuery | null>(null)
  const wantedRef = useRef<LibraryQuery | null>(null)
  const [pageVersion, setPageVersion] = useState(0)
  // Changes on every query change. ensureRange depends on it so its identity
  // changes too: the consumer's effect is keyed on the visible range, and after
  // a grouping change that range is often numerically identical (still the top
  // of the list) even though the page cache was just cleared. Without this the
  // grid would sit on skeletons forever, having never re-requested.
  const [queryEpoch, setQueryEpoch] = useState(0)
  const renderTimerRef = useRef<number | undefined>(undefined)

  // Coalesced repaint: several pages often land in the same tick.
  const scheduleRender = useCallback(() => {
    if (renderTimerRef.current !== undefined) return
    renderTimerRef.current = window.setTimeout(() => {
      renderTimerRef.current = undefined
      setPageVersion((n) => n + 1)
    }, 16)
  }, [])

  const resetCaches = useCallback(() => {
    pagesRef.current.clear()
    inFlightRef.current.clear()
    // Nothing is resident, so the next page to arrive sets the version rather
    // than being compared against the version of pages that no longer exist.
    cacheVersionRef.current = null
  }, [])

  const loadSummary = useCallback(
    (q: LibraryQuery, generation: number, anchor: GalleryAnchor | null = null, swap = false) => {
      window.api
        .librarySummary(q, anchor?.path ? { path: anchor.path, volumeId: anchor.volumeId } : null)
        .then((res) => {
          if (generation !== generationRef.current) return
          if (swap) {
            // The old arrangement stayed on screen, with its own pages, until
            // now. Switch query, pages and layout in this one render. The
            // generation moves again so a page the old layout asked for in
            // the meantime cannot land in the new cache.
            queryRef.current = q
            generationRef.current++
            resetCaches()
            setQueryEpoch((n) => n + 1)
          }
          setGroups(res.groups)
          setTotal(res.total)
          setState('ready')
          const hit = anchor ? resolveAnchorRow(res.groups, anchor, res.anchorIndex ?? null) : null
          setAnchorTarget(
            hit && anchor
              ? { row: hit.row, groupIndex: hit.groupIndex, offsetPx: anchor.offsetPx, toGroupTop: !hit.exact, nonce: generation }
              : null
          )
        })
        .catch(() => {
          if (generation !== generationRef.current) return
          setState('error')
        })
    },
    [resetCaches]
  )

  useEffect(() => {
    if (!query) {
      queryRef.current = null
      wantedRef.current = null
      resetCaches()
      setGroups([])
      setTotal(0)
      setState('loading')
      return
    }
    // The latest query asked for, which may not be on screen yet (a
    // rearrangement in flight). Compared against, so asking for the same thing
    // twice is still a no-op.
    if (sameQuery(wantedRef.current, query)) return
    wantedRef.current = query
    const anchor = anchorRef?.current ?? null
    if (anchorRef) anchorRef.current = null
    const generation = ++generationRef.current
    const shown = queryRef.current
    if (shown && sameFiles(shown, query) && groupsRef.current.length > 0) {
      loadSummary(query, generation, anchor, true)
      return
    }
    queryRef.current = query
    resetCaches()
    setState('loading')
    setQueryEpoch((n) => n + 1)
    loadSummary(query, generation, anchor)
  }, [query, loadSummary, resetCaches, anchorRef])

  useEffect(() => () => window.clearTimeout(renderTimerRef.current), [])

  const fetchPage = useCallback(
    (pageIndex: number) => {
      const q = queryRef.current
      if (!q) return
      if (pagesRef.current.has(pageIndex) || inFlightRef.current.has(pageIndex)) return
      const generation = generationRef.current
      inFlightRef.current.add(pageIndex)
      window.api
        .libraryPage(q, pageIndex * PAGE_SIZE, PAGE_SIZE)
        .then((res) => {
          inFlightRef.current.delete(pageIndex)
          // A page requested before the query changed is not useful any more.
          if (generation !== generationRef.current) return
          // Keep the resident set to one snapshot of the catalogue. Without
          // this, a page read before a discovery commit and one read after it
          // can both hold the same file, and the grid draws it twice.
          cacheVersionRef.current = reconcileCacheVersion(
            pagesRef.current,
            cacheVersionRef.current,
            res.version
          )
          pagesRef.current.set(pageIndex, res.rows as ScannedFile[])
          // Evict whatever is furthest from the window the grid last asked for.
          //
          // This used to evict in insertion order on the assumption that the
          // oldest page is the one furthest from the user. It is not: a burst
          // of scrolling requests pages faster than they arrive, and once more
          // than MAX_CACHED_PAGES are in flight the earliest arrivals are
          // dropped - including the page the user just landed on. Nothing then
          // re-requests it, because the grid only calls ensureRange when the
          // visible range *changes*, so those tiles stayed skeletons for good.
          while (pagesRef.current.size > MAX_CACHED_PAGES) {
            const { first, last } = wantRef.current
            const victim = pickEvictionVictim(pagesRef.current.keys(), first, last)
            // Everything resident is inside the wanted window - keep it all
            // rather than evicting a page that is about to be read.
            if (victim === undefined) break
            pagesRef.current.delete(victim)
          }
          scheduleRender()
        })
        .catch(() => {
          inFlightRef.current.delete(pageIndex)
        })
    },
    [scheduleRender]
  )

  const getRow = useCallback((index: number): ScannedFile | undefined => {
    const pageIndex = Math.floor(index / PAGE_SIZE)
    const page = pagesRef.current.get(pageIndex)
    if (!page) return undefined
    return page[index - pageIndex * PAGE_SIZE]
  }, [])

  const ensureRange = useCallback(
    (start: number, end: number) => {
      if (end < start) return
      const first = Math.max(0, Math.floor(start / PAGE_SIZE))
      const last = Math.floor(Math.max(0, end) / PAGE_SIZE)
      // One page of lookahead each way keeps scrolling ahead of the fetch
      // without turning a scroll into a full-library read.
      wantRef.current = { first: Math.max(0, first - 1), last: last + 1 }
      for (let p = wantRef.current.first; p <= wantRef.current.last; p++) fetchPage(p)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fetchPage, queryEpoch]
  )

  // Patches a resident row in place and repaints. Thumbnails do not change
  // grouping or ordering, so nothing is re-queried and the gallery does not
  // move - the tile simply gains its image.
  const patchThumb = useCallback(
    (path: string, thumb: string, volumeId?: string | null): boolean => {
      // All Drives can hold two volumes' rows at one literal path. A thumbnail
      // says which volume it was made from; only that volume's row takes it.
      for (const page of pagesRef.current.values()) {
        for (const row of page) {
          if (row.path === path && (volumeId == null || row.volume_id === volumeId)) {
            if (row.thumb === thumb) return false
            row.thumb = thumb
            scheduleRender()
            return true
          }
        }
      }
      return false
    },
    [scheduleRender]
  )

  const indexOfPath = useCallback((path: string): number => {
    for (const [pageIndex, page] of pagesRef.current) {
      const within = page.findIndex((r) => r.path === path)
      if (within !== -1) return pageIndex * PAGE_SIZE + within
    }
    return -1
  }, [])

  const fetchRange = useCallback(
    async (
      start: number,
      count: number,
      queryOverride?: LibraryQuery
    ): Promise<{ rows: ScannedFile[]; truncated: boolean }> => {
      const q = queryOverride ?? queryRef.current
      if (!q || count <= 0) return { rows: [], truncated: false }
      const generation = generationRef.current
      const from = Math.max(0, Math.floor(start))
      const wanted = Math.floor(count)
      const take = Math.min(wanted, MAX_RANGE_ROWS)
      const rows: ScannedFile[] = []
      for (let off = 0; off < take; off += PAGE_SIZE) {
        const size = Math.min(PAGE_SIZE, take - off)
        const res = await window.api.libraryPage(q, from + off, size)
        // The drive or filter changed while this was walking - abandon it
        // rather than hand back rows from a query nobody is looking at.
        if (generation !== generationRef.current) return { rows: [], truncated: false }
        const batch = res.rows as ScannedFile[]
        rows.push(...batch)
        if (batch.length < size) break
      }
      return { rows, truncated: wanted > take }
    },
    []
  )

  /**
   * Re-reads the summary and the pages on screen, then swaps them in at once.
   *
   * reload() empties the cache first, so every tile becomes a skeleton until
   * its page returns - right for a new query, wrong for "a file changed under
   * the gallery the user is reading". This keeps showing what is resident
   * until the fresh summary and pages have all arrived, so the change lands
   * as one repaint: removed tiles gone, added ones in place, nothing blank.
   */
  const refresh = useCallback(async (): Promise<void> => {
    const q = queryRef.current
    if (!q) return
    // A rearrangement still in flight: re-read what was asked for, not what
    // happens to be on screen.
    if (!sameQuery(q, wantedRef.current)) {
      reloadRef.current()
      return
    }
    const generation = ++generationRef.current
    const { first, last } = wantRef.current
    try {
      const summary = await window.api.librarySummary(q)
      const indices: number[] = []
      for (let p = first; p <= last && p * PAGE_SIZE < summary.total; p++) indices.push(p)
      const pages = await Promise.all(indices.map((p) => window.api.libraryPage(q, p * PAGE_SIZE, PAGE_SIZE)))
      if (generation !== generationRef.current) return
      // Pages read across a discovery commit could overlap; fall back to a
      // clean reload rather than risk drawing a file twice.
      const versions = new Set(pages.map((p) => p.version))
      if (versions.size > 1) {
        reloadRef.current()
        return
      }
      const next = new Map<number, ScannedFile[]>()
      indices.forEach((p, i) => next.set(p, pages[i].rows as ScannedFile[]))
      pagesRef.current = next
      inFlightRef.current.clear()
      cacheVersionRef.current = pages[0]?.version ?? null
      setGroups(summary.groups)
      setTotal(summary.total)
      setState('ready')
      setPageVersion((n) => n + 1)
      // New identity for ensureRange, so the grid asks for anything it needs
      // that this did not cover.
      setQueryEpoch((n) => n + 1)
    } catch {
      if (generation === generationRef.current) reloadRef.current()
    }
  }, [])

  /**
   * Takes rows out of what is on screen immediately - before the main process
   * has been asked anything - so a trashed file disappears on the click, not
   * on the round trip. Group counts, offsets and the total change with it, so
   * the grid reflows exactly as the next summary will. refresh() afterwards
   * confirms it against the database, and puts rows back if the trash failed.
   */
  const removePaths = useCallback(
    (paths: Iterable<string>): number => {
      const result = removeResidentRows(pagesRef.current, PAGE_SIZE, groupsRef.current, new Set(paths), isCompactExt)
      if (result.removed === 0) return 0
      pagesRef.current = result.pages
      groupsRef.current = result.groups
      setGroups(result.groups)
      setTotal((t) => Math.max(0, t - result.removed))
      setPageVersion((n) => n + 1)
      return result.removed
    },
    []
  )

  const reload = useCallback(() => {
    const q = wantedRef.current ?? queryRef.current
    if (!q) return
    queryRef.current = q
    const generation = ++generationRef.current
    resetCaches()
    // Same reason as on a query change: the page cache was just emptied, but
    // the grid's visible range is usually identical, so without a new epoch
    // ensureRange keeps its identity, the grid's effect never re-runs, and
    // every tile sits on a skeleton with nothing left to fetch its page.
    setQueryEpoch((n) => n + 1)
    loadSummary(q, generation)
  }, [loadSummary, resetCaches])
  const reloadRef = useRef(reload)
  reloadRef.current = reload

  return {
    groups,
    anchorTarget,
    total,
    state,
    pageVersion,
    getRow,
    ensureRange,
    patchThumb,
    indexOfPath,
    fetchRange,
    reload,
    refresh,
    removePaths
  }
}
