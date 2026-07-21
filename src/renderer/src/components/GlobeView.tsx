import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import Globe from 'react-globe.gl'
import earthDark from '../assets/earth-dark.jpg'
import {
  Globe as GlobeIcon,
  MapPin,
  AlertTriangle,
  Play,
  X
} from 'lucide-react'

const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.wmv']

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

interface GlobeViewProps {
  files: ScannedFile[]
  onOpen: (file: ScannedFile, list: ScannedFile[]) => void
}

export default function GlobeView({ files, onOpen }: GlobeViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const globeRef = useRef<any>(null)
  const [dimensions, setDimensions] = useState({ width: 600, height: 450 })
  const [cameraDist, setCameraDist] = useState(260)
  const [selectedCluster, setSelectedCluster] = useState<any>(null)
  const [hasError, setHasError] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  // Earth texture loading validation logger
  useEffect(() => {
    console.log('[GlobeView] Testing texture loading path:', earthDark)
    const img = new Image()
    img.src = earthDark
    img.onload = () => {
      console.log('[GlobeView] Success: Earth texture image loaded successfully inside renderer context.')
    }
    img.onerror = (err) => {
      console.error('[GlobeView] Error: Earth texture image failed to load. Source URL:', earthDark, err)
    }
  }, [])

  // Listen for WebGL context creation failures
  useEffect(() => {
    const handleGlobalError = (event: ErrorEvent) => {
      if (
        event.message?.includes('globe') || 
        event.message?.includes('WebGL') || 
        event.message?.includes('three')
      ) {
        setHasError(true)
        setErrorMsg(event.message || 'WebGL initialization error')
      }
    }
    window.addEventListener('error', handleGlobalError)
    return () => window.removeEventListener('error', handleGlobalError)
  }, [])

  // Sync container size dynamically with ResizeObserver
  useEffect(() => {
    if (!containerRef.current) return
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width
        const h = entry.contentRect.height
        setDimensions({
          width: w > 50 ? w : 600,
          height: h > 50 ? h : 450
        })
      }
    })
    resizeObserver.observe(containerRef.current)
    return () => resizeObserver.disconnect()
  }, [])

  // Poll for orbit controls and attach zoom / altitude listener
  useEffect(() => {
    let timer: NodeJS.Timeout
    const setupControlsListener = () => {
      if (globeRef.current) {
        const controls = globeRef.current.controls()
        if (controls) {
          const handleControlsChange = () => {
            const pos = globeRef.current.camera().position
            const dist = Math.sqrt(pos.x ** 2 + pos.y ** 2 + pos.z ** 2)
            setCameraDist(dist)
          }
          controls.addEventListener('change', handleControlsChange)
          handleControlsChange()
          return
        }
      }
      timer = setTimeout(setupControlsListener, 150)
    }
    setupControlsListener()
    return () => clearTimeout(timer)
  }, [])

  // Filter coordinates
  const geoFiles = useMemo(() => files.filter((f) => f.lat !== null && f.lng !== null), [files])

  // Determine grid scale for clustering based on camera distance (zoom level)
  const cellSize = useMemo(() => {
    if (cameraDist < 140) return 0.001  // No clustering (show individual pins)
    if (cameraDist < 185) return 0.04   // Tight neighborhood clustering
    if (cameraDist < 230) return 0.15   // Regional clustering
    return 0.5                          // Wide city-level clustering
  }, [cameraDist])

  // Cluster coordinate markers
  const clusters = useMemo(() => {
    const groups: Record<string, { lat: number; lng: number; files: ScannedFile[] }> = {}
    for (const file of geoFiles) {
      if (file.lat === null || file.lng === null) continue
      const latGrid = Math.round(file.lat / cellSize) * cellSize
      const lngGrid = Math.round(file.lng / cellSize) * cellSize
      const key = `${latGrid.toFixed(4)},${lngGrid.toFixed(4)}`
      if (!groups[key]) {
        groups[key] = { lat: latGrid, lng: lngGrid, files: [] }
      }
      groups[key].files.push(file)
    }
    return Object.values(groups)
  }, [geoFiles, cellSize])

  const handleMarkerClick = useCallback((d: any) => {
    setSelectedCluster(d)
  }, [])

  if (hasError) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '12px',
          background: '#0a0a0c',
          border: '1px solid rgba(225, 29, 46, 0.2)',
          borderRadius: '4px'
        }}
      >
        <AlertTriangle size={32} style={{ color: '#e11d2e' }} />
        <div style={{ fontSize: '13px', fontWeight: 700, color: '#f2f2f0', textTransform: 'uppercase', letterSpacing: '1px' }}>Globe Failed to Load</div>
        <div style={{ fontSize: '11px', color: '#8a8a8f', maxWidth: '80%', textAlign: 'center', lineHeight: '1.4' }}>
          {errorMsg || 'Could not instantiate WebGL canvas context. Ensure hardware acceleration is enabled.'}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        background: '#0a0a0c',
        overflow: 'hidden',
        borderRadius: '4px'
      }}
    >
      <div style={{ position: 'absolute', top: '16px', left: '16px', zIndex: 5, pointerEvents: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', fontSize: '11px', color: '#e11d2e', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px' }}>
          <GlobeIcon size={12} style={{ marginRight: '4px' }} /> 3D Places Globe
        </div>
        <div style={{ fontSize: '9px', color: '#8a8a8f', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          {geoFiles.length} Mapped Coordinates · Drag to rotate, scroll to zoom
        </div>
      </div>

      {geoFiles.length === 0 ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            background: '#0a0a0c',
            border: '1px solid rgba(255,255,255,0.05)',
            borderRadius: '4px'
          }}
        >
          <GlobeIcon size={48} style={{ color: '#52525b' }} />
          <div style={{ fontSize: '13px', color: '#8a8a8f', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px' }}>No Mapped Locations</div>
          <div style={{ fontSize: '11px', color: '#52525b' }}>Photos containing GPS EXIF coordinates will show on the globe.</div>
        </div>
      ) : (
        <Globe
          ref={globeRef}
          width={dimensions.width}
          height={dimensions.height}
          globeImageUrl={earthDark}
          backgroundColor="#0a0a0c"
          atmosphereColor="#e11d2e"
          htmlElementsData={clusters}
          htmlLat={(d: any) => d.lat}
          htmlLng={(d: any) => d.lng}
          onGlobeReady={() => {
            console.log('[GlobeView] Globe component completed loading and is fully initialized.')
          }}
          htmlElement={(d: any) => {
            const el = document.createElement('div')
            const count = d.files.length
            const first = d.files[0]
            const hasThumb = !!first.thumb
            const src = hasThumb ? 'media:///' + first.thumb.replace(/\\/g, '/') : null

            el.className = 'globe-marker'
            el.style.cursor = 'pointer'

            // Style custom DOM marker with CRED design guidelines
            if (src) {
              el.innerHTML = `
                <div style="width: 32px; height: 32px; border-radius: 4px; overflow: hidden; border: 1.5px solid #e11d2e; box-shadow: 0 0 10px rgba(225, 29, 46, 0.4); position: relative; transform: translate(-50%, -50%); transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);">
                  <img src="${src}" style="width: 100%; height: 100%; object-fit: cover;" />
                  ${count > 1 ? `<div style="position: absolute; bottom: 0; right: 0; background: #e11d2e; color: #f2f2f0; font-size: 8px; font-weight: 700; padding: 1px 3px; line-height: 1; border-top-left-radius: 2px;">${count}</div>` : ''}
                </div>
              `
            } else {
              el.innerHTML = `
                <div style="width: 20px; height: 20px; border-radius: 4px; background: #e11d2e; border: 1.5px solid #f2f2f0; box-shadow: 0 0 10px rgba(225, 29, 46, 0.4); display: flex; align-items: center; justify-content: center; color: #f2f2f0; font-size: 9px; font-weight: 700; transform: translate(-50%, -50%); transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);">
                  ${count > 1 ? count : '📍'}
                </div>
              `
            }

            el.onclick = (e) => {
              e.stopPropagation()
              handleMarkerClick(d)
            }

            // GPU friendly scale hover transitions
            el.onmouseenter = () => {
              const child = el.firstElementChild as HTMLElement
              if (child) child.style.transform = 'translate(-50%, -50%) scale(1.1)'
            }
            el.onmouseleave = () => {
              const child = el.firstElementChild as HTMLElement
              if (child) child.style.transform = 'translate(-50%, -50%) scale(1)'
            }

            return el
          }}
        />
      )}

      {/* Slide overlay for photo previews in cluster */}
      {selectedCluster && (
        <div
          style={{
            position: 'absolute',
            top: '12px',
            right: '12px',
            bottom: '12px',
            width: '320px',
            zIndex: 10,
            display: 'flex',
            flexDirection: 'column',
            borderRadius: '4px',
            overflow: 'hidden',
            border: '1px solid rgba(225, 29, 46, 0.25)',
            boxShadow: 'none'
          }}
          className="cred-glass"
        >
          {/* Header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '14px 18px',
              borderBottom: '1px solid rgba(225, 29, 46, 0.2)'
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', fontWeight: 700, color: '#f2f2f0', textTransform: 'uppercase', letterSpacing: '1px' }}>
                <MapPin size={12} color="#e11d2e" /> Cluster Files
              </div>
              <div style={{ fontSize: '9px', color: '#8a8a8f', marginTop: '2px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {selectedCluster.files.length} item{selectedCluster.files.length > 1 ? 's' : ''} · {selectedCluster.lat.toFixed(3)}, {selectedCluster.lng.toFixed(3)}
              </div>
            </div>
            <button
              onClick={() => setSelectedCluster(null)}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#8a8a8f',
                fontSize: '18px',
                cursor: 'pointer',
                transition: 'transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1), color 0.15s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = '#e11d2e'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = '#8a8a8f'
              }}
              onMouseDown={(e) => {
                e.currentTarget.style.transform = 'scale(0.85)'
              }}
              onMouseUp={(e) => {
                e.currentTarget.style.transform = 'scale(1)'
              }}
            >
              <X size={16} />
            </button>
          </div>

          {/* Grid List */}
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '12px',
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: '6px'
            }}
          >
            {selectedCluster.files.map((file: ScannedFile) => {
              const isVideo = videoExts.includes(file.ext.toLowerCase())
              const src = file.thumb || file.path
              const imgUrl = 'media:///' + src.replace(/\\/g, '/')
              return (
                <div
                  key={file.path}
                  onClick={() => onOpen(file, selectedCluster.files)}
                  style={{
                    aspectRatio: '1',
                    borderRadius: '4px',
                    overflow: 'hidden',
                    background: '#121214',
                    cursor: 'pointer',
                    border: '1px solid rgba(255, 255, 255, 0.05)',
                    position: 'relative',
                    transition: 'transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1), border-color 0.15s'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = '#e11d2e'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.05)'
                  }}
                  onMouseDown={(e) => {
                    e.currentTarget.style.transform = 'scale(0.95)'
                  }}
                  onMouseUp={(e) => {
                    e.currentTarget.style.transform = 'scale(1)'
                  }}
                >
                  <img src={imgUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  {isVideo && (
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'rgba(0,0,0,0.2)'
                      }}
                    >
                      <div
                        style={{
                          width: '18px',
                          height: '18px',
                          borderRadius: '4px',
                          background: 'rgba(0,0,0,0.65)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: '#f2f2f0',
                          padding: 0
                        }}
                      >
                        <Play size={10} fill="#f2f2f0" stroke="none" />
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
