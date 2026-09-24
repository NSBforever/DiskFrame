import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useZoomPan } from './ZoomPanEngine'
import { useGestures } from './GestureEngine'
import { useShortcuts } from './ShortcutManager'
import { ImageLoader, VIEWER_ACTIVITY_EVENT } from './ImageLoader'
import { MediaViewerToolbar } from './MediaViewerToolbar'
import { MetadataPanel } from './MetadataPanel'
import { MapPin, ArrowLeft } from 'lucide-react'

const photoExts = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']
const videoExts = ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.wmv', '.webm']

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
  onDelete: (path: string) => void
  rect?: DOMRect
}

export const MediaViewer: React.FC<MediaViewerProps> = ({
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
  const isPhoto = photoExts.includes(file.ext.toLowerCase())
  const isVideo = videoExts.includes(file.ext.toLowerCase())
  const [imgDimensions, setImgDimensions] = useState<{ width: number; height: number } | null>(null)
  const [rotation, setRotation] = useState(0)
  const [flipHorizontal, setFlipHorizontal] = useState(false)
  const [isInfoOpen, setIsInfoOpen] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // Zoom-in / zoom-out transition animations
  const [isOpening, setIsOpening] = useState(!!rect)
  const [isClosing, setIsClosing] = useState(false)

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

  // Trigger opening animation
  useEffect(() => {
    if (rect) {
      setIsOpening(true)
      const timer = setTimeout(() => {
        setIsOpening(false)
      }, 20)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [rect])

  const handleClose = useCallback(() => {
    setIsClosing(true)
    setTimeout(() => {
      onClose()
    }, 320)
  }, [onClose])

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
      document.exitFullscreen().catch(() => {})
      setIsFullscreen(false)
    }
  }, [])

  // Sync fullscreen state on external escape
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
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

  const confirmDelete = async () => {
    setShowDeleteConfirm(false)
    try {
      const result = (await window.electron.ipcRenderer.invoke('delete-files', [
        file.path
      ])) as { success?: string[] }
      if (result && result.success && result.success.length > 0) {
        onDelete(file.path)
        handleClose()
      } else {
        alert('Failed to trash file.')
      }
    } catch (err) {
      console.error('Trash error', err)
    }
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

  // Calculate inline transition styles
  const animationStyle = (() => {
    if (isOpening && rect) {
      return {
        position: 'fixed' as const,
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        background: 'rgba(10, 10, 12, 0)',
        opacity: 0,
        transform: 'scale(1)',
        transition: 'all 0.35s cubic-bezier(0.22, 1, 0.36, 1)'
      }
    }
    if (isClosing) {
      return rect
        ? {
            position: 'fixed' as const,
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            background: 'rgba(10, 10, 12, 0)',
            opacity: 0,
            transform: 'scale(0.8)',
            transition: 'all 0.35s cubic-bezier(0.22, 1, 0.36, 1)'
          }
        : {
            position: 'fixed' as const,
            inset: 0,
            background: 'rgba(10, 10, 12, 0)',
            opacity: 0,
            transform: 'scale(0.95)',
            transition: 'all 0.35s cubic-bezier(0.22, 1, 0.36, 1)'
          }
    }
    return {
      position: 'fixed' as const,
      inset: 0,
      background: 'rgba(10, 10, 12, 0.98)',
      opacity: 1,
      transform: 'scale(1)',
      transition: 'all 0.35s cubic-bezier(0.22, 1, 0.36, 1)'
    }
  })()

  return (
    <div
      ref={containerRef}
      style={{
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        userSelect: 'none',
        ...animationStyle
      }}
    >
      {/* Top-Left Back / Close Button */}
      {controlsVisible && !isOpening && !isClosing && (
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

      {/* Top toolbar */}
      {controlsVisible && !isOpening && !isClosing && (
        <MediaViewerToolbar
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
      {controlsVisible && !isOpening && !isClosing && list.indexOf(file) > 0 && (
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
      {controlsVisible && !isOpening && !isClosing && list.indexOf(file) < list.length - 1 && (
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
          width: isInfoOpen && !isOpening && !isClosing ? 'calc(100% - 320px)' : '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transform: `translateX(${swipeOffset}px)`,
          transition: swipeOffset === 0 ? 'width 0.3s cubic-bezier(0.22, 1, 0.36, 1)' : 'none'
        }}
      >
        <ImageLoader
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
          isClosing={isClosing}
        />
      </div>

      {/* EXIF Metadata Right Panel */}
      <MetadataPanel
        file={file}
        isOpen={isInfoOpen && !isOpening && !isClosing}
        onClose={() => setIsInfoOpen(false)}
        naturalDimensions={imgDimensions}
      />

      {/* Bottom Bar Info Overlay */}
      {controlsVisible && !isOpening && !isClosing && !isInfoOpen && isPhoto && (
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
      {controlsVisible && !isOpening && !isClosing && !isInfoOpen && isVideo && (
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
    </div>
  )
}
export default MediaViewer
