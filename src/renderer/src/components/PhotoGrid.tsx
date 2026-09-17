/**
 * PhotoGrid — Apple Photos–style gallery grid.
 *
 * - Own virtualization with fixed-geometry math (no per-row measuring), so
 *   positions are exact and zoom can keep the photo under your fingers in place.
 * - Trackpad pinch (Chromium delivers it as ctrl+wheel) scales the grid
 *   continuously on the compositor. When the visual tile size crosses the
 *   midpoint to the next zoom level, the column count is committed mid-gesture
 *   and tiles FLIP-animate to their new positions. On release it settles to 1x.
 * - Mouse ctrl+wheel steps one zoom level with the same animation.
 * - Two-finger touch pinch on touchscreens works the same way.
 */
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, FileText, Film, Heart, Image as ImageIcon, Play } from 'lucide-react'
import type { ScannedFile } from '../App'
import { useReducedMotionPref } from '../hooks/useReducedMotionPref'
import './PhotoGrid.css'

// ─── Geometry ────────────────────────────────────────────────────────────────
const GAP = 2
const PAD_X = 20
const PAD_TOP = 8
const HEADER_H = 52
const SECTION_GAP = 18
const PAD_BOTTOM = 48
const MAX_COLS = 40
/** Zoom levels expressed as target tile sizes (largest → smallest). */
const LEVEL_TARGETS = [380, 290, 220, 170, 132, 104, 82, 64, 50, 40]

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.gif', '.bmp'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.m4v', '.webm'])
const DOC_EXTS = new Set(['.pdf', '.docx', '.doc', '.txt', '.xlsx', '.pptx', '.csv'])

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const tileFor = (width: number, cols: number): number => (width - GAP * (cols - 1)) / cols
const colsFor = (width: number, tile: number): number =>
  clamp(Math.round((width + GAP) / (tile + GAP)), 1, MAX_COLS)

/** Distinct column counts for this width, ascending (fewest cols = biggest tiles first). */
function levelsFor(width: number): number[] {
  const set = new Set<number>()
  for (const t of LEVEL_TARGETS) set.add(colsFor(width, t))
  return [...set].sort((a, b) => a - b)
}

interface Section {
  key: string
  files: ScannedFile[]
  top: number
  rowsTop: number
  rows: number
  bottom: number
}

interface Layout {
  cols: number
  tile: number
  pitch: number
  sections: Section[]
  height: number
}

function buildLayout(keys: string[], data: Record<string, ScannedFile[]>, width: number, cols: number): Layout {
  const tile = tileFor(width, cols)
  const pitch = tile + GAP
  const sections: Section[] = []
  let y = PAD_TOP
  for (const key of keys) {
    const files = data[key]
    if (!files || files.length === 0) continue
    const rows = Math.ceil(files.length / cols)
    const rowsTop = y + HEADER_H
    const bottom = rowsTop + rows * pitch - GAP + SECTION_GAP
    sections.push({ key, files, top: y, rowsTop, rows, bottom })
    y = bottom
  }
  return { cols, tile, pitch, sections, height: y + PAD_BOTTOM }
}

/** First section whose bottom is below y. */
function firstSectionAfter(sections: Section[], y: number): number {
  let lo = 0
  let hi = sections.length - 1
  let ans = sections.length
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (sections[mid].bottom > y) {
      ans = mid
      hi = mid - 1
    } else lo = mid + 1
  }
  return ans
}

function tilePos(layout: Layout, s: Section, i: number): { x: number; y: number } {
  return {
    x: PAD_X + (i % layout.cols) * layout.pitch,
    y: s.rowsTop + Math.floor(i / layout.cols) * layout.pitch
  }
}

interface Anchor {
  key: string
  index: number
  fx: number
  fy: number
}

function anchorAt(layout: Layout, cx: number, cy: number): Anchor | null {
  const { sections } = layout
  if (sections.length === 0) return null
  const si = Math.min(firstSectionAfter(sections, cy), sections.length - 1)
  const s = sections[si]
  if (cy < s.rowsTop) return { key: s.key, index: 0, fx: 0, fy: 0 }
  const row = clamp(Math.floor((cy - s.rowsTop) / layout.pitch), 0, s.rows - 1)
  const col = clamp(Math.floor((cx - PAD_X) / layout.pitch), 0, layout.cols - 1)
  const index = Math.min(s.files.length - 1, row * layout.cols + col)
  const p = tilePos(layout, s, index)
  return {
    key: s.key,
    index,
    fx: clamp((cx - p.x) / layout.tile, 0, 1),
    fy: clamp((cy - p.y) / layout.tile, 0, 1)
  }
}

function anchorContentPoint(layout: Layout, a: Anchor): { x: number; y: number } | null {
  const s = layout.sections.find(sec => sec.key === a.key)
  if (!s) return null
  const p = tilePos(layout, s, Math.min(a.index, s.files.length - 1))
  return { x: p.x + a.fx * layout.tile, y: p.y + a.fy * layout.tile }
}

// ─── Tile ────────────────────────────────────────────────────────────────────
export interface GridActions {
  open: (file: ScannedFile, e: React.MouseEvent) => void
  select: (file: ScannedFile, e: React.MouseEvent) => void
  fav: (file: ScannedFile) => void
  context: (file: ScannedFile, e: React.MouseEvent) => void
  dragPaths: (file: ScannedFile) => string[]
}

function mediaUrl(p: string): string {
  return 'media:///' + p.replace(/\\/g, '/')
}

// Only one hover preview plays at a time, across the whole grid.
let stopActivePreview: (() => void) | null = null
const HOVER_DELAY_MS = 350
const PREVIEW_MAX_SECONDS = 5

const GridTile = memo(function GridTile({
  file,
  x,
  y,
  size,
  isSelected,
  isFav,
  isDeleting,
  thumb,
  actions,
  hoverPreviewsEnabled
}: {
  file: ScannedFile
  thumb: string | null
  x: number
  y: number
  size: number
  isSelected: boolean
  isFav: boolean
  isDeleting: boolean
  actions: GridActions
  hoverPreviewsEnabled: boolean
}): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  const press = useRef<{ x: number; y: number; dragged: boolean } | null>(null)
  const ext = file.ext.toLowerCase()
  const isPhoto = PHOTO_EXTS.has(ext)
  const isVideo = VIDEO_EXTS.has(ext)
  // Full-size originals are only used as a fallback for formats Chromium can decode.
  const src = thumb ? thumb : isPhoto && ext !== '.heic' ? file.path : null
  const showImg = !!src && !failed
  const compact = size < 72
  const reducedMotion = useReducedMotionPref()

  useEffect(() => setFailed(false), [thumb])

  // Video hover preview - thumbnail stays visible underneath until the video
  // actually has a decoded frame ready, then fades in on top of it.
  const [previewing, setPreviewing] = useState(false)
  const [previewReady, setPreviewReady] = useState(false)
  const hoverTimerRef = useRef<number | undefined>(undefined)

  const stopPreview = useCallback(() => {
    window.clearTimeout(hoverTimerRef.current)
    setPreviewing(false)
    setPreviewReady(false)
  }, [])

  // Unmount = scrolled out of view (virtualization), folder switched, or window closed.
  useEffect(() => stopPreview, [stopPreview])

  const canPreview = isVideo && hoverPreviewsEnabled && !reducedMotion

  const onTileMouseEnter = (): void => {
    if (!canPreview) return
    hoverTimerRef.current = window.setTimeout(() => {
      stopActivePreview?.()
      stopActivePreview = stopPreview
      setPreviewing(true)
    }, HOVER_DELAY_MS)
  }
  const onTileMouseLeaveForPreview = (): void => {
    window.clearTimeout(hoverTimerRef.current)
    if (stopActivePreview === stopPreview) stopActivePreview = null
    stopPreview()
  }

  const onMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    press.current = { x: e.clientX, y: e.clientY, dragged: false }
  }
  const onMouseMove = (e: React.MouseEvent): void => {
    const p = press.current
    if (!p || p.dragged) return
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) {
      p.dragged = true
      window.api.startNativeDrag(actions.dragPaths(file))
    }
  }
  const onMouseUp = (e: React.MouseEvent): void => {
    const p = press.current
    press.current = null
    if (e.button !== 0 || !p || p.dragged) return
    if (e.ctrlKey || e.metaKey || e.shiftKey) actions.select(file, e)
    else actions.open(file, e)
  }
  // Overlay buttons must not start a press on the tile (otherwise mouseup opens the viewer).
  const stop = (e: React.MouseEvent): void => e.stopPropagation()

  const cls = 'pg-tile' + (isSelected ? ' is-selected' : '') + (isDeleting ? ' is-deleting' : '') + (compact ? ' is-compact' : '')

  return (
    <div
      data-tile={file.path}
      className={cls}
      style={{ left: x, top: y, width: size, height: size }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseEnter={onTileMouseEnter}
      onMouseLeave={() => { press.current = null; onTileMouseLeaveForPreview() }}
      onContextMenu={e => actions.context(file, e)}
      title={compact ? file.name : undefined}
    >
      <div className="pg-tile-inner">
        {showImg ? (
          <img
            key={src}
            src={mediaUrl(src)}
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={e => e.currentTarget.classList.add('pg-loaded')}
            onError={() => setFailed(true)}
          />
        ) : (
          <div className={'pg-placeholder' + (isVideo ? ' is-video' : DOC_EXTS.has(ext) ? ' is-doc' : '')}>
            {isVideo ? <Film size={compact ? 16 : 24} /> : DOC_EXTS.has(ext) ? <FileText size={compact ? 16 : 24} /> : <ImageIcon size={compact ? 16 : 24} />}
            {!compact && <span>{ext.replace('.', '')}</span>}
          </div>
        )}
        {isVideo && showImg && !previewReady && (
          <div className="pg-video-badge">
            <Play size={compact ? 8 : 10} fill="#fff" stroke="none" />
          </div>
        )}
        {previewing && (
          <video
            className="pg-preview-video"
            style={{ opacity: previewReady ? 1 : 0 }}
            src={mediaUrl(file.path)}
            muted
            autoPlay
            playsInline
            onLoadedData={() => setPreviewReady(true)}
            onTimeUpdate={e => { if (e.currentTarget.currentTime >= PREVIEW_MAX_SECONDS) stopPreview() }}
            onError={stopPreview}
          />
        )}
        {!compact && <div className="pg-name">{file.name}</div>}
      </div>
      {!compact && (
        <>
          <div
            className="pg-check"
            onMouseDown={stop}
            onMouseUp={stop}
            onClick={e => {
              e.stopPropagation()
              actions.select(file, e)
            }}
          >
            {isSelected && <Check size={11} strokeWidth={3} />}
          </div>
          <div
            className={'pg-fav' + (isFav ? ' is-fav' : '')}
            onMouseDown={stop}
            onMouseUp={stop}
            onClick={e => {
              e.stopPropagation()
              actions.fav(file)
            }}
          >
            <Heart size={12} fill={isFav ? '#e11d2e' : 'none'} color={isFav ? '#e11d2e' : '#fff'} />
          </div>
        </>
      )}
      {compact && isFav && <div className="pg-fav-dot" />}
    </div>
  )
})

// ─── Grid ────────────────────────────────────────────────────────────────────
export interface PhotoGridProps {
  keys: string[]
  data: Record<string, ScannedFile[]>
  selected: Set<string>
  favourites: Set<string>
  deletingPaths: Set<string>
  /** Preferred tile size in px (persisted). */
  tileSize: number
  onTileSizeCommit: (size: number) => void
  /** Pinched out past the densest level. */
  onZoomOutBeyond: () => void
  onOpen: (file: ScannedFile, list: ScannedFile[], e?: React.MouseEvent) => void
  onSelect: (file: ScannedFile, e: React.MouseEvent) => void
  onFav: (file: ScannedFile) => void
  onContextMenu: (file: ScannedFile, list: ScannedFile[], e: React.MouseEvent) => void
  onGroupCheckboxClick: (key: string, e: React.MouseEvent) => void
  scrollRequest: { key: string; nonce: number } | null
  /** Bumped when thumbnails are patched into file objects in place. */
  thumbVersion: number
  hoverPreviewsEnabled: boolean
}

interface Pending {
  anchor: Anchor | null
  originY: number
  scrollTop: number
  residual: number
  oldRects: Map<string, DOMRect> | null
}

export default function PhotoGrid(props: PhotoGridProps): React.JSX.Element {
  const { keys, data, selected, favourites, deletingPaths, tileSize, hoverPreviewsEnabled } = props

  const outerRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [cols, setCols] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)

  const gridWidth = Math.max(0, viewport.width - PAD_X * 2)
  const effectiveCols = cols || (gridWidth > 0 ? colsFor(gridWidth, tileSize) : 1)

  const layout = useMemo(
    () => buildLayout(keys, data, Math.max(gridWidth, 1), effectiveCols),
    [keys, data, gridWidth, effectiveCols]
  )
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  // Latest props for stable callbacks (keeps tiles memoized).
  const propsRef = useRef(props)
  propsRef.current = props

  const sectionOf = useMemo(() => {
    const m = new Map<string, ScannedFile[]>()
    for (const s of layout.sections) for (const f of s.files) m.set(f.path, s.files)
    return m
  }, [layout.sections])
  const sectionOfRef = useRef(sectionOf)
  sectionOfRef.current = sectionOf

  const actions = useMemo<GridActions>(
    () => ({
      open: (f, e) => propsRef.current.onOpen(f, sectionOfRef.current.get(f.path) ?? [f], e),
      select: (f, e) => propsRef.current.onSelect(f, e),
      fav: f => propsRef.current.onFav(f),
      context: (f, e) => propsRef.current.onContextMenu(f, sectionOfRef.current.get(f.path) ?? [f], e),
      dragPaths: f => {
        const sel = propsRef.current.selected
        return sel.has(f.path) ? [...sel] : [f.path]
      }
    }),
    []
  )

  // ── Tile-size preference ↔ columns ──
  const lastEmittedRef = useRef<number | null>(null)
  useEffect(() => {
    if (gridWidth <= 0) return
    if (lastEmittedRef.current === tileSize) return
    setCols(colsFor(gridWidth, tileSize))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tileSize])

  const emitTimer = useRef<number | undefined>(undefined)
  const emitTileSize = useCallback((c: number, w: number) => {
    window.clearTimeout(emitTimer.current)
    emitTimer.current = window.setTimeout(() => {
      const size = Math.round(tileFor(w, c))
      lastEmittedRef.current = size
      propsRef.current.onTileSizeCommit(size)
    }, 400)
  }, [])
  useEffect(() => () => window.clearTimeout(emitTimer.current), [])

  // ── Pending commit (anchor + FLIP), applied after React renders the new layout ──
  const pendingRef = useRef<Pending | null>(null)
  const scaleRef = useRef(1)
  const originRef = useRef({ x: 0, y: 0 })

  const setScale = useCallback((s: number, animate: boolean) => {
    const el = scrollerRef.current
    if (!el) return
    scaleRef.current = s
    el.style.transition = animate ? 'transform 260ms cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none'
    el.style.transformOrigin = `${originRef.current.x}px ${originRef.current.y}px`
    el.style.transform = s === 1 ? '' : `scale(${s})`
  }, [])

  const captureRects = (): Map<string, DOMRect> => {
    const map = new Map<string, DOMRect>()
    contentRef.current?.querySelectorAll<HTMLElement>('[data-tile]').forEach(el => {
      map.set(el.dataset.tile!, el.getBoundingClientRect())
    })
    return map
  }

  const commitCols = useCallback(
    (newCols: number, residual: number, flip: boolean) => {
      const scroller = scrollerRef.current
      const old = layoutRef.current
      if (!scroller || newCols === old.cols || gridWidth <= 0) return
      const o = originRef.current
      const anchor = anchorAt(old, o.x, scroller.scrollTop + o.y)
      const next = buildLayout(keys, data, gridWidth, newCols)
      let top = scroller.scrollTop
      if (anchor) {
        const p = anchorContentPoint(next, anchor)
        if (p) top = p.y - o.y
      }
      top = clamp(top, 0, Math.max(0, next.height - scroller.clientHeight))
      pendingRef.current = {
        anchor,
        originY: o.y,
        scrollTop: top,
        residual,
        oldRects: flip ? captureRects() : null
      }
      setScrollTop(top)
      setCols(newCols)
      emitTileSize(newCols, gridWidth)
    },
    [keys, data, gridWidth, emitTileSize]
  )

  useLayoutEffect(() => {
    const pending = pendingRef.current
    const scroller = scrollerRef.current
    if (!pending || !scroller) return
    pendingRef.current = null
    scroller.scrollTop = pending.scrollTop
    setScale(pending.residual, false)
    const oldRects = pending.oldRects
    if (!oldRects) return
    const s = pending.residual
    const els = contentRef.current?.querySelectorAll<HTMLElement>('[data-tile]') ?? []
    els.forEach(el => {
      const before = oldRects.get(el.dataset.tile!)
      if (!before) {
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' })
        return
      }
      const after = el.getBoundingClientRect()
      if (after.width === 0) return
      const dx = (before.left - after.left) / s
      const dy = (before.top - after.top) / s
      const k = before.width / after.width
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(k - 1) < 0.01) return
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px) scale(${k})` }, { transform: 'translate(0, 0) scale(1)' }],
        { duration: 300, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
      )
    })
  })

  // ── Viewport size (keeps the top-left photo in place on resize) ──
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  const dataRef = useRef({ keys, data })
  dataRef.current = { keys, data }
  useLayoutEffect(() => {
    const outer = outerRef.current
    if (!outer) return
    const measure = (): void => {
      const scroller = scrollerRef.current
      const width = scroller ? scroller.clientWidth : outer.clientWidth
      const height = outer.clientHeight
      const prev = viewportRef.current
      if (prev.width === width && prev.height === height) return
      if (prev.width !== width && prev.width > 0 && scroller) {
        const old = layoutRef.current
        const newGridWidth = Math.max(1, width - PAD_X * 2)
        const anchor = anchorAt(old, PAD_X + 1, scroller.scrollTop + PAD_TOP)
        // Keep the same tile size; the column count adapts to the new width.
        const c = colsFor(newGridWidth, old.tile)
        const next = buildLayout(dataRef.current.keys, dataRef.current.data, newGridWidth, c)
        const p = anchor && anchorContentPoint(next, { ...anchor, fx: 0, fy: 0 })
        if (anchor && p) {
          const top = Math.max(0, p.y - PAD_TOP - (anchor.index === 0 ? HEADER_H : 0))
          pendingRef.current = { anchor, originY: 0, scrollTop: top, residual: 1, oldRects: null }
          setScrollTop(top)
        }
        setCols(c)
      }
      viewportRef.current = { width, height }
      setViewport({ width, height })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(outer)
    return () => ro.disconnect()
  }, [])

  // ── Scroll tracking (one state update per frame) ──
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    let raf = 0
    const onScroll = (): void => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        setScrollTop(el.scrollTop)
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(raf)
    }
  }, [])

  // ── Pinch / ctrl+wheel zoom ──
  const gesture = useRef({ active: false, raw: 1, endTimer: 0 as number | undefined, lastStep: 0, startedAtDensest: false, edgeNotches: 0 })

  const neighbours = useCallback((): { bigger?: number; denser?: number } => {
    const levels = levelsFor(gridWidth)
    const c = layoutRef.current.cols
    let bigger: number | undefined
    let denser: number | undefined
    for (const l of levels) {
      if (l < c) bigger = l
      else if (l > c && denser === undefined) denser = l
    }
    return { bigger, denser }
  }, [gridWidth])

  const pointerToLocal = (clientX: number, clientY: number): { x: number; y: number } => {
    const r = outerRef.current!.getBoundingClientRect()
    return { x: clientX - r.left, y: clientY - r.top }
  }

  const beginGesture = useCallback(
    (clientX: number, clientY: number) => {
      const g = gesture.current
      window.clearTimeout(g.endTimer)
      if (g.active) return
      g.active = true
      g.startedAtDensest = neighbours().denser === undefined
      const el = scrollerRef.current
      // If a settle animation is running, continue from the scale currently on screen.
      if (el && scaleRef.current !== 1) {
        const current = new DOMMatrix(getComputedStyle(el).transform === 'none' ? undefined : getComputedStyle(el).transform).a
        g.raw = current || 1
        setScale(g.raw, false)
      } else {
        g.raw = 1
        originRef.current = pointerToLocal(clientX, clientY)
      }
    },
    [setScale, neighbours]
  )

  const updateGesture = useCallback(
    (factor: number) => {
      const g = gesture.current
      g.raw = clamp(g.raw * factor, 0.3, 4)
      const tile = layoutRef.current.tile
      const visual = tile * g.raw
      const { bigger, denser } = neighbours()
      if (bigger !== undefined) {
        const tb = tileFor(gridWidth, bigger)
        if (visual > Math.sqrt(tile * tb)) {
          g.raw = visual / tb
          commitCols(bigger, g.raw, true)
          return
        }
      }
      if (denser !== undefined) {
        const td = tileFor(gridWidth, denser)
        if (visual < Math.sqrt(tile * td)) {
          g.raw = visual / td
          commitCols(denser, g.raw, true)
          return
        }
      }
      // Rubber-band at the ends.
      let shown = g.raw
      if (bigger === undefined && g.raw > 1) shown = 1 + Math.min(0.25, (g.raw - 1) * 0.35)
      if (denser === undefined && g.raw < 1) shown = 1 - Math.min(0.2, (1 - g.raw) * 0.35)
      setScale(shown, false)
    },
    [commitCols, gridWidth, neighbours, setScale]
  )

  const endGesture = useCallback(() => {
    const g = gesture.current
    if (!g.active) return
    g.active = false
    const { denser } = neighbours()
    // Only leave the grid if the pinch *started* at the densest level, so one long
    // pinch doesn't fly through every zoom level and out of the view.
    const pinchedPast = g.startedAtDensest && denser === undefined && g.raw < 0.8
    g.raw = 1
    setScale(1, true)
    if (pinchedPast) propsRef.current.onZoomOutBeyond()
  }, [neighbours, setScale])

  const stepZoom = useCallback(
    (dir: 'in' | 'out', clientX: number, clientY: number) => {
      const now = performance.now()
      const g = gesture.current
      if (now - g.lastStep < 160) return
      g.lastStep = now
      const { bigger, denser } = neighbours()
      originRef.current = pointerToLocal(clientX, clientY)
      const target = dir === 'in' ? bigger : denser
      if (target === undefined) {
        if (dir === 'out') {
          if (++g.edgeNotches >= 2) {
            g.edgeNotches = 0
            propsRef.current.onZoomOutBeyond()
          }
        } else {
          setScale(1.04, false)
          requestAnimationFrame(() => setScale(1, true))
        }
        return
      }
      g.edgeNotches = 0
      commitCols(target, 1, true)
    },
    [commitCols, neighbours, setScale]
  )

  const handlersRef = useRef({ beginGesture, updateGesture, endGesture, stepZoom })
  handlersRef.current = { beginGesture, updateGesture, endGesture, stepZoom }

  useEffect(() => {
    const outer = outerRef.current
    if (!outer) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const h = handlersRef.current
      // Mouse wheels send large integer line/notch deltas; trackpad pinch sends small fractional ones.
      const isNotch = e.deltaMode !== 0 || (Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY))
      if (isNotch) {
        h.stepZoom(e.deltaY > 0 ? 'out' : 'in', e.clientX, e.clientY)
        return
      }
      h.beginGesture(e.clientX, e.clientY)
      h.updateGesture(Math.exp(-clamp(e.deltaY, -25, 25) * 0.012))
      const g = gesture.current
      g.endTimer = window.setTimeout(() => handlersRef.current.endGesture(), 140)
    }

    // Touchscreen pinch
    const touches = new Map<number, { x: number; y: number }>()
    let lastDist = 0
    const dist = (): number => {
      const [a, b] = [...touches.values()]
      return Math.hypot(a.x - b.x, a.y - b.y)
    }
    const onPointerDown = (e: PointerEvent): void => {
      if (e.pointerType !== 'touch') return
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (touches.size === 2) {
        const [a, b] = [...touches.values()]
        handlersRef.current.beginGesture((a.x + b.x) / 2, (a.y + b.y) / 2)
        lastDist = dist()
      }
    }
    const onPointerMove = (e: PointerEvent): void => {
      if (!touches.has(e.pointerId)) return
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (touches.size === 2 && lastDist > 0) {
        const d = dist()
        handlersRef.current.updateGesture(d / lastDist)
        lastDist = d
      }
    }
    const onPointerUp = (e: PointerEvent): void => {
      if (!touches.delete(e.pointerId)) return
      if (touches.size < 2 && lastDist > 0) {
        lastDist = 0
        handlersRef.current.endGesture()
      }
    }

    outer.addEventListener('wheel', onWheel, { passive: false })
    outer.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    return () => {
      outer.removeEventListener('wheel', onWheel)
      outer.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      window.clearTimeout(gesture.current.endTimer)
    }
  }, [])

  // ── External "scroll to group" requests (e.g. clicking a year) ──
  const handledRequest = useRef<number | null>(null)
  useEffect(() => {
    const req = props.scrollRequest
    if (!req || gridWidth <= 0 || handledRequest.current === req.nonce) return
    handledRequest.current = req.nonce
    const s = layoutRef.current.sections.find(sec => sec.key === req.key)
    if (s) scrollerRef.current?.scrollTo({ top: Math.max(0, s.top - PAD_TOP), behavior: 'smooth' })
  }, [props.scrollRequest, gridWidth])

  // ── Visible range ──
  const overscan = viewport.height * 0.6 + layout.pitch
  const y0 = scrollTop - overscan
  const y1 = scrollTop + viewport.height + overscan
  const headers: React.ReactNode[] = []
  const tiles: React.ReactNode[] = []
  const visibleThumblessPaths: string[] = []
  if (gridWidth > 0) {
    for (let si = firstSectionAfter(layout.sections, y0); si < layout.sections.length; si++) {
      const s = layout.sections[si]
      if (s.top > y1) break
      if (s.top + HEADER_H > y0) {
        const allSel = s.files.length > 0 && s.files.every(f => selected.has(f.path))
        headers.push(
          <div key={'h:' + s.key} className="pg-header" style={{ top: s.top, left: PAD_X, right: PAD_X, height: HEADER_H }}>
            <div className="pg-header-title">{s.key}</div>
            <div className="pg-header-count">{s.files.length.toLocaleString()} items</div>
            <button
              className={'pg-header-select' + (allSel ? ' is-active' : '')}
              onClick={e => props.onGroupCheckboxClick(s.key, e)}
            >
              {allSel ? 'Deselect' : 'Select'}
            </button>
          </div>
        )
      }
      const r0 = clamp(Math.floor((y0 - s.rowsTop) / layout.pitch), 0, s.rows)
      const r1 = clamp(Math.floor((y1 - s.rowsTop) / layout.pitch), -1, s.rows - 1)
      const end = Math.min(s.files.length, (r1 + 1) * layout.cols)
      for (let i = r0 * layout.cols; i < end; i++) {
        const f = s.files[i]
        const p = tilePos(layout, s, i)
        if (!f.thumb) visibleThumblessPaths.push(f.path)
        tiles.push(
          <GridTile
            key={f.path}
            file={f}
            x={p.x}
            y={p.y}
            size={layout.tile}
            isSelected={selected.has(f.path)}
            isFav={favourites.has(f.path)}
            isDeleting={deletingPaths.has(f.path)}
            thumb={f.thumb}
            actions={actions}
            hoverPreviewsEnabled={hoverPreviewsEnabled}
          />
        )
      }
    }
  }

  // Bump thumbnail generation for whatever's on screen right now ahead of the
  // background backfill queue, instead of waiting for it to reach these files
  // in DB order. Debounced so fast scrolling doesn't spam IPC calls.
  const visibleThumblessKey = visibleThumblessPaths.join('|')
  useEffect(() => {
    if (!visibleThumblessKey) return
    const paths = visibleThumblessKey.split('|')
    const t = window.setTimeout(() => {
      window.api.prioritizeThumbnails(paths).catch(() => {})
    }, 250)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleThumblessKey])

  // Floating date pill: names the section under the top edge once its own header has scrolled away.
  const probe = layout.sections[firstSectionAfter(layout.sections, scrollTop + PAD_TOP)]
  const topSection = probe && probe.top < scrollTop - 4 ? probe : undefined

  return (
    <div ref={outerRef} className="pg-outer">
      <div ref={scrollerRef} className="pg-scroller">
        <div ref={contentRef} className="pg-content" style={{ height: layout.height }}>
          {headers}
          {tiles}
        </div>
      </div>
      {topSection && <div className="pg-date-pill">{topSection.key}</div>}
    </div>
  )
}
