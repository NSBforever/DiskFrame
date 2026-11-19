import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react'
import { useZoomPan } from './ZoomPanEngine'
import { useGestures } from './GestureEngine'
import { useShortcuts } from './ShortcutManager'
import { ImageLoader, VIEWER_ACTIVITY_EVENT } from './ImageLoader'
import { MediaViewerToolbar } from './MediaViewerToolbar'
import { MetadataPanel } from './MetadataPanel'
import { MapPin, ArrowLeft } from 'lucide-react'
import { useReducedMotionPref } from '../../hooks/useReducedMotionPref'
import {
  containFit,
  visibleFraction,
  provisionalBox,
  boxesDiffer,
  cubicBezier,
  flightFrame,
  flightFrames,
  type Box
} from '../../../../main/viewerGeometry'
import { mediaUrl } from '../../../../main/mediaUrl'
import { videoExts } from '../../../../main/validation'

const photoExts = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']

const OPEN_MS = 380
const CLOSE_MS = 320
const SETTLE_MS = 200
/** Fast out, long soft landing - the shape of the Photos zoom. */
const FLIGHT_EASE = cubicBezier(0.2, 0.85, 0.25, 1)

interface FlightState {
  thumb: string | null
  /** Width over height of the thumbnail file, when the tile had it decoded. */
  thumbAspect: number | null
  /** The full picture, layered over the thumbnail once it has decoded. */
  full: string | null
  fullReady?: boolean
}

/**
 * The thumbnail exactly as the tile is showing it: the same URL, so it comes
 * from memory already decoded and the flight's first frame has a picture in
 * it. The viewer's own URL for the same file is a different one (media:
 * rather than file:), which meant a fetch and a decode before anything flew.
 */
function tileThumb(path: string): { src: string; aspect: number } | null {
  const q = CSS.escape(path)
  const img = document.querySelector(`[data-tile="${q}"] img, [data-grid-tile="${q}"] img`) as HTMLImageElement | null
  if (!img || !img.complete || !img.naturalWidth || !img.naturalHeight) return null
  return { src: img.currentSrc || img.src, aspect: img.naturalWidth / img.naturalHeight }
}

function toUrl(p: string): string {
  return mediaUrl(p)
}
function toBox(r: { left: number; top: number; width: number; height: number }): Box {
  return { x: r.left, y: r.top, w: r.width, h: r.height }
}
function boxStyle(b: Box): { left: string; top: string; width: string; height: string } {
  return { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` }
}
/** Polls once per frame for up to `frames` frames. */
async function waitFor<T>(fn: () => T | null, frames: number): Promise<T | null> {
  for (let i = 0; i <= frames; i++) {
    const v = fn()
    if (v) return v
    await new Promise((r) => requestAnimationFrame(r))
  }
  return null
}

/**
 * The on-screen tile for a file, if one is genuinely visible - the grid's own
 * tile, or a Favourites/Trash/Timeline tile. A tile scrolled mostly out of
 * view, or not rendered at all because the grid is virtualised, is not a
 * place to fly to: the caller fades instead.
 */
export function findTileBox(path: string): Box | null {
  const q = CSS.escape(path)
  const el = document.querySelector(`[data-tile="${q}"], [data-grid-tile="${q}"]`) as HTMLElement | null
  if (!el) return null
  const b = toBox(el.getBoundingClientRect())
  return visibleFraction(b, { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }) >= 0.6 ? b : null
}

interface ScannedFile {
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
  /** The row's own volume: media URLs name it, so another volume's file at the same path is never shown. */
  volume_id?: string | null
}

interface MediaViewerProps {
  file: ScannedFile
  list: ScannedFile[]
  isFav: boolean
  onFav: (file: ScannedFile) => void
  onReveal: (file: ScannedFile) => void
  onClose: () => void
  onNext: () => void
  onPrev: () => void
  onDelete: (file: ScannedFile) => void
  rect?: DOMRect
}

export const SHORTCUT_HELP: [string, string][] = [
  ['Space / K', 'Play or pause'],
  ['J / L', 'Back / forward 10s'],
  ['Left / Right', 'Back / forward 5s'],
  ['Shift + Left / Right', 'Back / forward 10s'],
  ['Ctrl + Left / Right', 'Previous / next video'],
  ['Up / Down', 'Volume'],
  ['M', 'Mute'],
  ['Shift + P / N', 'Previous / next file'],
  ['0 / Home', 'Seek to start'],
  ['1 - 9', 'Seek to 10-90%'],
  ['F', 'Fullscreen'],
  ['T', 'Theatre mode'],
  ['C', 'Subtitles'],
  ['+ / -', 'Subtitle size'],
  ['W / O', 'Subtitle background / colour'],
  ['Shift + . / ,', 'Playback speed'],
  ['. / ,', 'Frame step (paused)'],
  ['Ctrl + L', 'Favourite'],
  ['Photo: + / -', 'Zoom in / out'],
  ['Photo: 0 / 1', 'Fit to window / actual size (100%)'],
  ['Photo: double-click', 'Zoom in at the pointer, or back to fit'],
  ['Photo: wheel, drag', 'Zoom at the pointer, pan'],
  ['?', 'This help'],
  ['Escape', 'Close viewer']
]

const MediaViewer: React.FC<MediaViewerProps> = ({
  file,
  list,
  isFav,
  onFav,
  onReveal,
  onClose,
  onNext,
  onPrev,
  onDelete,
  rect
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  // The box the image is actually centred in. It narrows when the Info panel
  // opens, so zoom anchoring and pan bounds must measure THIS, not the viewer
  // root - anchoring against the root put every zoom 160px off with Info open.
  const stageRef = useRef<HTMLDivElement>(null)
  // Theatre hides the viewer's own chrome and gives the stage the whole
  // window; for video the mpv bounds follow the stage, so it genuinely
  // enlarges rather than just hiding buttons.
  const [isTheatre, setIsTheatre] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const showHelpRef = useRef(false)
  showHelpRef.current = showHelp
  const isPhoto = photoExts.includes(file.ext.toLowerCase())
  const isVideo = videoExts.includes(file.ext.toLowerCase())
  const [imgDimensions, setImgDimensions] = useState<{ width: number; height: number } | null>(null)
  // mpv restates the frame size on every position tick. A fresh object each
  // time re-rendered the whole viewer several times a second during playback
  // and restarted the Info panel's metadata load; an unchanged size is kept.
  const handleImageLoaded = useCallback((d: { width: number; height: number }) => {
    setImgDimensions((p) => (p && p.width === d.width && p.height === d.height ? p : d))
  }, [])
  const [rotation, setRotation] = useState(0)
  const [flipHorizontal, setFlipHorizontal] = useState(false)
  const rotationRef = useRef(rotation)
  rotationRef.current = rotation
  const flipRef = useRef(flipHorizontal)
  flipRef.current = flipHorizontal
  const [isInfoOpen, setIsInfoOpen] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // ── Open / close transition ──
  //
  // A shared-element transition, like Photos: a "flight" element starts on
  // the exact rectangle of the tile that was clicked, showing its thumbnail
  // cropped as the tile shows it, and grows into the rectangle the media
  // really occupies in the viewer - measured from the laid-out viewer itself,
  // not computed separately - so the crop opens out to the whole picture.
  // The viewer's own content stays invisible until the flight lands on it.
  // Closing runs it back to the tile of whatever file is open now; with no
  // such tile on screen (scrolled away, another view) it fades in place
  // instead of flying to a guess. Reduced motion: a short fade, no flight.
  const reducedMotion = useReducedMotionPref()
  // Read once, at the first render: the tile is still exactly as it was clicked.
  const [startTile] = useState(() => tileThumb(file.path))
  const startThumb = startTile?.src ?? (file.thumb ? toUrl(file.thumb) : null)
  const canFly = !!rect && !!startThumb && (isPhoto || isVideo) && !reducedMotion
  const [phase, setPhase] = useState<'opening' | 'open' | 'closing'>(canFly ? 'opening' : 'open')
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const [flight, setFlight] = useState<FlightState | null>(() =>
    canFly && rect
      ? { thumb: startThumb, thumbAspect: startTile?.aspect ?? null, full: isPhoto ? mediaUrl(file.path, file.volume_id) : null }
      : null
  )
  // The flight is two nested elements moved with transforms only: the outer
  // one clips, the inner one holds the picture. See viewerGeometry.flightFrame.
  const flightRef = useRef<HTMLDivElement>(null)
  const flightInnerRef = useRef<HTMLDivElement>(null)
  /** The rectangle the flight element is laid out at; its transforms are relative to it. */
  const restRef = useRef<Box | null>(rect ? toBox(rect) : null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const flightAnimRef = useRef<Animation[]>([])
  /** Resolves when the flight now in the air lands; null while nothing is moving. */
  const flyingRef = useRef<Promise<void> | null>(null)
  const openTokenRef = useRef({ cancelled: false })
  const pendingCloseRef = useRef<{ from: Box; to: Box; rest: Box } | null>(null)
  const [videoRevealed, setVideoRevealed] = useState(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const fileRef = useRef(file)
  fileRef.current = file
  const dimsRef = useRef<{ width: number; height: number } | null>(null)

  const lastMouseMoveRef = useRef(Date.now())

  // Zoom & Pan physics engine
  const {
    scale,
    translateX,
    translateY,
    zoomTo,
    panBy,
    reset,
    isDraggingRef,
    lastMousePosRef,
    velocityRef,
    lastTimeRef,
    getFitScale,
    clampToBounds,
    startInertia
  } = useZoomPan(stageRef, imgDimensions)

  dimsRef.current = imgDimensions

  /** The media's real rectangle on screen right now, or null while unknown. */
  const mediaBox = useCallback((): Box | null => {
    const stage = stageRef.current
    if (!stage) return null
    const el = stage.querySelector('[data-viewer-media]') as HTMLElement | null
    if (el) {
      const r = el.getBoundingClientRect()
      if (r.width > 4 && r.height > 4) return toBox(r)
    }
    // mpv draws in its own window, centred in the stage: the frame size it
    // reports is what decides the rectangle.
    const f = fileRef.current
    if (videoExts.includes(f.ext.toLowerCase()) && dimsRef.current) {
      return containFit(dimsRef.current, toBox(stage.getBoundingClientRect()), true)
    }
    return null
  }, [])

  const cancelFlight = useCallback((): void => {
    for (const a of flightAnimRef.current) a.cancel()
    flightAnimRef.current = []
  }, [])
  /** Lays the flight element out at `rest` and shows it at `box`. Layout is
   *  only ever written here, between flights - never during one. */
  const placeFlight = useCallback(
    (rest: Box, box: Box): void => {
      const outer = flightRef.current
      const inner = flightInnerRef.current
      if (!outer || !inner) return
      cancelFlight()
      restRef.current = rest
      Object.assign(outer.style, boxStyle(rest))
      const f = flightFrame(box, rest)
      outer.style.transform = f.outer
      inner.style.transform = f.inner
    },
    [cancelFlight]
  )
  /** Moves the flight from one rectangle to another; resolves when it lands
   *  or is interrupted. Transforms only, on two elements started together, so
   *  the browser runs the whole flight off the main thread - the viewer
   *  mounting, or a 24 MP photo decoding, no longer shows up as a stutter. */
  const fly = useCallback(
    (from: Box, to: Box, ms: number): Promise<void> => {
      const outer = flightRef.current
      const inner = flightInnerRef.current
      const rest = restRef.current
      if (!outer || !inner || !rest) return Promise.resolve()
      cancelFlight()
      const end = flightFrame(to, rest)
      outer.style.transform = end.outer
      inner.style.transform = end.inner
      if (ms <= 0) return Promise.resolve()
      const frames = flightFrames(from, to, rest, FLIGHT_EASE)
      const timing = { duration: ms, easing: 'linear' } as const
      const a = outer.animate(
        frames.map((f) => ({ transform: f.outer })),
        timing
      )
      const b = inner.animate(
        frames.map((f) => ({ transform: f.inner })),
        timing
      )
      flightAnimRef.current = [a, b]
      const landed = a.finished.then(
        () => undefined,
        () => undefined
      )
      flyingRef.current = landed
      void landed.then(() => {
        if (flyingRef.current === landed) flyingRef.current = null
      })
      return landed
    },
    [cancelFlight]
  )
  const flightBox = (): Box | null => (flightRef.current ? toBox(flightRef.current.getBoundingClientRect()) : null)

  // The first frame: the flight sits exactly on the tile, showing the tile's crop.
  useLayoutEffect(() => {
    if (phaseRef.current === 'opening' && rect) placeFlight(toBox(rect), toBox(rect))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The tile whose picture is in the viewer is hidden while it is there: the
  // picture has left the grid, so there must not be a second copy behind the
  // flight as it lifts off, nor one waiting where it lands. A style rule
  // rather than a class, so it survives the grid re-rendering that tile.
  useLayoutEffect(() => {
    const style = document.createElement('style')
    const q = CSS.escape(file.path)
    style.textContent = `[data-tile="${q}"] .pg-tile-inner, [data-grid-tile="${q}"] > * { visibility: hidden !important; }`
    document.head.appendChild(style)
    return () => style.remove()
  }, [file.path])

  // Opening: on mount only. Every await checks the token, so a close, a
  // next/previous or a resize during the flight takes over cleanly.
  useEffect(() => {
    if (phaseRef.current !== 'opening' || !rect) {
      containerRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: reducedMotion ? 120 : 180,
        easing: 'ease-out'
      })
      return
    }
    const token = { cancelled: false }
    openTokenRef.current = token
    backdropRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS, easing: 'ease-out' })
    void (async () => {
      const start = toBox(rect)
      const stage = stageRef.current ? toBox(stageRef.current.getBoundingClientRect()) : start
      // Where the picture will sit, from the thumbnail's own shape: known at
      // once, so the flight leaves on the click instead of waiting for the
      // original to decode. A thumbnail from before thumbnails kept their
      // shape is square whatever the picture is; for those the photo's size
      // is waited for briefly (it is usually known within a few frames).
      const aspect = startTile?.aspect ?? null
      const shaped = aspect !== null && Math.abs(aspect - 1) > 0.02
      let target = shaped ? null : await waitFor(mediaBox, 8)
      if (token.cancelled) return
      const firstLeg =
        target ?? (shaped && aspect ? containFit({ width: aspect * 1000, height: 1000 }, stage, true) : provisionalBox(stage))
      placeFlight(firstLeg, start)
      await fly(start, firstLeg, OPEN_MS)
      if (token.cancelled) return
      /** Re-lays the flight out on the real rectangle and moves it there. */
      const settle = async (to: Box): Promise<void> => {
        const from = flightBox() ?? firstLeg
        placeFlight(to, from)
        await fly(from, to, SETTLE_MS)
      }
      if (!target) {
        // Landed on a guess (a video's size arrives from mpv, a small photo
        // is not enlarged past its own size): settle onto the real rectangle
        // as soon as it is known.
        target = await waitFor(mediaBox, 120)
        if (token.cancelled) return
        if (target && boxesDiffer(target, firstLeg)) await settle(target)
      } else {
        const now = mediaBox()
        if (now && boxesDiffer(now, target)) await settle(now)
      }
      if (token.cancelled) return
      setPhase('open')
      // A photo is now drawn by the viewer itself, pixel for pixel where the
      // flight is; drop the flight once that frame has been painted. A video
      // keeps its poster until the player is on screen (see below).
      if (!videoExts.includes(fileRef.current.ext.toLowerCase())) {
        requestAnimationFrame(() => requestAnimationFrame(() => setFlight(null)))
      }
    })()
    return () => {
      token.cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The video's player is on screen: its poster can go.
  useEffect(() => {
    if (phase !== 'open' || !videoRevealed || !flight) return
    const t = window.setTimeout(() => setFlight(null), 120)
    return () => window.clearTimeout(t)
  }, [phase, videoRevealed, flight])
  const handleVideoRevealed = useCallback(() => setVideoRevealed(true), [])

  // Moving to another file, or the window changing size, mid-flight: the
  // flight's destination no longer exists. Finish at once rather than land
  // somewhere wrong.
  const finishOpeningNow = useCallback(() => {
    if (phaseRef.current !== 'opening') return
    openTokenRef.current.cancelled = true
    cancelFlight()
    setPhase('open')
    setFlight(null)
  }, [cancelFlight])
  const openedPathRef = useRef(file.path)
  useEffect(() => {
    if (file.path === openedPathRef.current) return
    openedPathRef.current = file.path
    setVideoRevealed(false)
    finishOpeningNow()
  }, [file.path, finishOpeningNow])

  const handleClose = useCallback(() => {
    if (phaseRef.current === 'closing') return
    openTokenRef.current.cancelled = true
    const f = fileRef.current
    const isVid = videoExts.includes(f.ext.toLowerCase())
    // From wherever the picture is now: mid-flight, or where the viewer shows it.
    const midFlight = !!flightRef.current
    const from = flightBox() ?? mediaBox()
    const to = findTileBox(f.path)
    const tile = tileThumb(f.path)
    const thumb = tile?.src ?? (f.thumb ? toUrl(f.thumb) : null)
    // What the flight is laid out at: the picture's fitted rectangle, even
    // when it is zoomed in right now - a zoomed picture can be many screens
    // wide, and that is not a size to lay an element out at.
    const stage = stageRef.current ? toBox(stageRef.current.getBoundingClientRect()) : null
    const fitted = stage && dimsRef.current ? containFit(dimsRef.current, stage, isVid) : null
    const rest = midFlight && restRef.current ? restRef.current : (fitted ?? from)
    // A rotated or mirrored picture has no tile-shaped crop to fly back to.
    const turned = rotationRef.current % 360 !== 0 || flipRef.current
    phaseRef.current = 'closing'
    setPhase('closing')
    // The native player sits above everything in this window; it has to be
    // gone before the flight can be seen, and its sound with it.
    if (isVid) window.api.closeMpv()
    const done = (): void => onCloseRef.current()
    if (reducedMotion || !from || !to || !thumb || !rest || turned) {
      setFlight(null)
      cancelFlight()
      const a = containerRef.current?.animate(
        [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: reducedMotion ? 'scale(1)' : 'scale(0.985)' }],
        { duration: reducedMotion ? 120 : 200, easing: 'ease-in', fill: 'forwards' }
      )
      if (a) a.finished.then(done, done)
      else done()
      return
    }
    pendingCloseRef.current = { from, to, rest }
    setFlight((prev) => ({
      thumb,
      thumbAspect: tile?.aspect ?? null,
      // Photos close with the full picture, already in memory, so nothing
      // drops in quality on the way back; at the tile it is cropped exactly as
      // the thumbnail is.
      full: isVid ? null : mediaUrl(f.path, f.volume_id),
      fullReady: prev?.full === mediaUrl(f.path, f.volume_id) ? prev?.fullReady : undefined
    }))
  }, [mediaBox, reducedMotion, cancelFlight])

  // Runs the close once its flight element exists (it may have just been created).
  useLayoutEffect(() => {
    const pending = pendingCloseRef.current
    if (phase !== 'closing' || !pending || !flightRef.current) return
    pendingCloseRef.current = null
    const done = (): void => onCloseRef.current()
    backdropRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CLOSE_MS, easing: 'ease-in', fill: 'forwards' })
    placeFlight(pending.rest, pending.from)
    void fly(pending.from, pending.to, CLOSE_MS).then(done)
  }, [phase, flight, fly, placeFlight])

  // A resize mid-transition: land immediately (opening) or finish (closing).
  useEffect(() => {
    const onResize = (): void => {
      if (phaseRef.current === 'opening') finishOpeningNow()
      else if (phaseRef.current === 'closing') {
        for (const a of flightAnimRef.current) a.finish()
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [finishOpeningNow])
  const handleCloseRef = useRef(handleClose)
  handleCloseRef.current = handleClose

  // Window resize, Info panel opening, entering fullscreen: the stage changes
  // size, so a fitted image refits for free (scale is a fit multiplier) and a
  // zoomed one is pulled back inside the new bounds instead of being stranded
  // outside them. ResizeObserver rather than a window listener, because the
  // Info panel resizes the stage without resizing the window.
  useEffect(() => {
    const el = stageRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => clampToBounds())
    ro.observe(el)
    return () => ro.disconnect()
  }, [clampToBounds])

  // The overlay draws the only chrome that is visible over the video, so
  // it needs the filename and favourite state pushed to it.
  const listIndex = list.indexOf(file)
  const hasPrev = listIndex > 0
  const hasNext = listIndex >= 0 && listIndex < list.length - 1
  useEffect(() => {
    window.api.setOverlayMeta?.({ name: file.name, isFav, hasPrev, hasNext, fullscreen: isFullscreen, info: isInfoOpen })
  }, [file.name, isFav, hasPrev, hasNext, isFullscreen, isInfoOpen])

  // Reset transforms when image file changes
  useEffect(() => {
    reset()
    setRotation(0)
    setFlipHorizontal(false)
    setImgDimensions(null)
  }, [file.path, reset])

  const handleNext = useCallback(() => {
    reset()
    onNext()
  }, [onNext, reset])

  const handlePrev = useCallback(() => {
    reset()
    onPrev()
  }, [onPrev, reset])

  const handleFirst = useCallback(() => {
    reset()
  }, [reset])

  const handleLast = useCallback(() => {
    reset()
  }, [reset])

  // Gestures Engine
  const { swipeOffset } = useGestures({
    containerRef,
    scale,
    zoomTo,
    panBy,
    reset,
    isDraggingRef,
    lastMousePosRef,
    velocityRef,
    lastTimeRef,
    startInertia,
    onNext: handleNext,
    onPrev: handlePrev
  })


  // F, the overlay's button, the fallback player's button: the WINDOW goes full
  // screen (not an element, via the HTML API), so the taskbar really goes and
  // mpv's video window can cover the display. It lasts while the viewer is
  // open; closing hands the window back to the app's own setting.
  const isFullscreenRef = useRef(false)
  isFullscreenRef.current = isFullscreen
  const handleToggleFullscreen = useCallback(() => {
    const next = !isFullscreenRef.current
    setIsFullscreen(next)
    void window.api.setViewerFullscreen(next).then(setIsFullscreen)
  }, [])
  useEffect(() => {
    let live = true
    void window.api.getWindowFullscreen().then((on) => live && setIsFullscreen(on))
    const off = window.api.onWindowFullscreenChanged((on) => setIsFullscreen(on)) // F11 while viewing
    return () => {
      live = false
      off()
      void window.api.setViewerFullscreen(null)
    }
  }, [])

  // Clicks and key presses inside the mpv-window overlay arrive here, so a
  // single place decides what each action means regardless of which window
  // had focus. Key presses are replayed as one synthetic keydown, which keeps
  // exactly one handler per press instead of Electron, React and the overlay
  // each acting on it.
  useEffect(() => {
    if (!window.api.onOverlayAction) return
    return window.api.onOverlayAction((action: string) => {
      if (action === 'prev') return handlePrev()
      if (action === 'next') return handleNext()
      if (action === 'fullscreen') return handleToggleFullscreen()
      if (action === 'close') return handleClose()
      if (action === 'fav') return onFav(file)
      if (action === 'info') return setIsInfoOpen((o) => !o)
      if (action === "reveal") return onReveal(file)
      if (action === 'copyPath') return handleCopyPath()
      if (action === 'download') return handleDownload()
      if (action === 'delete') return handleDelete()
      if (action.startsWith('key:')) {
        const [, key, ...mods] = action.split(':')
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key,
            shiftKey: mods.includes('shift'),
            ctrlKey: mods.includes('ctrl'),
            bubbles: true
          })
        )
      }
    })
  }, [handleNext, handlePrev, handleToggleFullscreen, handleClose, onFav, onReveal, file])

  // Auto-hide the viewer chrome over a fullscreen video only.
  //
  // Two bugs lived here. It hid the chrome for *any* fullscreen file, so a
  // photo or PDF lost its toolbar after two idle seconds. And it woke only on
  // DOM mousemove - but mpv paints on a native child window, so moving the
  // mouse over a playing video produces no DOM event at all. The chrome
  // vanished two seconds in and there was no gesture that could bring it back
  // short of leaving fullscreen. ImageLoader re-broadcasts mpv's own mouse-pos
  // as VIEWER_ACTIVITY_EVENT; listening for it is what makes the video surface
  // count as activity.
  useEffect(() => {
    if (!isFullscreen || !isVideo) {
      setControlsVisible(true)
      return
    }

    const wake = (): void => {
      setControlsVisible(true)
      lastMouseMoveRef.current = Date.now()
    }
    wake()

    window.addEventListener('mousemove', wake)
    window.addEventListener(VIEWER_ACTIVITY_EVENT, wake)

    const interval = setInterval(() => {
      if (Date.now() - lastMouseMoveRef.current > 3000) {
        setControlsVisible(false)
      }
    }, 500)

    return () => {
      window.removeEventListener('mousemove', wake)
      window.removeEventListener(VIEWER_ACTIVITY_EVENT, wake)
      clearInterval(interval)
    }
    // file.path: a new file starts its own idle window rather than inheriting
    // whatever was left of the previous one.
  }, [isFullscreen, isVideo, file.path])

  // Escape key down listener - one press closes the viewer and returns to the
  // gallery at its previous scroll position, exiting fullscreen as part of
  // that same action rather than requiring a second press.
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showHelpRef.current) {
        setShowHelp(false)
        e.preventDefault()
        return
      }
      if (e.key === 'Escape') {
        const active = document.activeElement
        if (
          active &&
          (active.tagName === 'INPUT' ||
            active.tagName === 'TEXTAREA' ||
            active.getAttribute('contenteditable') === 'true')
        ) {
          return // Let the active input element handle the Escape press internally
        }
        handleClose() // and the window returns to the app's own full-screen setting
      }
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [handleClose])

  // Keybind manager
  useShortcuts({
    onNext: handleNext,
    onPrev: handlePrev,
    onFirst: handleFirst,
    onLast: handleLast,
    onZoomIn: () => zoomTo(scale + 0.5),
    onZoomOut: () => zoomTo(scale - 0.5),
    onZoomReset: reset,
    onActualSize: isPhoto ? () => handleActualSize() : undefined,
    onToggleFullscreen: handleToggleFullscreen,
    isOpen: true
  })

  const handleRotateLeft = () => {
    setRotation((r) => (r - 90 + 360) % 360)
  }

  const handleRotateRight = () => {
    setRotation((r) => (r + 90) % 360)
  }

  const handleFlip = () => {
    setFlipHorizontal((f) => !f)
  }

  const handleZoomChange = (newScale: number) => {
    zoomTo(newScale)
  }

  // `scale` is a multiplier over the fitted size, so scale 1 IS Fit and the
  // true magnification is scale * fitScale. Everything user-facing below
  // converts between the two rather than pretending they are the same.
  const fitScale = getFitScale()
  const displayPercent = Math.round(scale * fitScale * 100)

  /** Whole image, original aspect, never cropped. */
  const handleFit = () => reset()

  /** One image pixel per screen pixel. */
  const handleActualSize = () => zoomTo(1 / (fitScale || 1))

  const handleDownload = () => {
    const a = document.createElement('a')
    a.href = mediaUrl(file.path, file.volume_id)
    a.download = file.name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  const handleCopyPath = () => {
    navigator.clipboard.writeText(file.path)
  }

  const handleDelete = () => {
    setShowDeleteConfirm(true)
  }

  // The app trashes it, takes it out of the gallery, and moves this viewer on
  // to the next file (or closes it when none is left) - one code path for the
  // grid's menu, multi-select and here. A failure is reported there too.
  const confirmDelete = (): void => {
    setShowDeleteConfirm(false)
    onDelete(file)
  }

  // On the viewer's root, not the stage: a press on the picture captures the
  // pointer to the root (see GestureEngine), and the browser then delivers
  // click and dblclick to the capturing element. A handler on the stage never
  // ran, so double-click zoom did nothing at all.
  const handleDoubleClick = (e: React.MouseEvent) => {
    if (!isPhoto || phase !== 'open') return
    if ((e.target as HTMLElement).closest('button, input, select, .media-viewer-controls, .slide-nav-btn, [data-no-drag]')) return
    if (scale > 1.01) {
      reset()
      return
    }
    // Land on 1:1 where that is a real magnification, otherwise a plain 2x.
    // Jumping to a fixed 3x made the step depend on the image's size rather
    // than on anything the viewer could see.
    const target = fitScale > 0 && fitScale < 0.5 ? 1 / fitScale : 2
    zoomTo(target, e.clientX, e.clientY)
  }

  // The stage shows the media itself; while a flight is in the air the flight
  // is the media, and the stage stays invisible so there is never two of it.
  const stageHidden = phase === 'opening' || (phase === 'closing' && !!flight)
  // A video playing in mpv has exactly one set of controls: the overlay inside
  // mpv's own window. This window's chrome used to render under it too, and
  // showed on its own - an older player, for a moment - while mpv was still
  // starting hidden. It is drawn for videos only when this window IS the
  // player (the fallback <video>) or there is nothing playing (an error).
  const [player, setPlayer] = useState<{ mode: 'native' | 'stream' | 'mpv' | null; error: boolean }>({ mode: null, error: false })
  const mpvOwnsChrome = isVideo && !player.error && player.mode !== 'native' && player.mode !== 'stream'
  const chromeOn = controlsVisible && phase === 'open' && !mpvOwnsChrome

  // mpv's overlay lets clicks fall through to this window while its bar is
  // hidden, and was meant to hear the mouse through Electron's "forward" mode
  // - which delivered nothing, so after the first idle fade the bar never came
  // back and Info (or any control) could not be clicked again: the click went
  // through to this window. The moves do arrive here, so they are relayed: the
  // bar wakes, takes clicks, and fades again when the mouse rests.
  useEffect(() => {
    if (!isVideo || player.mode !== 'mpv') return
    let last = 0
    let at = ''
    const wake = (e: MouseEvent): void => {
      // Only real movement. Windows sends a mouse-move without one whenever the
      // window under a resting pointer changes - which is what the overlay does
      // each time it hides - and answering it kept the bar up forever.
      const pos = e.screenX + ',' + e.screenY
      if (pos === at) return
      at = pos
      const now = performance.now()
      if (now - last < 120) return
      last = now
      window.api.setOverlayMeta?.({ show: true })
    }
    window.addEventListener('mousemove', wake, { passive: true })
    return () => window.removeEventListener('mousemove', wake)
  }, [isVideo, player.mode])

  return (
    <div
      ref={containerRef}
      onDoubleClick={handleDoubleClick}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        userSelect: 'none'
      }}
    >
      {/* The backdrop is its own layer, so it can fade without fading the
          flight that sits above it. */}
      <div ref={backdropRef} style={{ position: 'absolute', inset: 0, background: 'rgba(10, 10, 12, 0.98)', pointerEvents: 'none' }} />
      {/* Top-Left Back / Close Button */}
      {chromeOn && (
        <button
          onClick={handleClose}
          className="media-viewer-back-btn"
          title="Back to Grid (Esc)"
          style={{
            position: 'absolute',
            top: '16px',
            left: '16px',
            zIndex: 1100,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 14px',
            borderRadius: '4px',
            background: 'rgba(10, 10, 12, 0.85)',
            backdropFilter: 'blur(16px)',
            border: '1px solid rgba(225, 29, 46, 0.4)',
            color: 'var(--app-fg, #f2f2f0)',
            fontSize: '12px',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)',
            userSelect: 'none'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(225, 29, 46, 0.15)'
            e.currentTarget.style.borderColor = '#e11d2e'
            e.currentTarget.style.color = '#ffffff'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(10, 10, 12, 0.85)'
            e.currentTarget.style.borderColor = 'rgba(225, 29, 46, 0.4)'
            e.currentTarget.style.color = 'var(--app-fg, #f2f2f0)'
          }}
        >
          <ArrowLeft size={16} color="#e11d2e" />
          <span>Back</span>
        </button>
      )}

      {/* Top toolbar. Hidden in theatre mode, and for video the real chrome is
          the overlay inside the mpv window - this one is never visible there. */}
      {chromeOn && !isTheatre && (
        <MediaViewerToolbar
          isVideo={isVideo}
          fileName={file.name}
          filePath={file.path}
          isFav={isFav}
          onFav={() => onFav(file)}
          onReveal={() => onReveal(file)}
          onClose={handleClose}
          onRotateLeft={handleRotateLeft}
          onRotateRight={handleRotateRight}
          onFlip={handleFlip}
          scale={scale}
          onZoomChange={handleZoomChange}
          onFit={handleFit}
          onActualSize={handleActualSize}
          displayPercent={displayPercent}
          fitScale={fitScale}
          onDownload={handleDownload}
          onCopyPath={handleCopyPath}
          onDelete={handleDelete}
          onToggleInfo={() => setIsInfoOpen((o) => !o)}
          isInfoOpen={isInfoOpen}
        />
      )}

      {/* Slide Navigation Left */}
      {chromeOn && list.indexOf(file) > 0 && (
        <div
          onClick={handlePrev}
          className="slide-nav-btn"
          style={{
            position: 'absolute',
            left: '16px',
            top: '50%',
            transform: 'translateY(-50%)',
            width: '44px',
            height: '44px',
            borderRadius: '4px',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            fontSize: '24px',
            color: 'var(--app-fg, #f2f2f0)',
            zIndex: 100,
            backdropFilter: 'blur(12px)',
            transition: 'transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1), border-color 0.2s, background-color 0.2s'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.08)'
            e.currentTarget.style.borderColor = '#e11d2e'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.04)'
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)'
            e.currentTarget.style.transform = 'translateY(-50%) scale(1)'
          }}
          onMouseDown={(e) => {
            if (e.button === 0) e.currentTarget.style.transform = 'translateY(-50%) scale(0.9)'
          }}
          onMouseUp={(e) => {
            if (e.button === 0) e.currentTarget.style.transform = 'translateY(-50%) scale(1.05)'
          }}
        >
          ‹
        </div>
      )}

      {/* Slide Navigation Right */}
      {chromeOn && list.indexOf(file) < list.length - 1 && (
        <div
          onClick={handleNext}
          className="slide-nav-btn"
          style={{
            position: 'absolute',
            right: '16px',
            top: '50%',
            transform: 'translateY(-50%)',
            width: '44px',
            height: '44px',
            borderRadius: '4px',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            fontSize: '24px',
            color: 'var(--app-fg, #f2f2f0)',
            zIndex: 100,
            backdropFilter: 'blur(12px)',
            transition: 'transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1), border-color 0.2s, background-color 0.2s'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.08)'
            e.currentTarget.style.borderColor = '#e11d2e'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.04)'
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)'
            e.currentTarget.style.transform = 'translateY(-50%) scale(1)'
          }}
          onMouseDown={(e) => {
            if (e.button === 0) e.currentTarget.style.transform = 'translateY(-50%) scale(0.9)'
          }}
          onMouseUp={(e) => {
            if (e.button === 0) e.currentTarget.style.transform = 'translateY(-50%) scale(1.05)'
          }}
        >
          ›
        </div>
      )}

      {/* Main Image View Container */}
      <div
        ref={stageRef}
        style={{
          width: isInfoOpen && phase === 'open' ? 'calc(100% - 320px)' : '100%',
          // The root centres its children, so a narrowed stage used to sit
          // in the middle: 160px of empty space on the left and its right
          // edge 160px under the Info panel. mpv's window follows the stage
          // and always paints above the page, so for a video that covered
          // half of the Info panel. Pinned left, the stage ends where the
          // panel begins.
          marginRight: 'auto',
          opacity: stageHidden ? 0 : 1,
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transform: `translateX(${swipeOffset}px)`,
          transition: swipeOffset === 0 ? 'width 0.3s cubic-bezier(0.22, 1, 0.36, 1)' : 'none'
        }}
      >
        <ImageLoader
          onFav={onFav}
          onShowHelp={() => setShowHelp(true)}
          onToggleTheatre={() => setIsTheatre((t) => !t)}
          onToggleFullscreen={handleToggleFullscreen}
          isFullscreen={isFullscreen}
          onPlayerChange={setPlayer}
          file={file}
          list={list}
          rotation={rotation}
          flipHorizontal={flipHorizontal}
          scale={scale}
          translateX={translateX}
          translateY={translateY}
          onImageLoaded={handleImageLoaded}
          onNext={handleNext}
          onPrev={handlePrev}
          isClosing={phase === 'closing'}
          holdVideo={phase === 'opening'}
          onVideoRevealed={handleVideoRevealed}
        />
      </div>

      {/* EXIF Metadata Right Panel */}
      <MetadataPanel
        file={file}
        isOpen={isInfoOpen && phase === 'open'}
        onClose={() => setIsInfoOpen(false)}
        naturalDimensions={imgDimensions}
      />

      {/* Bottom Bar Info Overlay */}
      {chromeOn && !isInfoOpen && isPhoto && (
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            padding: '16px 20px',
            background: 'linear-gradient(to top, rgba(10,10,12,0.9) 0%, rgba(10,10,12,0.3) 70%, transparent 100%)',
            display: 'flex',
            alignItems: 'center',
            gap: '24px',
            fontSize: '11px',
            color: 'var(--app-fg-dim, #8a8a8f)',
            zIndex: 10,
            pointerEvents: 'none'
          }}
        >
          <span>{file.date ? new Date(file.date).toLocaleDateString() : ''}</span>
          <span>{(file.size / 1024 / 1024).toFixed(1)} MB</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {file.path}
          </span>
          {file.lat && file.lng && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <MapPin size={12} color="#e11d2e" /> {file.lat.toFixed(3)}, {file.lng.toFixed(3)}
            </span>
          )}
        </div>
      )}

      {/* Video Details Top-Left Overlay */}
      {chromeOn && !isInfoOpen && isVideo && (
        <div
          style={{
            position: 'absolute',
            top: '64px',
            left: '20px',
            background: 'rgba(10, 10, 12, 0.75)',
            backdropFilter: 'blur(8px)',
            borderRadius: '4px',
            border: '1px solid rgba(255,255,255,0.06)',
            padding: '10px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            fontSize: '11px',
            color: 'var(--app-fg-dim, #8a8a8f)',
            zIndex: 100,
            maxWidth: '300px',
            pointerEvents: 'none',
            boxSizing: 'border-box'
          }}
        >
          <span style={{ color: '#ffffff', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={file.name}>
            {file.name}
          </span>
          <span>{file.date ? new Date(file.date).toLocaleDateString() : ''}</span>
          <span>{(file.size / 1024 / 1024).toFixed(1)} MB</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={file.path}>
            {file.path}
          </span>
          {file.lat && file.lng && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <MapPin size={12} color="#e11d2e" /> {file.lat.toFixed(3)}, {file.lng.toFixed(3)}
            </span>
          )}
        </div>
      )}

      {showHelp && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Keyboard shortcuts"
          onClick={() => setShowHelp(false)}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 3000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.55)'
          }}
        >
          <div
            className="glass-panel"
            onClick={(e) => e.stopPropagation()}
            style={{ padding: '22px 26px', maxWidth: '640px', width: '90%', maxHeight: '80%', overflowY: 'auto' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '14px' }}>
              <div style={{ fontSize: '15px', fontWeight: 700 }}>Keyboard shortcuts</div>
              <button
                onClick={() => setShowHelp(false)}
                aria-label="Close shortcuts"
                style={{ marginLeft: 'auto', background: 'transparent', border: 0, color: '#8a8a8f', cursor: 'pointer', fontSize: '18px' }}
              >
                x
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 22px', fontSize: '12px' }}>
              {SHORTCUT_HELP.map(([keys, what]) => (
                <div key={keys} style={{ display: 'flex', gap: '10px' }}>
                  <span style={{ minWidth: '116px', color: '#e11d2e', fontWeight: 700 }}>{keys}</span>
                  <span style={{ color: '#c9c9d2' }}>{what}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Custom Soft-Trash Confirm Modal */}
      {showDeleteConfirm && (
        <div
          onClick={() => setShowDeleteConfirm(false)}
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 3000,
            animation: 'fadeIn 0.2s ease-out'
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="cred-glass"
            style={{
              padding: '24px 32px',
              borderRadius: '4px',
              maxWidth: '400px',
              width: '90%',
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              gap: '20px',
              boxShadow: 'none',
              animation: 'slideInUp 0.25s cubic-bezier(0.22, 1, 0.36, 1)'
            }}
          >
            <div style={{ fontSize: '14px', fontWeight: 700, color: '#ffffff', textTransform: 'uppercase', letterSpacing: '1px' }}>
              Move this file to Trash?
            </div>
            <div style={{ fontSize: '12px', color: 'var(--app-fg-dim, #8a8a8f)', lineHeight: 1.5 }}>
              The file "{file.name}" will be moved to DiskFrame Trash. It will be permanently deleted after 30 days.
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', marginTop: '8px' }}>
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="cred-button"
                style={{ flex: 1, justifyContent: 'center', padding: '10px' }}
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="cred-button"
                style={{
                  flex: 1,
                  justifyContent: 'center',
                  background: '#e11d2e',
                  borderColor: '#e11d2e',
                  color: '#ffffff',
                  padding: '10px'
                }}
              >
                Move to Trash
              </button>
            </div>
          </div>
        </div>
      )}
      {/* The flight: the picture in transit between its tile and the viewer. */}
      {flight && (
        <div
          ref={flightRef}
          aria-hidden="true"
          data-viewer-flight=""
          style={{
            position: 'fixed',
            left: 0,
            top: 0,
            zIndex: 1200,
            overflow: 'hidden',
            pointerEvents: 'none',
            transformOrigin: '0 0',
            willChange: 'transform',
            background: '#000'
          }}
        >
          <div ref={flightInnerRef} style={{ position: 'absolute', inset: 0, transformOrigin: '0 0', willChange: 'transform' }}>
            {/* A thumbnail made before thumbnails kept their shape is the
                square middle of the picture. It is drawn where that middle
                really is, and until the full picture has decoded the rest of
                the frame is the same thumbnail, blurred - never the square
                stretched into a crop the picture does not have. */}
            {flight.thumb && (flight.thumbAspect === null || Math.abs(flight.thumbAspect - 1) < 0.02) && (
              <img
                src={flight.thumb}
                alt=""
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  filter: 'blur(18px) brightness(0.7)',
                  transform: 'scale(1.08)'
                }}
              />
            )}
            {flight.thumb && (
              <img
                src={flight.thumb}
                alt=""
                // A thumbnail that will not load must not fly as an empty box: land
                // at once on opening, fade instead of flying on closing.
                onError={() =>
                  phaseRef.current === 'opening' ? finishOpeningNow() : phaseRef.current === 'closing' ? onCloseRef.current() : setFlight(null)
                }
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }}
              />
            )}
            {flight.full && (
              <img
                src={flight.full}
                alt=""
                decoding="async"
                // Shown only once it is decoded: fading in a picture that is
                // still decoding stalled the flight for as long as that took
                // (197 ms measured on a 24 MP photo).
                onLoad={(e) => {
                  const img = e.currentTarget
                  const t0 = performance.now()
                  const show = (): void => setFlight((f) => (f && !f.fullReady ? { ...f, fullReady: true } : f))
                  // A picture that had to be decoded just now also has to be
                  // uploaded to the GPU the first time it is drawn; for a 24 MP
                  // photo that froze the last frames of the flight for 290-390 ms
                  // on an integrated GPU. So it waits for the landing, where a
                  // still frame hides the cost. One that was already decoded
                  // (seen before, or preloaded) is cheap and goes in at once.
                  const ready = (): void => {
                    const flying = flyingRef.current
                    if (flying && performance.now() - t0 > 50) void flying.then(show)
                    else show()
                  }
                  img.decode().then(ready, ready)
                }}
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  opacity: flight.fullReady ? 1 : 0,
                  transition: 'opacity 120ms linear'
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
export default MediaViewer
