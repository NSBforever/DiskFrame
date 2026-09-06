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

const photoExts = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']
const videoExts = ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.wmv', '.webm']

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
  const [videoMode, setVideoMode] = useState<'native' | 'stream' | 'mpv' | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [isBuffering, setIsBuffering] = useState(false)
  const [seekOffset, setSeekOffset] = useState(0)
  const mpvWidthRef = useRef<number | null>(null)
  const mpvHeightRef = useRef<number | null>(null)

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

      mpvWidthRef.current = null
      mpvHeightRef.current = null

      let active = true

      const startPlayback = async () => {
        if (!videoContainerRef.current) {
          await new Promise((r) => setTimeout(r, 50))
        }

        if (!active || !videoContainerRef.current) return

        const rect = videoContainerRef.current.getBoundingClientRect()
        const bounds = {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height
        }

        try {
          await window.api.playMpv(file.path, bounds)
          if (!active) return
          setVideoMode('mpv')
          setIsBuffering(false)
          setIsPlaying(true)
        } catch (err) {
          console.error('[ImageLoader] mpv start failed, falling back to stream server:', err)
          if (!active) return
          window.api
            .getVideoPlayInfo(file.path)
            .then((info) => {
              if (!active) return
              setVideoMode(info.mode)
              setVideoUrl(info.url)
              if (info.duration > 0) {
                setDuration(info.duration)
              }
              setIsBuffering(false)
            })
            .catch((streamErr) => {
              console.error('[ImageLoader] Fallback stream failed:', streamErr)
              if (!active) return
              setVideoError(true)
              setIsBuffering(false)
            })
        }
      }

      startPlayback()

      const unbindError = window.api.onMpvError((errObj) => {
        console.error('[ImageLoader] mpv error event:', errObj.error)
        if (active) {
          window.api
            .getVideoPlayInfo(file.path)
            .then((info) => {
              if (!active) return
              setVideoMode(info.mode)
              setVideoUrl(info.url)
              if (info.duration > 0) setDuration(info.duration)
              setIsBuffering(false)
            })
            .catch(() => {
              if (!active) return
              setVideoError(true)
              setIsBuffering(false)
            })
        }
      })

      return () => {
        active = false
        clearTimeout(spinnerTimer)
        unbindError()
        window.api.closeMpv()
        window.api.stopVideoStream().catch(() => {})
      }
    } else {
      clearTimeout(spinnerTimer)
      setLoading(false)
      setShowSpinner(false)
    }

    return () => {
      clearTimeout(spinnerTimer)
    }
  }, [file.path, isPhoto, isVideo, onImageLoaded])

  // Synchronize mpv window bounds on resize
  useEffect(() => {
    if (videoMode !== 'mpv' || !videoContainerRef.current) return

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const rect = entry.target.getBoundingClientRect()
      window.api.resizeMpv({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      })
    })

    observer.observe(videoContainerRef.current)

    return () => {
      observer.disconnect()
    }
  }, [videoMode])

  // Sync mpv properties with React state
  useEffect(() => {
    if (videoMode !== 'mpv') return

    const unbindChange = window.api.onMpvPropertyChange(({ name, value }) => {
      switch (name) {
        case 'time-pos':
          if (typeof value === 'number') {
            setCurrentTime(value)
          }
          break
        case 'duration':
          if (typeof value === 'number') {
            setDuration(value)
          }
          break
        case 'pause':
          if (typeof value === 'boolean') {
            setIsPlaying(!value)
          }
          break
        case 'volume':
          if (typeof value === 'number') {
            setVolume(value / 100)
          }
          break
        case 'mute':
          if (typeof value === 'boolean') {
            setIsMuted(value)
          }
          break
        case 'speed':
          if (typeof value === 'number') {
            setPlaybackSpeed(value)
          }
          break
        case 'width':
          if (typeof value === 'number') {
            mpvWidthRef.current = value
            if (mpvHeightRef.current) {
              onImageLoaded({ width: value, height: mpvHeightRef.current })
            }
          }
          break
        case 'height':
          if (typeof value === 'number') {
            mpvHeightRef.current = value
            if (mpvWidthRef.current) {
              onImageLoaded({ width: mpvWidthRef.current, height: value })
            }
          }
          break
      }
    })

    return () => {
      unbindChange()
    }
  }, [videoMode, onImageLoaded])

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
    if (videoMode === 'mpv') {
      window.api.sendMpvCommand('set_property', ['pause', isPlaying])
    } else {
      if (!videoRef.current) return
      if (videoRef.current.paused) {
        videoRef.current.play().then(() => setIsPlaying(true)).catch((err) => console.error(err))
      } else {
        videoRef.current.pause()
        setIsPlaying(false)
      }
    }
  }

  const handlePlay = () => setIsPlaying(true)
  const handlePause = () => setIsPlaying(false)

  // Seek bar hover preview & drag seek handlers
  const [hoverTime, setHoverTime] = useState<number | null>(null)
  const [hoverX, setHoverX] = useState<number>(0)
  const [isDraggingSeek, setIsDraggingSeek] = useState(false)
  const [volumeHovered, setVolumeHovered] = useState(false)
  const [showSpeedMenu, setShowSpeedMenu] = useState(false)

  const handleSeekBarMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const pct = Math.max(0, Math.min(1, x / rect.width))
    const time = pct * duration
    setHoverTime(time)
    setHoverX(x)
  }

  const handleSeekBarMouseLeave = () => {
    setHoverTime(null)
  }

  const handleSeekBarMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    setIsDraggingSeek(true)
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const pct = Math.max(0, Math.min(1, x / rect.width))
    const targetTime = pct * duration
    setCurrentTime(targetTime)

    if (videoMode === 'mpv') {
      window.api.sendMpvCommand('seek', [targetTime, 'absolute'])
    } else if (videoMode === 'native') {
      if (videoRef.current) videoRef.current.currentTime = targetTime
    } else if (videoMode === 'stream') {
      setIsBuffering(true)
      setSeekOffset(targetTime)
      window.api.getVideoPlayInfo(file.path, targetTime)
        .then((info) => {
          setVideoUrl(info.url)
          setIsBuffering(false)
          if (videoRef.current) videoRef.current.play().catch(() => {})
        })
        .catch(() => setIsBuffering(false))
    }
  }

  useEffect(() => {
    if (!isDraggingSeek) return

    const handleMouseMove = (e: MouseEvent) => {
      const seekBar = document.getElementById('youtube-seek-bar')
      if (!seekBar) return
      const rect = seekBar.getBoundingClientRect()
      const x = e.clientX - rect.left
      const pct = Math.max(0, Math.min(1, x / rect.width))
      const targetTime = pct * duration
      setCurrentTime(targetTime)
    }

    const handleMouseUp = (e: MouseEvent) => {
      setIsDraggingSeek(false)
      const seekBar = document.getElementById('youtube-seek-bar')
      if (!seekBar) return
      const rect = seekBar.getBoundingClientRect()
      const x = e.clientX - rect.left
      const pct = Math.max(0, Math.min(1, x / rect.width))
      const targetTime = pct * duration

      if (videoMode === 'mpv') {
        window.api.sendMpvCommand('seek', [targetTime, 'absolute'])
      } else if (videoMode === 'native') {
        if (videoRef.current) videoRef.current.currentTime = targetTime
      } else if (videoMode === 'stream') {
        setIsBuffering(true)
        setSeekOffset(targetTime)
        window.api.getVideoPlayInfo(file.path, targetTime)
          .then((info) => {
            setVideoUrl(info.url)
            setIsBuffering(false)
            if (videoRef.current) videoRef.current.play().catch(() => {})
          })
          .catch(() => setIsBuffering(false))
      }
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDraggingSeek, duration, videoMode, file.path])

  // Volume slider & Mute toggle binds
  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value)
    setVolume(val)
    const isM = val === 0
    setIsMuted(isM)
    if (videoMode === 'mpv') {
      window.api.sendMpvCommand('set_property', ['volume', val * 100])
      window.api.sendMpvCommand('set_property', ['mute', isM])
    } else {
      if (!videoRef.current) return
      videoRef.current.volume = val
      videoRef.current.muted = isM
    }
  }

  const toggleMute = () => {
    const nextMute = !isMuted
    setIsMuted(nextMute)
    if (videoMode === 'mpv') {
      window.api.sendMpvCommand('set_property', ['mute', nextMute])
    } else {
      if (!videoRef.current) return
      videoRef.current.muted = nextMute
    }
  }

  // Playback multiplier rate selection
  const handleSpeedChange = (rate: number) => {
    setPlaybackSpeed(rate)
    if (videoMode === 'mpv') {
      window.api.sendMpvCommand('set_property', ['speed', rate])
    } else {
      if (!videoRef.current) return
      videoRef.current.playbackRate = rate
    }
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

  // Capture-phase keydown listener for strict keyboard shortcuts overrides
  useEffect(() => {
    if (!isVideo) return

    const handleVideoKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.getAttribute('contenteditable') === 'true')) {
        return
      }

      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          togglePlay()
          break
        case 'ArrowLeft': {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          const nextTimeL = Math.max(0, currentTime - 5)
          setCurrentTime(nextTimeL)
          if (videoMode === 'mpv') {
            window.api.sendMpvCommand('seek', [nextTimeL, 'absolute'])
          } else if (videoMode === 'native') {
            if (videoRef.current) videoRef.current.currentTime = nextTimeL
          } else if (videoMode === 'stream') {
            setIsBuffering(true)
            setSeekOffset(nextTimeL)
            window.api.getVideoPlayInfo(file.path, nextTimeL)
              .then((info) => {
                setVideoUrl(info.url)
                setIsBuffering(false)
                if (videoRef.current) videoRef.current.play().catch(() => {})
              })
              .catch(() => setIsBuffering(false))
          }
          break
        }
        case 'ArrowRight': {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          const nextTimeR = Math.min(duration, currentTime + 5)
          setCurrentTime(nextTimeR)
          if (videoMode === 'mpv') {
            window.api.sendMpvCommand('seek', [nextTimeR, 'absolute'])
          } else if (videoMode === 'native') {
            if (videoRef.current) videoRef.current.currentTime = nextTimeR
          } else if (videoMode === 'stream') {
            setIsBuffering(true)
            setSeekOffset(nextTimeR)
            window.api.getVideoPlayInfo(file.path, nextTimeR)
              .then((info) => {
                setVideoUrl(info.url)
                setIsBuffering(false)
                if (videoRef.current) videoRef.current.play().catch(() => {})
              })
              .catch(() => setIsBuffering(false))
          }
          break
        }
        case 'ArrowUp': {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          const nextVolumeU = Math.min(1, volume + 0.05)
          setVolume(nextVolumeU)
          setIsMuted(false)
          if (videoMode === 'mpv') {
            window.api.sendMpvCommand('set_property', ['volume', nextVolumeU * 100])
            window.api.sendMpvCommand('set_property', ['mute', false])
          } else {
            if (videoRef.current) videoRef.current.volume = nextVolumeU
            if (videoRef.current) videoRef.current.muted = false
          }
          break
        }
        case 'ArrowDown': {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          const nextVolumeD = Math.max(0, volume - 0.05)
          setVolume(nextVolumeD)
          const isM = nextVolumeD === 0
          setIsMuted(isM)
          if (videoMode === 'mpv') {
            window.api.sendMpvCommand('set_property', ['volume', nextVolumeD * 100])
            window.api.sendMpvCommand('set_property', ['mute', isM])
          } else {
            if (videoRef.current) videoRef.current.volume = nextVolumeD
            if (videoRef.current) videoRef.current.muted = isM
          }
          break
        }
        case 'm':
        case 'M':
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          toggleMute()
          break
        case 'f':
        case 'F':
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          toggleFullscreen()
          break
      }
    }

    window.addEventListener('keydown', handleVideoKeyDown, true)
    return () => {
      window.removeEventListener('keydown', handleVideoKeyDown, true)
    }
  }, [isVideo, togglePlay, currentTime, duration, videoMode, file.path, volume, toggleMute, toggleFullscreen])

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
            background: videoMode === 'mpv' ? 'transparent' : '#000'
          }}
        >
          {(!videoError && (videoMode === 'mpv' || videoUrl)) ? (
            <>
              {videoMode === 'mpv' ? (
                <div style={{ width: '100%', height: '100%', background: 'transparent' }} />
              ) : (
                <video
                  ref={videoRef}
                  src={videoUrl || undefined}
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
              )}

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

              {/* Custom YouTube-style Video Control Overlay */}
              <div
                style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  height: '100px',
                  background: 'linear-gradient(to top, rgba(0, 0, 0, 0.9) 0%, rgba(0, 0, 0, 0.4) 50%, transparent 100%)',
                  padding: '0 20px 20px 20px',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'flex-end',
                  opacity: showControls ? 1 : 0,
                  transform: showControls ? 'translateY(0)' : 'translateY(8px)',
                  transition: 'opacity 0.25s cubic-bezier(0.22, 1, 0.36, 1), transform 0.25s cubic-bezier(0.22, 1, 0.36, 1)',
                  zIndex: 200,
                  pointerEvents: showControls ? 'auto' : 'none',
                  userSelect: 'none',
                  boxSizing: 'border-box'
                }}
              >
                <style>{`
                  #youtube-seek-bar:hover .seek-bar-track {
                    height: 6px !important;
                  }
                  #youtube-seek-bar:hover .seek-bar-scrubber {
                    transform: translate(-50%, -50%) scale(1) !important;
                  }
                `}</style>
                {/* Seek Bar */}
                <div
                  id="youtube-seek-bar"
                  onMouseMove={handleSeekBarMouseMove}
                  onMouseLeave={handleSeekBarMouseLeave}
                  onMouseDown={handleSeekBarMouseDown}
                  style={{
                    width: '100%',
                    height: '16px',
                    display: 'flex',
                    alignItems: 'center',
                    cursor: 'pointer',
                    position: 'relative',
                    marginBottom: '4px'
                  }}
                >
                  {/* Background track */}
                  <div
                    className="seek-bar-track"
                    style={{
                      width: '100%',
                      height: '4px',
                      background: 'rgba(255, 255, 255, 0.2)',
                      borderRadius: '2px',
                      position: 'relative',
                      transition: 'height 0.1s ease-in-out'
                    }}
                  >
                    {/* Playback Progress (Red fill) */}
                    <div
                      style={{
                        height: '100%',
                        width: `${duration ? (currentTime / duration) * 100 : 0}%`,
                        background: '#e11d2e',
                        borderRadius: '2px',
                        position: 'absolute',
                        left: 0,
                        top: 0
                      }}
                    />
                    {/* Scrubber knob */}
                    <div
                      className="seek-bar-scrubber"
                      style={{
                        position: 'absolute',
                        left: `${duration ? (currentTime / duration) * 100 : 0}%`,
                        top: '50%',
                        transform: isDraggingSeek ? 'translate(-50%, -50%) scale(1)' : 'translate(-50%, -50%) scale(0)',
                        width: '12px',
                        height: '12px',
                        borderRadius: '50%',
                        background: '#e11d2e',
                        transition: 'transform 0.1s ease-in-out',
                        boxShadow: '0 0 6px rgba(0,0,0,0.5)'
                      }}
                    />
                  </div>

                  {/* Time Tooltip */}
                  {hoverTime !== null && (
                    <div
                      style={{
                        position: 'absolute',
                        left: `${hoverX}px`,
                        bottom: '20px',
                        transform: 'translateX(-50%)',
                        background: 'rgba(15,15,20,0.95)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: '2px',
                        padding: '2px 6px',
                        fontSize: '9px',
                        color: '#ffffff',
                        fontWeight: 'bold',
                        pointerEvents: 'none',
                        whiteSpace: 'nowrap',
                        zIndex: 250
                      }}
                    >
                      {formatTime(hoverTime)}
                    </div>
                  )}
                </div>

                {/* Control Bar Layout */}
                <div
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    height: '36px'
                  }}
                >
                  {/* Left Controls */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                    <button
                      onClick={togglePlay}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#f2f2f0',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        padding: 0
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = '#e11d2e')}
                      onMouseLeave={(e) => (e.currentTarget.style.color = '#f2f2f0')}
                    >
                      {isPlaying ? <Pause size={18} /> : <Play size={18} />}
                    </button>

                    <div
                      style={{
                        fontSize: '11px',
                        color: '#f2f2f0',
                        fontWeight: 500,
                        letterSpacing: '0.5px'
                      }}
                    >
                      {formatTime(currentTime)} <span style={{ color: '#8a8a8f' }}>/</span> {formatTime(duration)}
                    </div>
                  </div>

                  {/* Spacer */}
                  <div style={{ flex: 1 }} />

                  {/* Right Controls */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                    {/* Volume Button + Slide Slider */}
                    <div
                      onMouseEnter={() => setVolumeHovered(true)}
                      onMouseLeave={() => setVolumeHovered(false)}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
                    >
                      <button
                        onClick={toggleMute}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: '#f2f2f0',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          padding: 0
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = '#e11d2e')}
                        onMouseLeave={(e) => (e.currentTarget.style.color = '#f2f2f0')}
                      >
                        {isMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
                      </button>

                      <div
                        style={{
                          width: volumeHovered ? '60px' : '0px',
                          opacity: volumeHovered ? 1 : 0,
                          overflow: 'hidden',
                          transition: 'width 0.2s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s cubic-bezier(0.22, 1, 0.36, 1)',
                          display: 'flex',
                          alignItems: 'center'
                        }}
                      >
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.05"
                          value={isMuted ? 0 : volume}
                          onChange={handleVolumeChange}
                          style={{
                            width: '60px',
                            height: '3px',
                            outline: 'none',
                            cursor: 'pointer',
                            accentColor: '#e11d2e',
                            background: 'rgba(255,255,255,0.2)'
                          }}
                        />
                      </div>
                    </div>

                    {/* Speed Selector */}
                    <div style={{ position: 'relative' }}>
                      <button
                        onClick={() => setShowSpeedMenu(!showSpeedMenu)}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: '#f2f2f0',
                          fontSize: '11px',
                          fontWeight: 600,
                          cursor: 'pointer',
                          padding: '4px 8px',
                          borderRadius: '2px',
                          textTransform: 'uppercase'
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = '#e11d2e')}
                        onMouseLeave={(e) => (e.currentTarget.style.color = '#f2f2f0')}
                      >
                        {playbackSpeed === 1.0 ? 'Normal' : `${playbackSpeed}x`}
                      </button>

                      {showSpeedMenu && (
                        <div
                          style={{
                            position: 'absolute',
                            bottom: '36px',
                            right: '0',
                            background: 'rgba(15, 15, 20, 0.95)',
                            border: '1px solid rgba(255,255,255,0.08)',
                            borderRadius: '4px',
                            padding: '4px 0',
                            minWidth: '100px',
                            zIndex: 300,
                            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                            display: 'flex',
                            flexDirection: 'column'
                          }}
                        >
                          {[0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0].map((speed) => (
                            <div
                              key={speed}
                              onClick={() => {
                                handleSpeedChange(speed)
                                setShowSpeedMenu(false)
                              }}
                              style={{
                                padding: '6px 12px',
                                cursor: 'pointer',
                                fontSize: '11px',
                                color: playbackSpeed === speed ? '#e11d2e' : '#f2f2f0',
                                background: playbackSpeed === speed ? 'rgba(225,29,46,0.1)' : 'transparent',
                                fontWeight: playbackSpeed === speed ? 'bold' : 'normal',
                                textAlign: 'center'
                              }}
                              onMouseEnter={(e) => {
                                if (playbackSpeed !== speed) e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                              }}
                              onMouseLeave={(e) => {
                                if (playbackSpeed !== speed) e.currentTarget.style.background = 'transparent'
                              }}
                            >
                              {speed === 1.0 ? 'Normal' : `${speed}x`}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Fullscreen Button */}
                    <button
                      onClick={toggleFullscreen}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#f2f2f0',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        padding: 0
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = '#e11d2e')}
                      onMouseLeave={(e) => (e.currentTarget.style.color = '#f2f2f0')}
                    >
                      {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                    </button>
                  </div>
                </div>
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
              <div style={{ fontSize: '12px', color: '#8a8a8f' }}>Media file could not be loaded or is missing from disk</div>
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
