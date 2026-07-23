import React, { useState, useEffect, useRef } from 'react'
import { imageCache } from './ImageCache'
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize2,
  Minimize2
} from 'lucide-react'

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

  const videoRef = useRef<HTMLVideoElement>(null)
  const videoContainerRef = useRef<HTMLDivElement>(null)

  // Custom VLC-style video states & streaming pipeline
  const [videoMode, setVideoMode] = useState<'native' | 'stream' | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [isBuffering, setIsBuffering] = useState(false)
  const [seekOffset, setSeekOffset] = useState(0)

  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const lastMouseMoveRef = useRef(Date.now())

  // Preloading adjacent files
  useEffect(() => {
    const idx = list.findIndex((f) => f.path === file.path)
    if (idx === -1) return

    if (idx < list.length - 1) {
      const nextFile = list[idx + 1]
      if (photoExts.includes(nextFile.ext.toLowerCase())) {
        imageCache.preload(nextFile.path, toUrl(nextFile.path)).catch(() => {})
      }
    }

    if (idx > 0) {
      const prevFile = list[idx - 1]
      if (photoExts.includes(prevFile.ext.toLowerCase())) {
        imageCache.preload(prevFile.path, toUrl(prevFile.path)).catch(() => {})
      }
    }
  }, [file.path, list])

  // Load current file (Photos & Videos)
  useEffect(() => {
    setHighResSrc(null)
    setLoading(true)
    setShowSpinner(false)
    setImgError(false)
    setVideoError(false)

    // Reset video player states
    setVideoMode(null)
    setVideoUrl(null)
    setIsBuffering(false)
    setSeekOffset(0)
    setIsPlaying(false)
    setCurrentTime(0)
    setDuration(0)
    setVolume(1)
    setIsMuted(false)
    setPlaybackSpeed(1.0)

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
    } else if (isVideo) {
      clearTimeout(spinnerTimer)
      setLoading(false)
      setShowSpinner(false)
      setIsBuffering(true)

      // Probe media via main process IPC
      window.api
        .getVideoPlayInfo(file.path)
        .then((info) => {
          setVideoMode(info.mode)
          setVideoUrl(info.url)
          if (info.duration > 0) {
            setDuration(info.duration)
          }
          setIsBuffering(false)
        })
        .catch((err) => {
          console.error('[ImageLoader] Error fetching video info:', err)
          setVideoError(true)
          setIsBuffering(false)
        })
    } else {
      clearTimeout(spinnerTimer)
      setLoading(false)
      setShowSpinner(false)
    }

    return () => {
      clearTimeout(spinnerTimer)
      if (isVideo) {
        window.api.stopVideoStream().catch(() => {})
      }
    }
  }, [file.path, isPhoto, isVideo, onImageLoaded])

  // Time Updates & Metadata Loaded Binds
  const handleTimeUpdate = () => {
    if (videoRef.current) {
      const liveTime = videoRef.current.currentTime
      if (videoMode === 'stream') {
        setCurrentTime(seekOffset + liveTime)
      } else {
        setCurrentTime(liveTime)
      }
    }
  }

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      if (videoRef.current.duration && !isNaN(videoRef.current.duration) && videoRef.current.duration !== Infinity) {
        setDuration(videoRef.current.duration)
      }
      onImageLoaded({
        width: videoRef.current.videoWidth,
        height: videoRef.current.videoHeight
      })
    }
  }

  // Play/Pause callbacks
  const togglePlay = () => {
    if (!videoRef.current) return
    if (videoRef.current.paused) {
      videoRef.current.play().then(() => setIsPlaying(true)).catch((err) => console.error(err))
    } else {
      videoRef.current.pause()
      setIsPlaying(false)
    }
  }

  const handlePlay = () => setIsPlaying(true)
  const handlePause = () => setIsPlaying(false)

  // Seek bar draggable bind supporting stream seeking
  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value)
    setCurrentTime(val)

    if (videoMode === 'native') {
      if (videoRef.current) {
        videoRef.current.currentTime = val
      }
    } else if (videoMode === 'stream') {
      setIsBuffering(true)
      setSeekOffset(val)
      window.api
        .getVideoPlayInfo(file.path, val)
        .then((info) => {
          setVideoUrl(info.url)
          setIsBuffering(false)
          if (videoRef.current) {
            videoRef.current.play().catch(() => {})
          }
        })
        .catch(() => {
          setIsBuffering(false)
        })
    }
  }

  // Volume slider & Mute toggle binds
  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!videoRef.current) return
    const val = Number(e.target.value)
    videoRef.current.volume = val
    setVolume(val)
    if (val === 0) {
      videoRef.current.muted = true
      setIsMuted(true)
    } else {
      videoRef.current.muted = false
      setIsMuted(false)
    }
  }

  const toggleMute = () => {
    if (!videoRef.current) return
    const nextMute = !isMuted
    videoRef.current.muted = nextMute
    setIsMuted(nextMute)
  }

  // Playback multiplier rate selection
  const handleSpeedChange = (rate: number) => {
    if (!videoRef.current) return
    videoRef.current.playbackRate = rate
    setPlaybackSpeed(rate)
  }

  // Local fullscreen triggers
  const toggleFullscreen = () => {
    if (!videoContainerRef.current) return
    if (!document.fullscreenElement) {
      videoContainerRef.current.requestFullscreen().catch((err) => console.error(err))
      setIsFullscreen(true)
    } else {
      document.exitFullscreen().catch(() => {})
      setIsFullscreen(false)
    }
  }

  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', handleFsChange)
    return () => document.removeEventListener('fullscreenchange', handleFsChange)
  }, [])

  // Auto-hide control bar listener after 3s inactivity
  useEffect(() => {
    if (!isVideo) return
    const handleMouseMove = () => {
      setControlsVisible(true)
      lastMouseMoveRef.current = Date.now()
    }
    const container = videoContainerRef.current
    if (container) {
      container.addEventListener('mousemove', handleMouseMove)
    }
    const timer = setInterval(() => {
      if (Date.now() - lastMouseMoveRef.current > 3000) {
        setControlsVisible(false)
      }
    }, 500)

    return () => {
      if (container) {
        container.removeEventListener('mousemove', handleMouseMove)
      }
      clearInterval(timer)
    }
  }, [isVideo])

  const formatTime = (secs: number) => {
    if (isNaN(secs)) return '0:00'
    const m = Math.floor(secs / 60)
    const s = Math.floor(secs % 60)
    return `${m}:${s < 10 ? '0' : ''}${s}`
  }

  const showControls = controlsVisible || !isPlaying

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
            borderTop: '3px solid #e11d2e',
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
            transition: 'transform 0.15s cubic-bezier(0.16, 1, 0.3, 1)',
            maxWidth: '100%',
            maxHeight: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            willChange: 'transform'
          }}
        >
          {imgError ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
              <div style={{ fontSize: '64px' }}>⚠️</div>
              <div style={{ fontSize: '14px', color: '#8a8a8f' }}>Failed to load image</div>
            </div>
          ) : (
            <>
              {loading && thumbSrc && (
                <img
                  src={thumbSrc}
                  style={{
                    position: 'absolute',
                    maxWidth: '100%',
                    maxHeight: '100%',
                    objectFit: 'contain',
                    filter: 'blur(10px)'
                  }}
                />
              )}
              {highResSrc && (
                <img
                  src={highResSrc}
                  style={{
                    maxWidth: '100%',
                    maxHeight: '100%',
                    objectFit: 'contain',
                    opacity: loading ? 0 : 1,
                    transition: 'opacity 0.25s ease'
                  }}
                />
              )}
            </>
          )}
        </div>
      )}

      {/* Render Universal HTML5 / Streamed Video */}
      {isVideo && (
        <div
          ref={videoContainerRef}
          style={{
            transform: transformStyle,
            transformOrigin: 'center',
            maxWidth: '100%',
            maxHeight: '100%',
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            background: '#000'
          }}
        >
          {videoUrl && !videoError ? (
            <>
              <video
                ref={videoRef}
                src={videoUrl}
                autoPlay
                onLoadedMetadata={handleLoadedMetadata}
                onTimeUpdate={handleTimeUpdate}
                onPlay={handlePlay}
                onPause={handlePause}
                onWaiting={() => setIsBuffering(true)}
                onPlaying={() => setIsBuffering(false)}
                onError={() => setVideoError(true)}
                style={{
                  maxWidth: '100%',
                  maxHeight: '100%',
                  objectFit: 'contain'
                }}
              />

              {/* Buffering Spinner */}
              {isBuffering && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '12px',
                    background: 'rgba(0,0,0,0.5)',
                    zIndex: 10
                  }}
                >
                  <div
                    style={{
                      width: '36px',
                      height: '36px',
                      border: '3px solid rgba(255,255,255,0.1)',
                      borderTop: '3px solid #e11d2e',
                      borderRadius: '50%',
                      animation: 'tileSpin 0.8s linear infinite'
                    }}
                  />
                  <div
                    style={{
                      fontSize: '10px',
                      color: '#e11d2e',
                      textTransform: 'uppercase',
                      letterSpacing: '1px',
                      fontWeight: 700
                    }}
                  >
                    {videoMode === 'stream' ? 'Transcoding Stream...' : 'Buffering...'}
                  </div>
                </div>
              )}

              {/* Custom VLC-style Video Control Overlay */}
              <div
                style={{
                  position: 'absolute',
                  bottom: '16px',
                  left: '16px',
                  right: '16px',
                  background: 'rgba(10, 10, 12, 0.88)',
                  backdropFilter: 'blur(12px) saturate(1.2)',
                  border: '1px solid rgba(225, 29, 46, 0.25)',
                  borderRadius: '4px',
                  padding: '8px 14px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  opacity: showControls ? 1 : 0,
                  transition: 'opacity 0.25s cubic-bezier(0.22, 1, 0.36, 1)',
                  zIndex: 200,
                  pointerEvents: showControls ? 'auto' : 'none',
                  userSelect: 'none'
                }}
              >
                {/* Play/Pause Button */}
                <button
                  onClick={togglePlay}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#d0d0e0',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    padding: 0
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = '#e11d2e')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = '#d0d0e0')}
                >
                  {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                </button>

                {/* Duration Binds */}
                <div
                  style={{
                    fontSize: '10px',
                    color: '#8a8a8f',
                    minWidth: '70px',
                    fontWeight: 600,
                    letterSpacing: '0.5px'
                  }}
                >
                  {formatTime(currentTime)} / {formatTime(duration)}
                </div>

                {/* Custom Seek slider track */}
                <input
                  type="range"
                  min="0"
                  max={duration || 100}
                  value={currentTime}
                  onChange={handleSeekChange}
                  style={{
                    flex: 1,
                    height: '4px',
                    outline: 'none',
                    cursor: 'pointer'
                  }}
                />

                {/* Mute toggle and Volume level */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <button
                    onClick={toggleMute}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: '#d0d0e0',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      padding: 0
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = '#e11d2e')}
                    onMouseLeave={(e) => (e.currentTarget.style.color = '#d0d0e0')}
                  >
                    {isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
                  </button>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={isMuted ? 0 : volume}
                    onChange={handleVolumeChange}
                    style={{
                      width: '60px',
                      height: '4px',
                      outline: 'none',
                      cursor: 'pointer'
                    }}
                  />
                </div>

                {/* Playback speed selector multipliers */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '2px',
                    borderLeft: '1px solid rgba(255,255,255,0.08)',
                    paddingLeft: '8px'
                  }}
                >
                  {[0.5, 1.0, 1.5, 2.0].map((speed) => (
                    <button
                      key={speed}
                      onClick={() => handleSpeedChange(speed)}
                      style={{
                        background: playbackSpeed === speed ? 'rgba(225, 29, 46, 0.25)' : 'transparent',
                        border: 'none',
                        borderRadius: '2px',
                        color: playbackSpeed === speed ? '#e11d2e' : '#8a8a8f',
                        fontSize: '9px',
                        fontWeight: 700,
                        padding: '2px 4px',
                        cursor: 'pointer',
                        letterSpacing: '0.2px'
                      }}
                      onMouseEnter={(e) => {
                        if (playbackSpeed !== speed) e.currentTarget.style.color = '#ffffff'
                      }}
                      onMouseLeave={(e) => {
                        if (playbackSpeed !== speed) e.currentTarget.style.color = '#8a8a8f'
                      }}
                    >
                      {speed}x
                    </button>
                  ))}
                </div>

                {/* Local Fullscreen switch */}
                <button
                  onClick={toggleFullscreen}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#d0d0e0',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    padding: 0,
                    borderLeft: '1px solid rgba(255,255,255,0.08)',
                    paddingLeft: '8px'
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = '#e11d2e')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = '#d0d0e0')}
                >
                  {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                </button>
              </div>
            </>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '16px',
                padding: '40px',
                background: '#111114',
                borderRadius: '4px',
                border: '1px solid rgba(255, 255, 255, 0.04)'
              }}
            >
              <div style={{ fontSize: '64px' }}>🎬</div>
              <div style={{ fontSize: '15px', fontWeight: 600, color: '#f2f2f0' }}>{file.name}</div>
              <div style={{ fontSize: '12px', color: '#8a8a8f' }}>Fallback system player required for this media</div>
              <button
                onClick={() => window.electron.ipcRenderer.send('open-file', file.path)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '10px 24px',
                  borderRadius: '4px',
                  border: 'none',
                  background: '#e11d2e',
                  color: '#fff',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  boxShadow: 'none',
                  transition: 'background 0.2s'
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#ff2b3d')}
                onMouseLeave={(e) => (e.currentTarget.style.background = '#e11d2e')}
              >
                ▶ Open in System Player
              </button>
            </div>
          )}
        </div>
      )}

      {/* Render Document / Pdf */}
      {!isPhoto && !isVideo && isPdf && (
        <div style={{ width: '90%', height: '90%', display: 'flex', background: '#fff', borderRadius: '4px', overflow: 'hidden' }}>
          <embed src={mediaSrc} type="application/pdf" width="100%" height="100%" />
        </div>
      )}

      {!isPhoto && !isVideo && !isPdf && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', padding: '40px' }}>
          <div style={{ fontSize: '72px' }}>📄</div>
          <div style={{ fontSize: '14px', color: '#8a8a8f' }}>{file.name}</div>
        </div>
      )}
    </div>
  )
}

export default ImageLoader
