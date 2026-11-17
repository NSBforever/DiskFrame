import React, { useCallback, useMemo, useRef, useState } from 'react'
import './DateScrubber.css'

interface LibraryGroup {
  key: string
  count: number
  minDate: string
  maxDate: string
  offset: number
}

interface Entry {
  key: string
  year: string
  month: string
  frac: number
  isYearStart: boolean
}

export interface DateScrubberProps {
  /** Group summary. Positions come from counts, so no file rows are needed. */
  groups: LibraryGroup[]
  formatGroupKey: (key: string) => string
  currentKey: string | null
  onJump: (key: string) => void
  /**
   * DOM ref to the position dot, so the parent can move it directly on every
   * scroll frame (true scroll progress: 0 at the top, 1 at the bottom) without
   * round-tripping through React state - the gallery re-rendering on every
   * scroll tick is exactly the kind of cost the rest of this component avoids
   * with its own CSS-var pointer glow. `currentKey` still drives the label and
   * keyboard navigation, which only need to update once per group, not once
   * per pixel.
   */
  indicatorRef?: React.RefObject<HTMLDivElement | null>
}

const UNKNOWN = 'Unknown date'
const MAX_TICKS = 240

export default function DateScrubber({
  groups,
  formatGroupKey,
  currentKey,
  onJump,
  indicatorRef
}: DateScrubberProps): React.JSX.Element | null {
  const railRef = useRef<HTMLDivElement>(null)
  const [hoverFrac, setHoverFrac] = useState<number | null>(null)
  const [hoverLabel, setHoverLabel] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  // Position by cumulative file count (a reasonable proxy for scroll distance
  // without threading PhotoGrid's internal per-row pixel layout out here) -
  // each group's representative date comes from its own first file, so this
  // works regardless of the current groupBy (day/month/year/location/favorites).
  // Positioned by cumulative file count, taken straight from the group summary,
  // so a jump never has to read the files in between.
  const entries = useMemo<Entry[]>(() => {
    let total = 0
    for (const g of groups) total += g.count
    if (total === 0) return []

    const list: Entry[] = []
    let cum = 0
    let lastYear: string | null = null
    for (const g of groups) {
      const iso = g.maxDate || g.key
      const year = /^\d{4}/.test(iso) ? iso.slice(0, 4) : UNKNOWN
      list.push({
        key: g.key,
        year,
        month: formatGroupKey(g.key),
        frac: cum / total,
        isYearStart: year !== lastYear
      })
      lastYear = year
      cum += g.count
    }
    return list
  }, [groups, formatGroupKey])

  const yearMarkers = useMemo(() => entries.filter((e) => e.isYearStart), [entries])

  // Ticks, thinned to what the rail can show. There is one group per day, so a
  // ten-year library had ~3,300 ticks one pixel tall on a rail well under a
  // thousand pixels: most were drawn on top of each other, and together they
  // were nine tenths of all the elements on the page - laid out, painted and
  // hit-tested on every scroll frame. One tick per ~1/240 of the rail looks
  // the same and costs nothing. Jumping still resolves against every group.
  const ticks = useMemo(() => {
    const out: Entry[] = []
    let last = -1
    for (const e of entries) {
      if (e.isYearStart) continue
      if (e.frac - last < 1 / MAX_TICKS) continue
      last = e.frac
      out.push(e)
    }
    return out
  }, [entries])

  const closestEntry = useCallback(
    (frac: number): Entry | null => {
      if (entries.length === 0) return null
      let closest = entries[0]
      let bestDist = Math.abs(entries[0].frac - frac)
      for (const e of entries) {
        const d = Math.abs(e.frac - frac)
        if (d < bestDist) {
          bestDist = d
          closest = e
        }
      }
      return closest
    },
    [entries]
  )

  const fracFromPointer = useCallback((clientY: number): number => {
    const rail = railRef.current
    if (!rail) return 0
    const rect = rail.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
  }, [])

  const handleMove = useCallback(
    (clientY: number) => {
      const frac = fracFromPointer(clientY)
      setHoverFrac(frac)
      const e = closestEntry(frac)
      if (e) setHoverLabel(e.month || e.year)
      if (dragging && e) onJump(e.key)
    },
    [fracFromPointer, closestEntry, dragging, onJump]
  )

  const handlePointerDown = (ev: React.PointerEvent): void => {
    setDragging(true)
    ;(ev.target as Element).setPointerCapture?.(ev.pointerId)
    handleMove(ev.clientY)
  }
  const handlePointerMove = (ev: React.PointerEvent): void => {
    handleMove(ev.clientY)
  }
  const handlePointerUp = (ev: React.PointerEvent): void => {
    setDragging(false)
    const e = closestEntry(fracFromPointer(ev.clientY))
    if (e) onJump(e.key)
  }
  const handlePointerLeave = (): void => {
    if (!dragging) {
      setHoverFrac(null)
      setHoverLabel(null)
    }
  }

  const handleKeyDown = (ev: React.KeyboardEvent): void => {
    if (yearMarkers.length === 0) return
    const currentIdx = entries.findIndex((e) => e.key === currentKey)
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      ev.preventDefault()
      const dir = ev.key === 'ArrowUp' ? -1 : 1
      // Jump between year markers - matches the visual granularity of the rail.
      const curYearIdx = yearMarkers.findIndex((y) => entries.indexOf(y) >= currentIdx)
      const nextIdx = Math.max(0, Math.min(yearMarkers.length - 1, (curYearIdx === -1 ? 0 : curYearIdx) + dir))
      onJump(yearMarkers[nextIdx].key)
    } else if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault()
      if (currentIdx >= 0) onJump(entries[currentIdx].key)
    }
  }

  if (entries.length < 2) return null

  const currentEntry = entries.find((e) => e.key === currentKey)

  return (
    <div
      ref={railRef}
      className="date-scrubber gallery-chrome"
      role="slider"
      aria-label="Jump to date"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round((currentEntry?.frac ?? 0) * 100)}
      aria-valuetext={currentEntry ? currentEntry.month || currentEntry.year : undefined}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onKeyDown={handleKeyDown}
    >
      <div className="date-scrubber-track" />
      {yearMarkers.map((e) => (
        <div key={'y:' + e.key} className="date-scrubber-year" style={{ top: `${e.frac * 100}%` }}>
          {e.year}
        </div>
      ))}
      {ticks.map((e) => (
        <div key={'m:' + e.key} className="date-scrubber-tick" style={{ top: `${e.frac * 100}%` }} />
      ))}
      {/* The dot rides a rail-sized carrier moved with a transform (a
          percentage of its own height, which is the rail's), so following the
          scroll never re-lays-out the rail. */}
      <div
        ref={indicatorRef}
        className="date-scrubber-carrier"
        // Count-based estimate for the very first paint, before any scroll
        // event has fired; every scroll after that overwrites this directly
        // via the ref instead of through a React re-render (see the prop doc).
        style={{ transform: `translateY(${(currentEntry?.frac ?? 0) * 100}%)` }}
      >
        <div className="date-scrubber-current" />
      </div>
      {hoverFrac !== null && hoverLabel && (
        <div className="date-scrubber-label" style={{ top: `${hoverFrac * 100}%` }}>
          {hoverLabel}
        </div>
      )}
    </div>
  )
}
