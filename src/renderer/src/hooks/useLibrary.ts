import { useCallback, useEffect, useRef, useState } from 'react'
import type { ScannedFile } from '../App'

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
}

export interface LibraryGroup {
  key: string
  count: number
  minDate: string
  maxDate: string
  /** Index of this group's first row in the overall ordering. */
  offset: number
}

export const PAGE_SIZE = 200
/** Pages kept resident. 12 x 200 rows is far more than any viewport needs, and
 *  is the ceiling on how much file metadata the renderer holds at once. */
const MAX_CACHED_PAGES = 12

export interface Library {
  groups: LibraryGroup[]
  total: number
  /** 'loading' until the first summary lands, so callers never report a confident 0. */
  state: 'loading' | 'ready' | 'error'
  getRow: (index: number) => ScannedFile | undefined
  ensureRange: (start: number, end: number) => void
  /** Row for a path, if it happens to be resident. Used for in-place patches. */
  patchThumb: (path: string, thumb: string) => boolean
  reload: () => void
}

function sameQuery(a: LibraryQuery | null, b: LibraryQuery | null): boolean {
  if (!a || !b) return a === b
  return (
    a.drive === b.drive &&
    a.nav === b.nav &&
    a.search === b.search &&
    a.groupBy === b.groupBy &&
    a.order === b.order
  )
}

export function useLibrary(query: LibraryQuery | null): Library {
  const [groups, setGroups] = useState<LibraryGroup[]>([])
  const [total, setTotal] = useState(0)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  // Bumped on every query change. Responses carrying an older generation are
  // discarded, so switching drive or filter mid-flight cannot paint stale rows.
  const generationRef = useRef(0)
  const pagesRef = useRef(new Map<number, ScannedFile[]>())
  const inFlightRef = useRef(new Set<number>())
  const queryRef = useRef<LibraryQuery | null>(null)
  const [, forceRender] = useState(0)
  const renderTimerRef = useRef<number | undefined>(undefined)

  // Coalesced repaint: several pages often land in the same tick.
  const scheduleRender = useCallback(() => {
    if (renderTimerRef.current !== undefined) return
    renderTimerRef.current = window.setTimeout(() => {
      renderTimerRef.current = undefined
      forceRender((n) => n + 1)
    }, 16)
  }, [])

  const resetCaches = useCallback(() => {
    pagesRef.current.clear()
    inFlightRef.current.clear()
  }, [])

  const loadSummary = useCallback(
    (q: LibraryQuery, generation: number) => {
      window.api
        .librarySummary(q)
        .then((res) => {
          if (generation !== generationRef.current) return
          setGroups(res.groups)
          setTotal(res.total)
          setState('ready')
        })
        .catch(() => {
          if (generation !== generationRef.current) return
          setState('error')
        })
    },
    []
  )

  useEffect(() => {
    if (!query) {
      queryRef.current = null
      resetCaches()
      setGroups([])
      setTotal(0)
      setState('loading')
      return
    }
    if (sameQuery(queryRef.current, query)) return
    queryRef.current = query
    const generation = ++generationRef.current
    resetCaches()
    setState('loading')
    loadSummary(query, generation)
  }, [query, loadSummary, resetCaches])

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
          pagesRef.current.set(pageIndex, res.rows as ScannedFile[])
          // Evict in insertion order, which for scrolling is the page furthest
          // from where the user now is.
          while (pagesRef.current.size > MAX_CACHED_PAGES) {
            const oldest = pagesRef.current.keys().next().value
            if (oldest === undefined) break
            pagesRef.current.delete(oldest)
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
      for (let p = Math.max(0, first - 1); p <= last + 1; p++) fetchPage(p)
    },
    [fetchPage]
  )

  const patchThumb = useCallback((path: string, thumb: string): boolean => {
    for (const page of pagesRef.current.values()) {
      for (const row of page) {
        if (row.path === path) {
          if (row.thumb === thumb) return false
          row.thumb = thumb
          return true
        }
      }
    }
    return false
  }, [])

  const reload = useCallback(() => {
    const q = queryRef.current
    if (!q) return
    const generation = ++generationRef.current
    resetCaches()
    loadSummary(q, generation)
  }, [loadSummary, resetCaches])

  return { groups, total, state, getRow, ensureRange, patchThumb, reload }
}
