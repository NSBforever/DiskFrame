import React, { useEffect, useRef, useState, useMemo } from 'react'
import Globe from 'react-globe.gl'

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
  const [dimensions, setDimensions] = useState({ width: 600, height: 400 })
  const [cameraDist, setCameraDist] = useState(260)
  const [selectedCluster, setSelectedCluster] = useState<any>(null)

  // Sync container size dynamically
  useEffect(() => {
    if (!containerRef.current) return
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height
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

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        background: '#0a0a0c',
        overflow: 'hidden',
        borderRadius: '12px'
      }}
    >
      <div style={{ position: 'absolute', top: '16px', left: '16px', zIndex: 5, pointerEvents: 'none' }}>
        <div style={{ fontSize: '15px', fontWeight: 700, color: '#f2f2f0', display: 'flex', alignItems: 'center', gap: '8px' }}>
          🌎 3D Places Globe
        </div>
        <div style={{ fontSize: '11px', color: '#8a8a8f', marginTop: '4px' }}>
          📍 {geoFiles.length} geolocation files mapped · Drag to rotate, scroll to zoom
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
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '12px'
          }}
        >
          <div style={{ fontSize: '48px' }}>🌍</div>
          <div style={{ fontSize: '14px', color: '#8a8a8f' }}>No location information available.</div>
          <div style={{ fontSize: '11px', color: '#52525b' }}>Photos containing GPS EXIF coordinates will show on the globe.</div>
        </div>
      ) : (
        <Globe
          ref={globeRef}
          width={dimensions.width}
          height={dimensions.height}
          globeImageUrl="//unpkg.com/three-globe/example/img/earth-night.jpg"
          backgroundColor="#0a0a0c"
          atmosphereColor="#e11d2e"
          htmlElementsData={clusters}
          htmlLat={(d: any) => d.lat}
          htmlLng={(d: any) => d.lng}
          htmlElement={(d: any) => {
            const el = document.createElement('div')
            const count = d.files.length
            const first = d.files[0]
            const hasThumb = !!first.thumb
            const src = hasThumb ? 'media:///' + first.thumb.replace(/\\/g, '/') : null

            el.className = 'globe-marker'
            el.style.cursor = 'pointer'

            // Style custom DOM marker
            if (src) {
              el.innerHTML = `
                <div style="width: 34px; height: 34px; border-radius: 8px; overflow: hidden; border: 2px solid #e11d2e; box-shadow: 0 0 10px rgba(225, 29, 46, 0.7); position: relative; transform: translate(-50%, -50%); transition: transform 0.2s ease-out;">
                  <img src="${src}" style="width: 100%; height: 100%; object-fit: cover;" />
                  ${count > 1 ? `<div style="position: absolute; bottom: 0; right: 0; background: #e11d2e; color: #f2f2f0; font-size: 8px; font-weight: 700; border-radius: 2px; padding: 1px 3px; line-height: 1;">${count}</div>` : ''}
                </div>
              `
            } else {
              el.innerHTML = `
                <div style="width: 22px; height: 22px; border-radius: 50%; background: #e11d2e; border: 1.5px solid #f2f2f0; box-shadow: 0 0 10px rgba(225, 29, 46, 0.7); display: flex; align-items: center; justify-content: center; color: #f2f2f0; font-size: 9px; font-weight: 700; transform: translate(-50%, -50%); transition: transform 0.2s ease-out;">
                  ${count > 1 ? count : '📍'}
                </div>
              `
            }

            el.onclick = (e) => {
              e.stopPropagation()
              setSelectedCluster(d)
            }

            // Simple scale-up hover effect
            el.onmouseenter = () => {
              const child = el.firstElementChild as HTMLElement
              if (child) child.style.transform = 'translate(-50%, -50%) scale(1.15)'
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
            borderRadius: '12px',
            overflow: 'hidden',
            border: '1px solid rgba(225, 29, 46, 0.25)',
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.8)'
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
              <div style={{ fontSize: '13px', fontWeight: 700, color: '#f2f2f0' }}>📍 Cluster Files</div>
              <div style={{ fontSize: '10px', color: '#8a8a8f', marginTop: '2px' }}>
                {selectedCluster.files.length} item{selectedCluster.files.length > 1 ? 's' : ''} at {selectedCluster.lat.toFixed(3)},{' '}
                {selectedCluster.lng.toFixed(3)}
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
                transition: 'color 0.2s'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = '#e11d2e')}
              onMouseLeave={(e) => (e.currentTarget.style.color = '#8a8a8f')}
            >
              ✕
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
              const isVideo = ['.mp4', '.mov', '.avi', '.mkv', '.wmv'].includes(file.ext.toLowerCase())
              const src = file.thumb || file.path
              const imgUrl = 'media:///' + src.replace(/\\/g, '/')
              return (
                <div
                  key={file.path}
                  onClick={() => onOpen(file, selectedCluster.files)}
                  style={{
                    aspectRatio: '1',
                    borderRadius: '6px',
                    overflow: 'hidden',
                    background: '#121214',
                    cursor: 'pointer',
                    border: '1px solid rgba(255, 255, 255, 0.05)',
                    position: 'relative',
                    transition: 'all 0.25s cubic-bezier(0.22, 1, 0.36, 1)'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = '#e11d2e'
                    e.currentTarget.style.transform = 'scale(1.05)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.05)'
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
                          borderRadius: '50%',
                          background: 'rgba(0,0,0,0.65)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '8px'
                        }}
                      >
                        ▶
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
