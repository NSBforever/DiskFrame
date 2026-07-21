import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useZoomPan } from './ZoomPanEngine'
import { useGestures } from './GestureEngine'
import { useShortcuts } from './ShortcutManager'
import { ImageLoader } from './ImageLoader'
import { MediaViewerToolbar } from './MediaViewerToolbar'
import { MetadataPanel } from './MetadataPanel'

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
    lastTimeRef
  } = useZoomPan(containerRef, imgDimensions)

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

  // Auto-hide toolbar controls in fullscreen mode after 2s inactivity
  useEffect(() => {
    if (!isFullscreen) {
      setControlsVisible(true)
      return
    }

    const handleMouseMove = () => {
      setControlsVisible(true)
      lastMouseMoveRef.current = Date.now()
    }

    window.addEventListener('mousemove', handleMouseMove)

    const interval = setInterval(() => {
      if (Date.now() - lastMouseMoveRef.current > 2000) {
        setControlsVisible(false)
      }
    }, 500)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      clearInterval(interval)
    }
  }, [isFullscreen])

  // Keybind manager
  useShortcuts({
    onNext: handleNext,
    onPrev: handlePrev,
    onFirst: handleFirst,
    onLast: handleLast,
    onClose: handleClose,
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

  const handleFitWidth = () => {
    if (!containerRef.current || !imgDimensions) return
    const cw = containerRef.current.clientWidth
    const iw = imgDimensions.width
    const ih = imgDimensions.height
    const scaleToFit = Math.min(cw / iw, containerRef.current.clientHeight / ih)
    const fitW = iw * scaleToFit
    const targetScale = cw / fitW
    zoomTo(targetScale)
  }

  const handleFitHeight = () => {
    if (!containerRef.current || !imgDimensions) return
    const ch = containerRef.current.clientHeight
    const iw = imgDimensions.width
    const ih = imgDimensions.height
    const scaleToFit = Math.min(containerRef.current.clientWidth / iw, ch / ih)
    const fitH = ih * scaleToFit
    const targetScale = ch / fitH
    zoomTo(targetScale)
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
      const result = await window.electron.ipcRenderer.invoke('delete-files', [file.path]) as { success?: string[] }
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
    if (scale > 1) {
      reset()
    } else {
      zoomTo(3.0, e.clientX, e.clientY)
    }
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
      return rect ? {
        position: 'fixed' as const,
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        background: 'rgba(10, 10, 12, 0)',
        opacity: 0,
        transform: 'scale(0.8)',
        transition: 'all 0.35s cubic-bezier(0.22, 1, 0.36, 1)'
      } : {
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
          onFitWidth={handleFitWidth}
          onFitHeight={handleFitHeight}
          onActualSize={reset}
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
          style={{
            position: 'absolute',
            left: '16px',
            top: '50%',
            transform: 'translateY(-50%)',
            width: '44px',
            height: '44px',
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            fontSize: '24px',
            color: '#f2f2f0',
            zIndex: 100,
            backdropFilter: 'blur(12px)',
            transition: 'all 0.3s cubic-bezier(0.22, 1, 0.36, 1)'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.15)'
            e.currentTarget.style.transform = 'translateY(-50%) scale(1.05)'
            e.currentTarget.style.borderColor = '#e11d2e'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.06)'
            e.currentTarget.style.transform = 'translateY(-50%) scale(1)'
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'
          }}
        >
          ‹
        </div>
      )}

      {/* Slide Navigation Right */}
      {controlsVisible && !isOpening && !isClosing && list.indexOf(file) < list.length - 1 && (
        <div
          onClick={handleNext}
          style={{
            position: 'absolute',
            right: '16px',
            top: '50%',
            transform: 'translateY(-50%)',
            width: '44px',
            height: '44px',
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            fontSize: '24px',
            color: '#f2f2f0',
            zIndex: 100,
            backdropFilter: 'blur(12px)',
            transition: 'all 0.3s cubic-bezier(0.22, 1, 0.36, 1)'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.15)'
            e.currentTarget.style.transform = 'translateY(-50%) scale(1.05)'
            e.currentTarget.style.borderColor = '#e11d2e'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.06)'
            e.currentTarget.style.transform = 'translateY(-50%) scale(1)'
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'
          }}
        >
          ›
        </div>
      )}

      {/* Main Image View Container */}
      <div
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
      {controlsVisible && !isOpening && !isClosing && !isInfoOpen && (
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            padding: '16px 20px',
            background: 'linear-gradient(to top, rgba(10,10,12,0.9) 0%, rgba(10,10,12,0.3) 70%, transparent 100%)',
            display: 'flex',
            gap: '24px',
            fontSize: '11px',
            color: '#8a8a8f',
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
            <span>
              📍 {file.lat.toFixed(3)}, {file.lng.toFixed(3)}
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
              borderRadius: '16px',
              maxWidth: '400px',
              width: '90%',
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              gap: '20px',
              animation: 'slideInUp 0.25s cubic-bezier(0.22, 1, 0.36, 1)'
            }}
          >
            <div style={{ fontSize: '16px', fontWeight: 600, color: '#ffffff' }}>
              Move this file to Trash?
            </div>
            <div style={{ fontSize: '12px', color: '#8a8a8f', lineHeight: 1.5 }}>
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
