import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react'
import { useZoomPan } from './ZoomPanEngine'
import { useGestures } from './GestureEngine'
import { useShortcuts } from './ShortcutManager'
import { ImageLoader, VIEWER_ACTIVITY_EVENT, fullscreenExitIntent } from './ImageLoader'
import { MediaViewerToolbar } from './MediaViewerToolbar'
import { MetadataPanel } from './MetadataPanel'
import { MapPin, ArrowLeft } from 'lucide-react'
import { useReducedMotionPref } from '../../hooks/useReducedMotionPref'
import { containFit, visibleFraction, provisionalBox, boxesDiffer, type Box } from '../../../../main/viewerGeometry'

const photoExts = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']
const videoExts = ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.wmv', '.webm']

const OPEN_MS = 380
const CLOSE_MS = 320
const SETTLE_MS = 200
/** Fast out, long soft landing - the shape of the Photos zoom. */
const FLIGHT_EASE = 'cubic-bezier(0.2, 0.85, 0.25, 1)'

interface FlightState {
  box: Box
  thumb: string | null
  /** The full picture, layered over the thumbnail once it has loaded. */
  full: string | null
  fullReady?: boolean
}

function toUrl(p: string): string {
  return 'media:///' + p.replace(/\\/g, '/')
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
  const [rotation, setRotation] = useState(0)
  const [flipHorizontal, setFlipHorizontal] = useState(false)
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
  const startThumb = file.thumb ? toUrl(file.thumb) : null
  const canFly = !!rect && !!startThumb && (isPhoto || isVideo) && !reducedMotion
  const [phase, setPhase] = useState<'opening' | 'open' | 'closing'>(canFly ? 'opening' : 'open')
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const [flight, setFlight] = useState<FlightState | null>(() =>
    canFly && rect
      ? { box: toBox(rect), thumb: startThumb, full: isPhoto ? toUrl(file.path) : null }
      : null
  )
  const flightRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const flightAnimRef = useRef<Animation | null>(null)
  const openTokenRef = useRef({ cancelled: false })
  const pendingCloseRef = useRef<{ from: Box; to: Box } | null>(null)
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

  /** Moves the flight from one rectangle to another; resolves when it lands
   *  or is interrupted. Only this one element animates layout. */
  const fly = useCallback((from: Box, to: Box, ms: number): Promise<void> => {
    const el = flightRef.current
    if (!el) return Promise.resolve()
    flightAnimRef.current?.cancel()
    Object.assign(el.style, boxStyle(to))
    if (ms <= 0) return Promise.resolve()
    const a = el.animate([boxStyle(from), boxStyle(to)], { duration: ms, easing: FLIGHT_EASE })
    flightAnimRef.current = a
    return a.finished.then(
      () => undefined,
      () => undefined
    )
  }, [])
  const flightBox = (): Box | null => (flightRef.current ? toBox(flightRef.current.getBoundingClientRect()) : null)

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
      // A photo's size is usually known within a few frames (it is decoded
      // from disk while the flight starts); waiting that long lets the flight
      // go straight to it instead of correcting course.
      let target = await waitFor(mediaBox, 8)
      if (token.cancelled) return
      const firstLeg = target ?? provisionalBox(stage)
      await fly(start, firstLeg, OPEN_MS)
      if (token.cancelled) return
      if (!target) {
        // Landed on a guess (a video's size arrives from mpv): settle onto
        // the real rectangle as soon as it is known.
        target = await waitFor(mediaBox, 120)
        if (token.cancelled) return
        if (target) await fly(flightBox() ?? firstLeg, target, SETTLE_MS)
      } else {
        const now = mediaBox()
        if (now && boxesDiffer(now, target)) await fly(flightBox() ?? target, now, SETTLE_MS)
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
    flightAnimRef.current?.cancel()
    setPhase('open')
    setFlight(null)
  }, [])
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
    const from = flightBox() ?? mediaBox()
    const to = findTileBox(f.path)
    const thumb = f.thumb ? toUrl(f.thumb) : null
    phaseRef.current = 'closing'
    setPhase('closing')
    // The native player sits above everything in this window; it has to be
    // gone before the flight can be seen, and its sound with it.
    if (isVid) window.api.closeMpv()
    const done = (): void => onCloseRef.current()
    if (reducedMotion || !from || !to || !thumb) {
      setFlight(null)
      flightAnimRef.current?.cancel()
      const a = containerRef.current?.animate(
        [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: reducedMotion ? 'scale(1)' : 'scale(0.985)' }],
        { duration: reducedMotion ? 120 : 200, easing: 'ease-in', fill: 'forwards' }
      )
      if (a) a.finished.then(done, done)
      else done()
      return
    }
    pendingCloseRef.current = { from, to }
    setFlight((prev) => ({
      box: from,
      thumb,
      // Photos close with the full picture, already in memory, so nothing
      // drops in quality on the way back; at the tile it is cropped exactly as
      // the thumbnail is.
      full: isVid ? null : toUrl(f.path),
      fullReady: prev?.full === toUrl(f.path) ? prev?.fullReady : undefined
    }))
  }, [mediaBox, reducedMotion])

  // Runs the close once its flight element exists (it may have just been created).
  useLayoutEffect(() => {
    const pending = pendingCloseRef.current
    if (phase !== 'closing' || !pending || !flightRef.current) return
    pendingCloseRef.current = null
    const done = (): void => onCloseRef.current()
    backdropRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CLOSE_MS, easing: 'ease-in', fill: 'forwards' })
    void fly(pending.from, pending.to, CLOSE_MS).then(done)
  }, [phase, flight, fly])

  // A resize mid-transition: land immediately (opening) or finish (closing).
  useEffect(() => {
    const onResize = (): void => {
      if (phaseRef.current === 'opening') finishOpeningNow()
      else if (phaseRef.current === 'closing') {
        flightAnimRef.current?.finish()
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
  useEffect(() => {
    window.api.setOverlayMeta?.({ name: file.name, isFav })
  }, [file.name, isFav])

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


  // Fullscreen toggle handler
  const handleToggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch((err) => {
        console.error('Error attempting to enable fullscreen:', err)
      })
      setIsFullscreen(true)
    } else {
      fullscreenExitIntent.current = true
      document.exitFullscreen().catch(() => {})
      setIsFullscreen(false)
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

  // Sync fullscreen state on external escape.
  //
  // A real Escape in full screen never reaches the keydown handler below:
  // Chromium consumes it to leave full screen. So an exit the viewer did not
  // ask for is that Escape, and it closes the viewer too - one press, as the
  // handler below promises. The app window's own full screen is untouched;
  // the main process keeps that separately.
  useEffect(() => {
    const handleFullscreenChange = () => {
      const on = !!document.fullscreenElement
      setIsFullscreen(on)
      if (!on && !fullscreenExitIntent.current) handleCloseRef.current()
      fullscreenExitIntent.current = false
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
    }
  }, [])

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
        if (document.fullscreenElement) {
          fullscreenExitIntent.current = true
          document.exitFullscreen().catch(() => {})
        }
        handleClose()
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

  /** Cover the stage: may crop, which is the one mode allowed to. */
  const handleFill = () => {
    if (!stageRef.current || !imgDimensions) return
    const { clientWidth: cw, clientHeight: ch } = stageRef.current
    const { width: iw, height: ih } = imgDimensions
    if (!iw || !ih) return
    const cover = Math.max(cw / iw, ch / ih)
    zoomTo(cover / (fitScale || 1))
  }

  const handleDownload = () => {
    const a = document.createElement('a')
    a.href = 'media:///' + file.path.replace(/\\/g, '/')
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

  const handleDoubleClick = (e: React.MouseEvent) => {
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
  const chromeOn = controlsVisible && phase === 'open'

  return (
    <div
      ref={containerRef}
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
          onFill={handleFill}
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
        onDoubleClick={handleDoubleClick}
        style={{
          width: isInfoOpen && phase === 'open' ? 'calc(100% - 320px)' : '100%',
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
          file={file}
          list={list}
          rotation={rotation}
          flipHorizontal={flipHorizontal}
          scale={scale}
          translateX={translateX}
          translateY={translateY}
          onImageLoaded={setImgDimensions}
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
          style={{
            position: 'fixed',
            ...boxStyle(flight.box),
            zIndex: 1200,
            overflow: 'hidden',
            pointerEvents: 'none',
            willChange: 'left, top, width, height',
            background: '#000'
          }}
        >
          {flight.thumb && (
            <img
              src={flight.thumb}
              alt=""
              // A thumbnail that will not load must not fly as an empty box: land
              // at once on opening, fade instead of flying on closing.
              onError={() =>
                phaseRef.current === 'opening' ? finishOpeningNow() : phaseRef.current === 'closing' ? onCloseRef.current() : setFlight(null)
              }
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
            />
          )}
          {flight.full && (
            <img
              src={flight.full}
              alt=""
              onLoad={() => setFlight((f) => (f && !f.fullReady ? { ...f, fullReady: true } : f))}
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
      )}
    </div>
  )
}
export default MediaViewer
