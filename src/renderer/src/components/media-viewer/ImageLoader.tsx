import React, { useState, useEffect, useRef } from 'react'
import { imageCache } from './ImageCache'

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

interface ImageLoaderProps {
  file: ScannedFile
  list: ScannedFile[]
  rotation: number
  flipHorizontal: boolean
  scale: number
  translateX: number
  translateY: number
  onImageLoaded: (dimensions: { width: number; height: number }) => void
}

const photoExts = ['.jpg', '.jpeg', '.png', '.webp', '.heic']
const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.wmv']

function toUrl(p: string): string {
  return 'media:///' + p.replace(/\\/g, '/')
}

export const ImageLoader: React.FC<ImageLoaderProps> = ({
  file,
  list,
  rotation,
  flipHorizontal,
  scale,
  translateX,
  translateY,
  onImageLoaded
}) => {
  const [highResSrc, setHighResSrc] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showSpinner, setShowSpinner] = useState(false)
  const [imgError, setImgError] = useState(false)
  const [videoError, setVideoError] = useState(false)

  const isPhoto = photoExts.includes(file.ext.toLowerCase())
  const isVideo = videoExts.includes(file.ext.toLowerCase())
  const isPdf = file.ext.toLowerCase() === '.pdf'
  const isMp4 = file.ext.toLowerCase() === '.mp4'

  const videoRef = useRef<HTMLVideoElement>(null)

  // Preloading adjacent files
  useEffect(() => {
    const idx = list.findIndex((f) => f.path === file.path)
    if (idx === -1) return

    // Preload next image
    if (idx < list.length - 1) {
      const nextFile = list[idx + 1]
      if (photoExts.includes(nextFile.ext.toLowerCase())) {
        imageCache.preload(nextFile.path, toUrl(nextFile.path)).catch(() => {})
      }
    }

    // Preload previous image
    if (idx > 0) {
      const prevFile = list[idx - 1]
      if (photoExts.includes(prevFile.ext.toLowerCase())) {
        imageCache.preload(prevFile.path, toUrl(prevFile.path)).catch(() => {})
      }
    }
  }, [file.path, list])

  // Load current file
  useEffect(() => {
    setHighResSrc(null)
    setLoading(true)
    setShowSpinner(false)
    setImgError(false)
    setVideoError(false)

    // Spinner delay
    const spinnerTimer = setTimeout(() => {
      setShowSpinner(true)
    }, 150)

    if (isPhoto) {
      const fullUrl = toUrl(file.path)
      imageCache
        .preload(file.path, fullUrl)
        .then((img) => {
          clearTimeout(spinnerTimer)
          setHighResSrc(fullUrl)
          setLoading(false)
          setShowSpinner(false)
          onImageLoaded({ width: img.naturalWidth, height: img.naturalHeight })
        })
        .catch(() => {
          clearTimeout(spinnerTimer)
          setLoading(false)
          setShowSpinner(false)
          setImgError(true)
        })
    } else {
      clearTimeout(spinnerTimer)
      setLoading(false)
      setShowSpinner(false)
    }

    return () => {
      clearTimeout(spinnerTimer)
    }
  }, [file.path, isPhoto, onImageLoaded])

  const handleVideoMetadata = () => {
    if (videoRef.current) {
      onImageLoaded({
        width: videoRef.current.videoWidth,
        height: videoRef.current.videoHeight
      })
    }
  }

  // Thumb URL for progressive layout placeholder
  const thumbSrc = file.thumb ? toUrl(file.thumb) : null
  const mediaSrc = toUrl(file.path)

  const transformStyle = `translate(${translateX}px, ${translateY}px) scale(${scale}) rotate(${rotation}deg) ${flipHorizontal ? 'scaleX(-1)' : ''}`

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden'
      }}
    >
      {/* Delayed Loading Spinner */}
      {showSpinner && loading && (
        <div
          style={{
            position: 'absolute',
            zIndex: 10,
            width: '40px',
            height: '40px',
            border: '3px solid rgba(255,255,255,0.1)',
            borderTop: '3px solid #6c6cff',
            borderRadius: '50%',
            animation: 'tileSpin 0.8s linear infinite'
          }}
        />
      )}

      {/* Render Photo */}
      {isPhoto && (
        <div
          style={{
            transform: transformStyle,
            transformOrigin: 'center',
            transition: isDraggingRefActive() ? 'none' : 'transform 0.15s cubic-bezier(0.16, 1, 0.3, 1)',
            maxWidth: '100%',
            maxHeight: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            willChange: 'transform'
          }}
        >
          {imgError ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
              <div style={{ fontSize: '48px' }}>🖼️</div>
              <div style={{ fontSize: '13px', color: '#6060a0' }}>Cannot preview this image</div>
            </div>
          ) : (
            <div style={{ position: 'relative', display: 'block' }}>
              {/* Blurred Thumbnail Placeholder (progressive enhancement) */}
              {thumbSrc && !highResSrc && (
                <img
                  src={thumbSrc}
                  alt="placeholder"
                  style={{
                    maxWidth: '90vw',
                    maxHeight: '86vh',
                    objectFit: 'contain',
                    filter: 'blur(8px)',
                    transform: 'scale(1.05)',
                    display: 'block'
                  }}
                />
              )}

              {/* High Resolution Image */}
              {highResSrc && (
                <img
                  src={highResSrc}
                  alt={file.name}
                  style={{
                    maxWidth: '90vw',
                    maxHeight: '86vh',
                    objectFit: 'contain',
                    display: 'block',
                    opacity: loading ? 0 : 1,
                    transition: 'opacity 0.25s ease-in'
                  }}
                />
              )}
            </div>
          )}
        </div>
      )}

      {/* Render Video */}
      {isVideo && (
        <div
          style={{
            transform: transformStyle,
            transformOrigin: 'center',
            maxWidth: '100%',
            maxHeight: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            willChange: 'transform'
          }}
        >
          {isMp4 ? (
            <video
              ref={videoRef}
              key={file.path}
              src={mediaSrc}
              controls
              autoPlay
              onLoadedMetadata={handleVideoMetadata}
              style={{ maxWidth: '90vw', maxHeight: '82vh', display: 'block', background: '#000', borderRadius: '8px' }}
            />
          ) : !videoError ? (
            <video
              ref={videoRef}
              key={file.path}
              controls
              autoPlay
              onLoadedMetadata={handleVideoMetadata}
              onError={() => setVideoError(true)}
              style={{ maxWidth: '90vw', maxHeight: '82vh', display: 'block', background: '#000', borderRadius: '8px' }}
            >
              <source src={mediaSrc} type="video/mp4" />
            </video>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '16px',
                padding: '40px',
                background: '#141420',
                borderRadius: '14px',
                border: '0.5px solid #2a2a3a'
              }}
            >
              <div style={{ fontSize: '64px' }}>🎬</div>
              <div style={{ fontSize: '15px', fontWeight: 600, color: '#e8e8ea' }}>{file.name}</div>
              <div style={{ fontSize: '12px', color: '#7070a0' }}>This format cannot play in-app</div>
              <button
                onClick={() => window.electron.ipcRenderer.send('open-file', file.path)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '10px 24px',
                  borderRadius: '24px',
                  border: 'none',
                  background: '#6c6cff',
                  color: '#fff',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  boxShadow: '0 8px 16px rgba(108,108,255,0.3)'
                }}
              >
                ▶ Open in System Player
              </button>
            </div>
          )}
        </div>
      )}

      {/* Render Document / Pdf */}
      {!isPhoto && !isVideo && !isPdf && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', padding: '40px' }}>
          <div style={{ fontSize: '72px' }}>📄</div>
          <div style={{ fontSize: '14px', color: '#8080a0' }}>{file.name}</div>
        </div>
      )}
    </div>
  )
}

// Helper to determine transition override (prevent delay during user dragging)
function isDraggingRefActive(): boolean {
  return false // Will be customized if we need dynamic transition control
}
