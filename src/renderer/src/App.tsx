import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import MediaViewer from './components/media-viewer/MediaViewer'

interface DriveInfo {
  name: string
  filesystem: string
  total: number
  used: number
  free: number
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

const photoExts = ['.jpg', '.jpeg', '.png', '.webp', '.heic']
const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.wmv']
const docExts = ['.pdf', '.docx', '.doc', '.txt', '.xlsx', '.pptx', '.csv']
const MONTH_ORDER = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const SHORT_MONTH_ORDER = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function thumbUrl(file: ScannedFile): string {
  const src = file.thumb || file.path
  return 'media:///' + src.replace(/\\/g, '/')
}

function FileTile({
  file, onOpen, onFav, isFav, isSelected, onSelect, onContextMenu, tileSize
}: {
  file: ScannedFile
  onOpen: (f: ScannedFile) => void
  onFav: (f: ScannedFile) => void
  isFav: boolean
  isSelected: boolean
  onSelect: (f: ScannedFile, e: React.MouseEvent) => void
  onContextMenu: (f: ScannedFile, e: React.MouseEvent) => void
  tileSize: number
}): React.JSX.Element {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)
  const [hovered, setHovered] = useState(false)
  const isPhoto = photoExts.includes(file.ext.toLowerCase())
  const isVideo = videoExts.includes(file.ext.toLowerCase())
  const isDoc = docExts.includes(file.ext.toLowerCase())
  const hasThumb = !!file.thumb
  const imgKey = file.thumb ?? 'no-thumb'

  useEffect(() => { setLoaded(false); setError(false) }, [file.thumb])

  const fontSize = tileSize < 80 ? '20px' : '28px'
  const subFontSize = tileSize < 80 ? '7px' : '9px'

  return (
    <div
      onClick={() => onOpen(file)}
      onContextMenu={(e) => onContextMenu(file, e)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        borderRadius: tileSize < 80 ? '8px' : '12px', aspectRatio: '1', cursor: 'pointer',
        overflow: 'hidden', background: '#121215', position: 'relative',
        border: `1px solid ${isSelected ? '#6c6cff' : hovered ? 'rgba(108,108,255,0.4)' : 'rgba(255,255,255,0.06)'}`,
        outline: isSelected ? '2px solid #6c6cff' : 'none', outlineOffset: '2px',
        transform: hovered ? 'scale(1.02) translateY(-2px)' : 'scale(1) translateY(0)',
        boxShadow: hovered ? '0 12px 24px rgba(108,108,255,0.12), 0 6px 12px rgba(0,0,0,0.5)' : '0 2px 8px rgba(0,0,0,0.2)',
        transition: 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)', zIndex: hovered ? 2 : 1
      }}
    >
      {isPhoto && !error ? (
        <>
          {!loaded && (
            <div style={{ position: 'absolute', inset: 0, background: '#121215', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ width: '16px', height: '16px', border: '1.5px solid #202025', borderTop: '1.5px solid #6c6cff', borderRadius: '50%', animation: 'tileSpin 0.8s linear infinite' }} />
            </div>
          )}
          <img key={imgKey} src={thumbUrl(file)} loading="eager" decoding="async"
            onLoad={() => setLoaded(true)} onError={() => { setError(true); setLoaded(true) }}
            style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: loaded ? 1 : 0, transform: hovered ? 'scale(1.04)' : 'scale(1)', transition: 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s', willChange: 'transform' }}
          />
        </>
      ) : isVideo ? (
        hasThumb && !error ? (
          <>
            {!loaded && (
              <div style={{ position: 'absolute', inset: 0, background: '#121215', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ width: '16px', height: '16px', border: '1.5px solid #202025', borderTop: '1.5px solid #a060ff', borderRadius: '50%', animation: 'tileSpin 0.8s linear infinite' }} />
              </div>
            )}
            <img key={imgKey} src={thumbUrl(file)} loading="eager" decoding="async"
              onLoad={() => setLoaded(true)} onError={() => { setError(true); setLoaded(true) }}
              style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: loaded ? 1 : 0, transform: hovered ? 'scale(1.04)' : 'scale(1)', transition: 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s', willChange: 'transform' }}
            />
            {loaded && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.2)' }}>
                <div style={{ width: '26px', height: '26px', borderRadius: '50%', background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px' }}>▶</div>
              </div>
            )}
          </>
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px', background: '#1a1020' }}>
            <div style={{ fontSize }}>🎬</div>
            <div style={{ fontSize: subFontSize, color: '#7070a0' }}>{file.ext}</div>
            {tileSize >= 80 && <div style={{ fontSize: '8px', color: '#44444e', maxWidth: '90%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</div>}
          </div>
        )
      ) : isDoc ? (
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px', background: '#101a20' }}>
          <div style={{ fontSize }}>{file.ext === '.pdf' ? '📕' : '📄'}</div>
          <div style={{ fontSize: subFontSize, color: '#7070a0' }}>{file.ext}</div>
          {tileSize >= 80 && <div style={{ fontSize: '8px', color: '#44444e', maxWidth: '90%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</div>}
        </div>
      ) : (
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
          <div style={{ fontSize }}>🖼️</div>
          <div style={{ fontSize: subFontSize, color: '#44444e' }}>{file.ext}</div>
        </div>
      )}

      {tileSize >= 70 && (
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, padding: '20px 6px 5px',
          background: 'linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.4) 50%, transparent 100%)',
          display: 'flex', alignItems: 'flex-end',
          opacity: hovered ? 1 : 0, transform: hovered ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)', pointerEvents: 'none'
        }}>
          <div style={{ fontSize: '9px', fontWeight: 500, color: '#e8e8f4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%' }}>{file.name}</div>
        </div>
      )}

      <div onClick={(e) => { e.stopPropagation(); onSelect(file, e) }}
        style={{ position: 'absolute', top: '4px', left: '4px', width: '16px', height: '16px', borderRadius: '4px', background: isSelected ? '#6c6cff' : 'rgba(0,0,0,0.6)', border: `1.5px solid ${isSelected ? '#6c6cff' : 'rgba(255,255,255,0.3)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '9px', cursor: 'pointer', color: '#fff', opacity: hovered || isSelected ? 1 : 0, transition: 'opacity 0.15s' }}
      >{isSelected ? '✓' : ''}</div>

      {tileSize >= 70 && (
        <div onClick={(e) => { e.stopPropagation(); onFav(file) }}
          style={{ position: 'absolute', top: '4px', right: '4px', width: '20px', height: '20px', borderRadius: '50%', background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', cursor: 'pointer', opacity: hovered || isFav ? 1 : 0, transition: 'opacity 0.15s' }}
        >{isFav ? '❤️' : '🤍'}</div>
      )}
    </div>
  )
}

function YearsView({ groupedFiles, onYearClick }: { groupedFiles: Record<string, ScannedFile[]>; onYearClick: (year: string) => void }): React.JSX.Element {
  const yearMap: Record<string, ScannedFile[]> = {}
  for (const [key, files] of Object.entries(groupedFiles)) {
    const year = key.split('-')[0]
    if (!yearMap[year]) yearMap[year] = []
    yearMap[year].push(...files)
  }
  const years = Object.keys(yearMap).sort((a, b) => Number(b) - Number(a))

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '16px', padding: '8px 0' }}>
      {years.map(year => {
        const files = yearMap[year]
        const previewFiles = [...files.filter(f => f.thumb), ...files.filter(f => photoExts.includes(f.ext.toLowerCase()) && !f.thumb)].slice(0, 4)
        return (
          <div key={year} onClick={() => onYearClick(year)}
            style={{ background: '#121215', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.06)', overflow: 'hidden', cursor: 'pointer', transition: 'transform 0.25s, border-color 0.25s, box-shadow 0.25s' }}
            onMouseEnter={e => { const el = e.currentTarget as HTMLDivElement; el.style.borderColor = '#6c6cff'; el.style.transform = 'scale(1.02)'; el.style.boxShadow = '0 8px 24px rgba(108,108,255,0.15)' }}
            onMouseLeave={e => { const el = e.currentTarget as HTMLDivElement; el.style.borderColor = 'rgba(255,255,255,0.06)'; el.style.transform = 'scale(1)'; el.style.boxShadow = 'none' }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', height: '140px' }}>
              {[0, 1, 2, 3].map(i => {
                const f = previewFiles[i]
                const src = f ? ('media:///' + (f.thumb || f.path).replace(/\\/g, '/')) : null
                return (
                  <div key={i} style={{ background: '#18181c', overflow: 'hidden', borderRight: i % 2 === 0 ? '1px solid #0f0f10' : undefined, borderBottom: i < 2 ? '1px solid #0f0f10' : undefined, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {src ? <YearThumb src={src} /> : <div style={{ fontSize: '20px', opacity: 0.15 }}>📷</div>}
                  </div>
                )
              })}
            </div>
            <div style={{ padding: '12px 14px 14px' }}>
              <div style={{ fontSize: '20px', fontWeight: 700, color: '#f0f0f4', letterSpacing: '-0.3px' }}>{year}</div>
              <div style={{ fontSize: '11px', color: '#606080', marginTop: '2px' }}>{files.length} files</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function YearThumb({ src }: { src: string }): React.JSX.Element {
  const [err, setErr] = useState(false)
  if (err) return <div style={{ fontSize: '20px', opacity: 0.15 }}>📷</div>
  return <img src={src} onError={() => setErr(true)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
}

function MapView({ files, onOpen }: { files: ScannedFile[]; onOpen: (f: ScannedFile, list: ScannedFile[]) => void }): React.JSX.Element {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<L.Map | null>(null)
  const geoFiles = files.filter(f => f.lat && f.lng)

  useEffect(() => {
    if (!mapRef.current) return
    if (mapInstanceRef.current) { mapInstanceRef.current.remove(); mapInstanceRef.current = null }

    const map = L.map(mapRef.current, { zoomControl: true, attributionControl: false }).setView([20, 0], 2)
    mapInstanceRef.current = map
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map)

    const grouped: Record<string, ScannedFile[]> = {}
    geoFiles.forEach(file => {
      if (!file.lat || !file.lng) return
      const key = `${Math.round(file.lat * 10) / 10},${Math.round(file.lng * 10) / 10}`
      if (!grouped[key]) grouped[key] = []
      grouped[key].push(file)
    })

    Object.entries(grouped).forEach(([, clusterFiles]) => {
      const first = clusterFiles[0]
      if (!first.lat || !first.lng) return
      const count = clusterFiles.length
      const hasThumb = !!first.thumb
      const iconHtml = hasThumb
        ? `<div style="width:44px;height:44px;border-radius:8px;overflow:hidden;border:2px solid #6c6cff;box-shadow:0 2px 8px rgba(0,0,0,0.5);position:relative;"><img src="media:///${first.thumb!.replace(/\\/g, '/')}" style="width:100%;height:100%;object-fit:cover;" />${count > 1 ? `<div style="position:absolute;bottom:2px;right:2px;background:rgba(108,108,255,0.9);color:#fff;font-size:9px;font-weight:700;border-radius:3px;padding:1px 3px;">${count}</div>` : ''}</div>`
        : `<div style="width:36px;height:36px;border-radius:50%;background:#6c6cff;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700;">${count > 1 ? count : '📍'}</div>`
      const icon = L.divIcon({ html: iconHtml, className: '', iconSize: hasThumb ? [44, 44] : [36, 36], iconAnchor: hasThumb ? [22, 44] : [18, 36] })
      const marker = L.marker([first.lat, first.lng], { icon })
      const thumbsHtml = clusterFiles.slice(0, 4).map(f => {
        const src = f.thumb ? `media:///${f.thumb.replace(/\\/g, '/')}` : ''
        return src ? `<img src="${src}" style="width:56px;height:56px;object-fit:cover;border-radius:4px;" />` : `<div style="width:56px;height:56px;background:#2a2a3a;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:18px;">${videoExts.includes(f.ext) ? '🎬' : '📄'}</div>`
      }).join('')
      marker.bindPopup(`<div style="font-size:12px;min-width:140px;font-family:system-ui,sans-serif;"><div style="font-weight:600;margin-bottom:6px;color:#e0e0f0;">${count} file${count > 1 ? 's' : ''}</div><div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;">${thumbsHtml}</div><div style="font-size:10px;color:#8080a0;">${new Date(first.date).toLocaleDateString()}</div>${count > 4 ? `<div style="font-size:10px;color:#6c6cff;margin-top:2px;">+${count - 4} more</div>` : ''}</div>`, { maxWidth: 200 })
      
      // Zoom in on cluster click, open viewer on single photo click
      marker.on('click', () => {
        if (count > 1) {
          map.setView([first.lat!, first.lng!], map.getZoom() + 2)
        } else {
          onOpen(first, clusterFiles)
        }
      })
      marker.addTo(map)
    })

    if (geoFiles.length > 0) {
      const lats = geoFiles.map(f => f.lat!)
      const lngs = geoFiles.map(f => f.lng!)
      map.fitBounds(L.latLngBounds([Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]), { padding: [40, 40], maxZoom: 12 })
    }

    return () => { map.remove(); mapInstanceRef.current = null }
  }, [files, geoFiles, onOpen])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ marginBottom: '10px', fontSize: '12px', color: '#7070a0' }}>
        📍 {geoFiles.length} files with GPS location
        {geoFiles.length === 0 && <span style={{ color: '#3a3a48', marginLeft: '8px' }}>— photos need GPS EXIF data (usually from phone camera)</span>}
      </div>
      {geoFiles.length === 0 ? (
        <div style={{ flex: 1, background: '#121214', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
          <div style={{ fontSize: '48px' }}>🗺️</div>
          <div style={{ fontSize: '14px', color: '#8888a0' }}>No location information available.</div>
          <div style={{ fontSize: '11px', color: '#4a4a58' }}>Photos with GPS EXIF metadata will be plotted here.</div>
        </div>
      ) : (
        <div ref={mapRef} style={{ flex: 1, borderRadius: '12px', overflow: 'hidden', minHeight: '400px' }} />
      )}
    </div>
  )
}

export default function App(): React.JSX.Element {
  const [activeNav, setActiveNav] = useState('all')
  const [drives, setDrives] = useState<DriveInfo[]>([])
  const [selectedDrive, setSelectedDrive] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanCount, setScanCount] = useState(0)
  const [driveFiles, setDriveFiles] = useState<Record<string, Record<string, ScannedFile[]>>>({})
  const currentDriveRef = useRef<string | null>(null)
  const [favourites, setFavourites] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lightbox, setLightbox] = useState<{ file: ScannedFile; list: ScannedFile[] } | null>(null)
  const [activeView, setActiveView] = useState('Grid')
  const [visibleCount, setVisibleCount] = useState<Record<string, number>>({})
  const listenersSet = useRef(false)

  const zoomLevelRef = useRef(1.0)
  const [tileSize, setTileSize] = useState(100)
  const [transitioning, setTransitioning] = useState(false)
  const monthRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const lastCenteredMonth = useRef<string | null>(null)
  const [yearFilter, setYearFilter] = useState<string | null>(null)
  const zoomTicksRef = useRef(0)
  const lastZoomDirRef = useRef<'in' | 'out' | null>(null)
  const scrollTopRef = useRef(0)
  const [scrollVersion, setScrollVersion] = useState(0)
  const rafRef = useRef<number | null>(null)

  // Redesign state
  const [groupBy, setGroupBy] = useState<'day' | 'month' | 'year' | 'location' | 'favorites'>('day')
  const [searchQuery, setSearchQuery] = useState('')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: ScannedFile; currentList: ScannedFile[] } | null>(null)
  const [fileToDelete, setFileToDelete] = useState<ScannedFile | null>(null)
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState(false)

  const getCenteredMonth = useCallback(() => {
    let closest = ''; let minDiff = Infinity
    const center = window.innerHeight / 2
    for (const [key, el] of Object.entries(monthRefs.current)) {
      if (!el) continue
      const rect = el.getBoundingClientRect()
      const diff = Math.abs(rect.top - center)
      if (diff < minDiff) { minDiff = diff; closest = key }
    }
    return closest
  }, [])

  useEffect(() => {
    const preventZoom = (e: WheelEvent): void => { if (e.ctrlKey) e.preventDefault() }
    window.addEventListener('wheel', preventZoom, { passive: false })
    return () => window.removeEventListener('wheel', preventZoom)
  }, [])

  useEffect(() => {
    if (!transitioning && lastCenteredMonth.current && monthRefs.current[lastCenteredMonth.current]) {
      monthRefs.current[lastCenteredMonth.current]?.scrollIntoView({ behavior: 'instant', block: 'start' })
      lastCenteredMonth.current = null
    }
  }, [activeView, transitioning])

  const handleWheel = useCallback((e: React.WheelEvent): void => {
    if (!e.ctrlKey) return
    e.preventDefault()
    if (activeView !== 'Grid' && activeView !== 'Timeline' && activeView !== 'Years') return

    const dir: 'in' | 'out' = e.deltaY > 0 ? 'out' : 'in'
    if (dir !== lastZoomDirRef.current) { zoomTicksRef.current = 0; lastZoomDirRef.current = dir }
    zoomTicksRef.current++

    const newZoom = Math.max(0.3, Math.min(1.0, zoomLevelRef.current + (dir === 'in' ? 0.025 : -0.025)))
    zoomLevelRef.current = newZoom
    const newTileSize = Math.max(55, Math.round(100 * Math.min(newZoom * 1.8, 1)))
    setTileSize(newTileSize)

    if (transitioning) return

    if (activeView === 'Grid' && newTileSize <= 58 && zoomTicksRef.current >= 3) {
      lastCenteredMonth.current = getCenteredMonth()
      setTransitioning(true); zoomTicksRef.current = 0
      setTimeout(() => { setActiveView('Timeline'); zoomLevelRef.current = 1.0; setTileSize(100); setTransitioning(false) }, 320)
      return
    }
    if (activeView === 'Timeline' && dir === 'in' && zoomTicksRef.current >= 3) {
      lastCenteredMonth.current = getCenteredMonth()
      setTransitioning(true); zoomTicksRef.current = 0
      setTimeout(() => { setActiveView('Grid'); zoomLevelRef.current = 1.0; setTileSize(100); setTransitioning(false) }, 320)
      return
    }
    if (activeView === 'Timeline' && dir === 'out' && zoomTicksRef.current >= 4) {
      setTransitioning(true); zoomTicksRef.current = 0
      setTimeout(() => { setActiveView('Years'); zoomLevelRef.current = 1.0; setTileSize(100); setTransitioning(false) }, 320)
      return
    }
    if (activeView === 'Years' && dir === 'in' && zoomTicksRef.current >= 3) {
      setTransitioning(true); zoomTicksRef.current = 0
      setTimeout(() => { setActiveView('Timeline'); zoomLevelRef.current = 1.0; setTileSize(100); setTransitioning(false) }, 320)
      return
    }
  }, [activeView, transitioning, getCenteredMonth])

  useEffect(() => {
    if (listenersSet.current) return
    listenersSet.current = true

    window.api.onDrivesUpdated((d) => setDrives(d as DriveInfo[]))
    window.api.onFavouritesUpdated((files) => {
      setFavourites(new Set((files as Array<{ path: string }>).map(f => f.path)))
    })
    window.api.onScanProgress((d) => setScanCount(d.count))
    window.api.onScanComplete((d) => {
      setScanning(false); setScanCount(d.count)
      currentDriveRef.current = d.drive
      window.api.getFiles(d.drive)
    })
    window.api.onFilesUpdated((g) => {
      if (currentDriveRef.current) {
        setDriveFiles(prev => ({ ...prev, [currentDriveRef.current!]: g as Record<string, ScannedFile[]> }))
      }
    })
    window.api.onThumbReady(({ filePath, thumbPath }) => {
      setDriveFiles(prev => {
        const updated: Record<string, Record<string, ScannedFile[]>> = {}
        for (const drive in prev) {
          updated[drive] = {}
          for (const month in prev[drive]) {
            updated[drive][month] = prev[drive][month].map(f =>
              f.path === filePath ? { ...f, thumb: thumbPath } : f
            )
          }
        }
        return updated
      })
    })
    window.api.onFavouriteToggled((p) => {
      setFavourites(prev => {
        const next = new Set(prev)
        if (next.has(p as string)) next.delete(p as string); else next.add(p as string)
        return next
      })
    })

    window.api.getDrives()
    window.api.getFavourites()
  }, [])

  const handleDriveClick = (name: string): void => {
    setSelectedDrive(name); currentDriveRef.current = name
    setScanning(true); setScanCount(0); setActiveNav('all'); setActiveView('Grid')
    zoomLevelRef.current = 1.0; setTileSize(100); setSelected(new Set()); setVisibleCount({})
    window.api.scanDrive(name)
  }

  const handleRescan = (name: string): void => {
    setScanning(true); setScanCount(0); currentDriveRef.current = name
    setSelected(new Set()); setVisibleCount({})
    window.electron.ipcRenderer.send('rescan-drive', name)
  }

  const handleFav = useCallback((file: ScannedFile): void => { window.api.toggleFavourite(file.path) }, [])

  const handleReveal = useCallback((file: ScannedFile): void => { window.electron.ipcRenderer.send('reveal-file', file.path) }, [])
  const openLightbox = useCallback((file: ScannedFile, list: ScannedFile[]): void => { setLightbox({ file, list }) }, [])

  const groupedFiles = selectedDrive && driveFiles[selectedDrive] ? driveFiles[selectedDrive] : {}
  const months = Object.keys(groupedFiles).sort((a, b) => {
    const [ay, am] = a.split('-')
    const [by, bm] = b.split('-')
    const yearA = Number(ay)
    const yearB = Number(by)
    if (yearB !== yearA) return yearB - yearA

    const getMonthIndex = (m: string): number => {
      const clean = m.trim().toLowerCase()
      const longIdx = MONTH_ORDER.findIndex(mo => mo.toLowerCase() === clean)
      if (longIdx !== -1) return longIdx
      const shortIdx = SHORT_MONTH_ORDER.findIndex(mo => mo.toLowerCase() === clean)
      if (shortIdx !== -1) return shortIdx
      const prefixIdx = SHORT_MONTH_ORDER.findIndex(mo => mo.toLowerCase().startsWith(clean.substring(0, 3)))
      if (prefixIdx !== -1) return prefixIdx
      return -1
    }

    return getMonthIndex(bm) - getMonthIndex(am)
  })

  // Close context menu helper
  useEffect(() => {
    const closeMenu = () => setContextMenu(null)
    window.addEventListener('click', closeMenu)
    return () => window.removeEventListener('click', closeMenu)
  }, [])

  const getFiltered = useCallback((files: ScannedFile[]): ScannedFile[] => {
    let filtered = files

    // Category routing
    if (activeNav === 'photos') {
      filtered = filtered.filter(f => photoExts.includes(f.ext.toLowerCase()))
    } else if (activeNav === 'videos') {
      filtered = filtered.filter(f => videoExts.includes(f.ext.toLowerCase()))
    } else if (activeNav === 'docs') {
      filtered = filtered.filter(f => docExts.includes(f.ext.toLowerCase()))
    } else if (activeNav === 'screenshots') {
      filtered = filtered.filter(f => f.path.toLowerCase().includes('screenshot') || f.path.toLowerCase().includes('screen shot'))
    } else if (activeNav === 'places') {
      filtered = filtered.filter(f => f.lat !== null && f.lng !== null)
    } else if (activeNav === 'favourites') {
      filtered = filtered.filter(f => favourites.has(f.path))
    } else if (activeNav === 'archive' || activeNav === 'trash') {
      return []
    }

    // Advanced search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim()
      if (q === 'is:fav' || q === 'fav:true') {
        filtered = filtered.filter(f => favourites.has(f.path))
      } else if (q.startsWith('ext:')) {
        const targetExt = q.slice(4).trim()
        filtered = filtered.filter(f => f.ext.toLowerCase() === targetExt || f.ext.toLowerCase() === '.' + targetExt)
      } else if (q.startsWith('date:')) {
        const targetDate = q.slice(5).trim()
        filtered = filtered.filter(f => {
          const d = new Date(f.date)
          const year = d.getFullYear().toString()
          const month = d.toLocaleString('default', { month: 'long' }).toLowerCase()
          const day = d.getDate().toString()
          return year.includes(targetDate) || month.includes(targetDate) || day === targetDate
        })
      } else if (q.startsWith('camera:')) {
        const targetCamera = q.slice(7).trim()
        filtered = filtered.filter(f => f.path.toLowerCase().includes(targetCamera))
      } else if (q.startsWith('loc:')) {
        const targetLoc = q.slice(4).trim()
        filtered = filtered.filter(f => f.path.toLowerCase().includes(targetLoc))
      } else {
        filtered = filtered.filter(f => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
      }
    }

    return filtered
  }, [activeNav, favourites, searchQuery])

  const allFiles = Object.values(groupedFiles).flat()
  const allFavFiles = allFiles.filter(f => favourites.has(f.path))
  const totalFiles = allFiles.length
  const getVisible = (key: string): number => visibleCount[key] ?? 40

  // Multi-selection range select and batch action handlers
  const lastSelectedPathRef = useRef<string | null>(null)
  
  const handleSelect = useCallback((file: ScannedFile, e: React.MouseEvent): void => {
    setSelected(prev => {
      const next = new Set(prev)
      const isSelected = next.has(file.path)

      if (e.shiftKey && lastSelectedPathRef.current) {
        const allGridFiles = months.flatMap(monthKey => getFiltered(groupedFiles[monthKey] || []))
        const lastIdx = allGridFiles.findIndex(f => f.path === lastSelectedPathRef.current)
        const currentIdx = allGridFiles.findIndex(f => f.path === file.path)

        if (lastIdx !== -1 && currentIdx !== -1) {
          const start = Math.min(lastIdx, currentIdx)
          const end = Math.max(lastIdx, currentIdx)
          const rangeFiles = allGridFiles.slice(start, end + 1)
          const shouldSelect = !isSelected
          for (const f of rangeFiles) {
            if (shouldSelect) next.add(f.path); else next.delete(f.path)
          }
        }
      } else {
        if (isSelected) next.delete(file.path); else next.add(file.path)
      }

      lastSelectedPathRef.current = file.path
      return next
    })
  }, [months, groupedFiles, activeNav, getFiltered])

  const handleTileOpen = useCallback((file: ScannedFile, currentList: ScannedFile[]): void => {
    if (selected.size > 0 && selected.has(file.path)) {
      const selectionList = allFiles.filter(f => selected.has(f.path))
      openLightbox(file, selectionList)
    } else {
      openLightbox(file, currentList)
    }
  }, [selected, allFiles, openLightbox])

  const handleFileDeleted = useCallback((deletedPath: string): void => {
    setSelected(prev => {
      const next = new Set(prev)
      next.delete(deletedPath)
      return next
    })
    if (selectedDrive) {
      window.api.getFiles(selectedDrive)
    }
  }, [selectedDrive])

  const handleBatchFavorite = useCallback(async (): Promise<void> => {
    for (const path of selected) {
      window.api.toggleFavourite(path)
    }
    setSelected(new Set())
  }, [selected])

  const handleBatchDelete = useCallback((): void => {
    if (selected.size > 0) {
      setShowBatchDeleteConfirm(true)
    }
  }, [selected])

  const handleTileContextMenu = useCallback((file: ScannedFile, currentList: ScannedFile[], e: React.MouseEvent) => {
    e.preventDefault()
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      file,
      currentList
    })
  }, [])

  // Global Delete hotkey listener
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' && selected.size > 0) {
        handleBatchDelete()
      }
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [selected, handleBatchDelete])

  // Custom Grouping Logic (Year, Month, Day, Location, Favorites)
  const getDayKey = (file: ScannedFile) => {
    if (!file.date) return 'Unknown Date'
    const d = new Date(file.date)
    return d.toLocaleDateString('default', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  }

  const getMonthKey = (file: ScannedFile) => {
    return `${file.month || 'Unknown'} ${file.year || ''}`.trim()
  }

  const getYearKey = (file: ScannedFile) => {
    return file.year || 'Unknown Year'
  }

  const sortedGroupedData = useMemo(() => {
    const filtered = getFiltered(allFiles)
    const groups: Record<string, ScannedFile[]> = {}

    filtered.forEach(file => {
      let key = 'Other'
      if (groupBy === 'day') {
        key = getDayKey(file)
      } else if (groupBy === 'month') {
        key = getMonthKey(file)
      } else if (groupBy === 'year') {
        key = getYearKey(file)
      } else if (groupBy === 'location') {
        key = file.lat && file.lng 
          ? `📍 Coords (${Math.round(file.lat * 2) / 2}, ${Math.round(file.lng * 2) / 2})` 
          : 'No Location Info'
      } else if (groupBy === 'favorites') {
        key = favourites.has(file.path) ? '❤️ Favourites' : 'Other Files'
      }
      
      if (!groups[key]) groups[key] = []
      groups[key].push(file)
    })

    const keys = Object.keys(groups).sort((a, b) => {
      const fileA = groups[a][0]
      const fileB = groups[b][0]
      if (!fileA || !fileB) return 0
      return new Date(fileB.date).getTime() - new Date(fileA.date).getTime()
    })

    return { keys, data: groups }
  }, [allFiles, groupBy, favourites, getFiltered])

  return (
    <div style={{ display: 'flex', width: '100vw', height: '100vh', background: '#09090b', color: '#e4e4e7', fontFamily: 'system-ui, sans-serif', fontSize: '13px', overflow: 'hidden', position: 'fixed', inset: 0 }}>
      <style>{`
        /* Embedded core visual parameters */
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: #09090b; }
        ::-webkit-scrollbar-thumb { background: #1c1c22; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #2e2e38; }
      `}</style>

      {/* Sidebar (CRED Glassmorphism Card Style) */}
      <div style={{ width: '230px', minWidth: '230px', background: '#0e0e11', borderRight: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', height: '100vh', overflowY: 'auto' }}>
        <div style={{ padding: '20px 22px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: '#ffffff', letterSpacing: '-0.3px' }}>DiskFrame</div>
          <div style={{ fontSize: '10px', color: '#606070', marginTop: '3px' }}>Universal media indexing</div>
        </div>

        {/* Drives section */}
        {drives.map(drive => {
          const pct = drive.total > 0 ? Math.round((drive.used / drive.total) * 100) : 0
          const sel = selectedDrive === drive.name
          return (
            <div key={drive.name} onClick={() => handleDriveClick(drive.name)} 
              style={{ 
                margin: '8px 12px', 
                background: sel ? 'rgba(108,108,255,0.06)' : '#121215', 
                borderRadius: '10px', 
                padding: '12px', 
                border: `1px solid ${sel ? 'rgba(108,108,255,0.3)' : 'rgba(255,255,255,0.05)'}`, 
                cursor: 'pointer',
                transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)'
              }}
              onMouseEnter={e => e.currentTarget.style.borderColor = sel ? 'rgba(108,108,255,0.5)' : 'rgba(255,255,255,0.12)'}
              onMouseLeave={e => e.currentTarget.style.borderColor = sel ? 'rgba(108,108,255,0.3)' : 'rgba(255,255,255,0.05)'}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', fontWeight: 600, color: '#f4f4f5' }}>
                <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10b981' }} />
                {drive.name}
              </div>
              <div style={{ fontSize: '10px', color: '#71717a', marginTop: '4px' }}>{drive.total} GB · {drive.free} GB free</div>
              <div style={{ height: '3px', background: '#27272a', borderRadius: '3px', marginTop: '8px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: '#6c6cff', borderRadius: '3px' }} />
              </div>
              {sel && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '6px' }}>
                  <div style={{ fontSize: '10px', color: '#8b5cf6', fontWeight: 500 }}>{scanning ? `Indexing... ${scanCount}` : `${scanCount} files`}</div>
                  {!scanning && scanCount > 0 && (
                    <div onClick={e => { e.stopPropagation(); handleRescan(drive.name) }} style={{ fontSize: '10px', color: '#10b981', cursor: 'pointer', padding: '1px 6px', borderRadius: '4px', background: 'rgba(16,185,129,0.1)' }}>↺ Rescan</div>
                  )}
                </div>
              )}
            </div>
          )
        })}

        <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)', margin: '14px 16px' }} />

        {/* Collections */}
        <div style={{ padding: '4px 0' }}>
          <div style={{ fontSize: '9px', color: '#52525b', textTransform: 'uppercase', letterSpacing: '1px', padding: '0 22px', marginBottom: '8px', fontWeight: 700 }}>Collections</div>
          {[
            { id: 'all', label: 'All files', icon: '🗂️' },
            { id: 'photos', label: 'Photos', icon: '🖼️' },
            { id: 'videos', label: 'Videos', icon: '🎬' },
            { id: 'docs', label: 'Documents', icon: '📄' },
            { id: 'screenshots', label: 'Screenshots', icon: '📸' },
            { id: 'places', label: 'Places', icon: '📍' },
            { id: 'favourites', label: 'Favourites', icon: '⭐' },
            { id: 'archive', label: 'Archive', icon: '🗄️' },
            { id: 'trash', label: 'Trash', icon: '🗑️' }
          ].map(item => (
            <div key={item.id} onClick={() => setActiveNav(item.id)} className={`snav ${activeNav === item.id ? 'active' : ''}`}>
              <span style={{ fontSize: '16px', marginRight: '12px' }}>{item.icon}</span>
              <span style={{ flex: 1, fontSize: '12px' }}>{item.label}</span>
              {item.id === 'favourites' && allFavFiles.length > 0 && (
                <span style={{ fontSize: '10px', color: '#a0a0ff', background: 'rgba(108,108,255,0.15)', borderRadius: '4px', padding: '1px 5px', fontWeight: 600 }}>{allFavFiles.length}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Main Container */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', minWidth: 0, background: '#09090b' }}>
        
        {/* Top bar header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 22px', borderBottom: '1px solid rgba(255,255,255,0.06)', background: '#0e0e11', flexShrink: 0 }}>
          
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ fontSize: '13px', color: '#a1a1aa' }}>
              {selectedDrive ? <><span style={{ color: '#ffffff', fontWeight: 600 }}>{selectedDrive}</span> · <span style={{ color: '#71717a' }}>{activeNav}</span></> : 'Select a drive'}
            </div>
            
            {/* Search Input */}
            {selectedDrive && (
              <input
                type="text"
                placeholder="Search file, camera:, date:, ext:, loc: ..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="cred-input"
                style={{ width: '260px', padding: '4px 10px', fontSize: '11px', height: '24px' }}
              />
            )}
          </div>

          {selected.size > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#e4e4e7', background: 'rgba(108,108,255,0.08)', border: '1px solid rgba(108,108,255,0.3)', borderRadius: '6px', padding: '3px 10px' }}>
              <span>{selected.size} selected</span>
              <button onClick={handleBatchFavorite} style={{ background: 'transparent', border: 'none', color: '#a0a0ff', cursor: 'pointer', fontWeight: 600 }}>❤️ Fav</button>
              <button onClick={handleBatchDelete} style={{ background: 'transparent', border: 'none', color: '#ff6c6c', cursor: 'pointer', fontWeight: 600 }}>🗑️ Delete</button>
              <span onClick={() => setSelected(new Set())} style={{ cursor: 'pointer', color: '#71717a', marginLeft: '2px' }}>✕</span>
            </div>
          )}

          {/* Group By selector */}
          {selectedDrive && (activeView === 'Grid' || activeView === 'Timeline') && (
            <select
              value={groupBy}
              onChange={e => setGroupBy(e.target.value as any)}
              className="cred-input"
              style={{ padding: '2px 8px', fontSize: '11px', background: '#16161a', border: '1px solid rgba(255,255,255,0.08)', height: '24px', cursor: 'pointer' }}
            >
              <option value="day">Group by Day</option>
              <option value="month">Group by Month</option>
              <option value="year">Group by Year</option>
              <option value="location">Group by Location</option>
              <option value="favorites">Group by Favorites</option>
            </select>
          )}

          {activeView === 'Grid' && <div style={{ fontSize: '10px', color: '#52525b' }}>Ctrl+Scroll to resize</div>}

          {/* Views selector tab */}
          <div style={{ display: 'flex', gap: '2px', background: '#16161a', borderRadius: '8px', padding: '2px', border: '1px solid rgba(255,255,255,0.06)' }}>
            {['Grid', 'Timeline', 'Years', 'Map'].map(v => (
              <div key={v} onClick={() => setActiveView(v)} style={{ padding: '3px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '11px', fontWeight: 500, background: activeView === v ? '#27272a' : 'transparent', color: activeView === v ? '#ffffff' : '#71717a', transition: 'all 0.15s ease' }}>{v}</div>
            ))}
          </div>
        </div>

        {/* Scroll Container */}
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '20px' }}
          onWheel={handleWheel}
          onScroll={e => {
            scrollTopRef.current = (e.currentTarget as HTMLDivElement).scrollTop
            if (rafRef.current) return
            rafRef.current = requestAnimationFrame(() => { rafRef.current = null; setScrollVersion(n => n + 1) })
          }}
        >
          {/* Coming soon components */}
          {!scanning && (activeNav === 'archive' || activeNav === 'trash') && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '12px' }}>
              <div style={{ fontSize: '48px' }}>{activeNav === 'archive' ? '🗄️' : '🗑️'}</div>
              <div style={{ fontSize: '15px', fontWeight: 600, color: '#f4f4f5' }}>{activeNav === 'archive' ? 'Archive' : 'Trash'}</div>
              <div style={{ fontSize: '11px', color: '#71717a', padding: '5px 12px', borderRadius: '14px', background: '#18181b', border: '1px solid rgba(255,255,255,0.04)' }}>Coming soon</div>
            </div>
          )}

          {/* Prompt scan drive */}
          {!selectedDrive && activeNav !== 'archive' && activeNav !== 'trash' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '10px' }}>
              <div style={{ fontSize: '48px' }}>💾</div>
              <div style={{ fontSize: '14px', color: '#a1a1aa' }}>Click a drive to scan and explore</div>
              <div style={{ fontSize: '11px', color: '#52525b' }}>Smart EXIF-based local photo organizer</div>
            </div>
          )}

          {/* Indexing scanner progress */}
          {scanning && activeNav !== 'archive' && activeNav !== 'trash' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '12px' }}>
              <div style={{ fontSize: '13px', color: '#6c6cff' }}>Indexing media on {selectedDrive}...</div>
              <div style={{ fontSize: '11px', color: '#71717a' }}>{scanCount} files mapped</div>
              <div style={{ width: '200px', height: '3px', background: '#1c1c22', borderRadius: '2px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: '40%', background: 'linear-gradient(90deg, transparent, #6c6cff, transparent)', borderRadius: '2px', animation: 'shimmer 1.4s ease-in-out infinite' }} />
              </div>
            </div>
          )}

          {/* Favourites Grid */}
          {!scanning && activeNav === 'favourites' && (
            <div>
              <div style={{ fontSize: '24px', fontWeight: 700, color: '#ffffff', letterSpacing: '-0.5px', marginBottom: '8px' }}>
                Favourites <span style={{ color: '#6c6cff', fontSize: '16px', fontWeight: 500 }}>{allFavFiles.length} items</span>
              </div>
              {allFavFiles.length === 0 ? (
                <div style={{ color: '#52525b', fontSize: '13px', marginTop: '16px' }}>No favourites yet. Add items to your favorites.</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: '5px', marginTop: '16px' }}>
                  {allFavFiles.map(file => (
                    <FileTile key={file.path} file={file} onOpen={f => handleTileOpen(f, allFavFiles)} onFav={handleFav} isFav={true} isSelected={selected.has(file.path)} onSelect={handleSelect} onContextMenu={(f, e) => handleTileContextMenu(f, allFavFiles, e)} tileSize={100} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Places View map */}
          {!scanning && activeNav === 'places' && (
            <div style={{ height: 'calc(100vh - 120px)' }}>
              <MapView files={allFiles.filter(f => f.lat !== null && f.lng !== null)} onOpen={handleTileOpen} />
            </div>
          )}

          {/* Map View tab */}
          {!scanning && activeView === 'Map' && activeNav !== 'places' && activeNav !== 'archive' && activeNav !== 'trash' && (
            <div style={{ height: 'calc(100vh - 120px)' }}>
              <MapView files={allFiles} onOpen={handleTileOpen} />
            </div>
          )}

          {/* Years view */}
          {!scanning && activeView === 'Years' && activeNav !== 'favourites' && activeNav !== 'places' && activeNav !== 'archive' && activeNav !== 'trash' && (
            <div style={{ animation: transitioning ? 'slideOutLeft 0.28s forwards' : 'slideInRight 0.28s forwards' }}>
              <div style={{ fontSize: '24px', fontWeight: 700, color: '#ffffff', letterSpacing: '-0.5px', marginBottom: '14px' }}>
                All Years {yearFilter && <span onClick={() => setYearFilter(null)} style={{ fontSize: '13px', color: '#6c6cff', cursor: 'pointer', fontWeight: 400, marginLeft: '10px' }}>× {yearFilter}</span>}
              </div>
              <YearsView groupedFiles={groupedFiles} onYearClick={year => {
                setYearFilter(year); setActiveView('Timeline')
                setTimeout(() => {
                  const key = Object.keys(sortedGroupedData.data).find(m => m.includes(year))
                  if (key && monthRefs.current[key]) monthRefs.current[key]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }, 100)
              }} />
            </div>
          )}

          {/* Dynamic Grid + Timeline view */}
          {!scanning && activeNav !== 'favourites' && activeNav !== 'places' && activeNav !== 'archive' && activeNav !== 'trash' && (activeView === 'Grid' || activeView === 'Timeline') && (
            <div style={{
              animation: transitioning && activeView === 'Grid' ? 'slideOutLeft 0.28s forwards'
                : transitioning && activeView === 'Timeline' ? 'slideOutRight 0.28s forwards'
                  : activeView === 'Timeline' ? 'slideInRight 0.28s forwards' : 'slideInLeft 0.28s forwards'
            }}>
              {/* Timeline layout */}
              {activeView === 'Timeline' && (
                <div style={{ paddingLeft: '24px', borderLeft: '1.5px solid rgba(255,255,255,0.06)' }}>
                  {sortedGroupedData.keys.map(monthKey => {
                    const files = sortedGroupedData.data[monthKey]
                    return (
                      <div key={monthKey} ref={el => { monthRefs.current[monthKey] = el }} style={{ marginBottom: '28px', position: 'relative' }}>
                        <div style={{ position: 'absolute', left: '-29px', top: '8px', width: '8px', height: '8px', borderRadius: '50%', background: '#6c6cff', border: '2px solid #09090b' }} />
                        <div style={{ fontSize: '18px', fontWeight: 700, color: '#ffffff', letterSpacing: '-0.3px', lineHeight: 1 }}>
                          {monthKey}
                        </div>
                        <div style={{ fontSize: '11px', color: '#71717a', marginBottom: '10px', marginTop: '4px' }}>{files.length} files</div>
                        <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                          {files.slice(0, 12).map(file => (
                            <div key={file.path} onClick={() => handleTileOpen(file, files)} onContextMenu={(e) => handleTileContextMenu(file, files, e)} style={{ width: '80px', height: '80px', borderRadius: '6px', overflow: 'hidden', cursor: 'pointer', background: '#121215', position: 'relative' }}>
                              {(photoExts.includes(file.ext.toLowerCase()) || (videoExts.includes(file.ext.toLowerCase()) && file.thumb)) ? (
                                <>
                                  <img src={thumbUrl(file)} loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                  {videoExts.includes(file.ext.toLowerCase()) && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.3)' }}><div style={{ fontSize: '18px' }}>▶</div></div>}
                                </>
                              ) : (
                                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px' }}>{videoExts.includes(file.ext.toLowerCase()) ? '🎬' : '📄'}</div>
                              )}
                            </div>
                          ))}
                          {files.length > 12 && <div style={{ width: '80px', height: '80px', borderRadius: '6px', background: '#18181c', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', color: '#6c6cff', cursor: 'pointer', fontWeight: 600 }}>+{files.length - 12} more</div>}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Grid layout (with Viewport caching) */}
              {activeView === 'Grid' && (() => {
                const tilesPerRow = Math.max(1, Math.floor((window.innerWidth - 260) / (tileSize + 5)))
                const scrollTop = scrollTopRef.current
                const winH = window.innerHeight
                let offsetY = 0
                void scrollVersion
                return sortedGroupedData.keys.map(monthKey => {
                  const files = sortedGroupedData.data[monthKey]
                  const visible = getVisible(monthKey)
                  const rowCount = Math.ceil(Math.min(visible, files.length) / tilesPerRow)
                  const estH = rowCount * (tileSize + 5) + 80
                  const myOffset = offsetY
                  offsetY += estH + 28
                  const inView = myOffset < scrollTop + winH + 1000 && myOffset + estH > scrollTop - 1000
                  const ref = (el: HTMLDivElement | null): void => { monthRefs.current[monthKey] = el }

                  if (!inView) return <div key={monthKey + '_ph'} ref={ref} style={{ height: estH + 28 }} />

                  return (
                    <div key={monthKey + '_grid_' + files.filter(f => f.thumb).length} ref={ref} style={{ marginBottom: '28px' }}>
                      <div style={{ fontSize: '20px', fontWeight: 700, color: '#ffffff', letterSpacing: '-0.3px', lineHeight: 1 }}>
                        {monthKey}
                      </div>
                      <div style={{ fontSize: '11px', color: '#71717a', marginBottom: '12px', marginTop: '4px' }}>{files.length} files</div>
                      <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${tileSize}px, 1fr))`, gap: '5px', transition: 'grid-template-columns 0.12s cubic-bezier(0.25, 0.46, 0.45, 0.94)' }}>
                        {files.slice(0, visible).map(file => (
                          <FileTile key={file.path} file={file} onOpen={f => handleTileOpen(f, files)} onFav={handleFav} isFav={favourites.has(file.path)} isSelected={selected.has(file.path)} onSelect={handleSelect} onContextMenu={(f, e) => handleTileContextMenu(f, files, e)} tileSize={tileSize} />
                        ))}
                      </div>
                      {files.length > visible && (
                        <div onClick={() => setVisibleCount(prev => ({ ...prev, [monthKey]: visible + 40 }))} style={{ marginTop: '10px', padding: '8px', borderRadius: '8px', background: '#141417', border: '1px solid rgba(255,255,255,0.06)', cursor: 'pointer', fontSize: '12px', color: '#a0a0ff', textAlign: 'center', fontWeight: 500 }}
                          onMouseEnter={e => e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)'}
                          onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)'}
                        >
                          Show more ({files.length - visible} remaining)
                        </div>
                      )}
                    </div>
                  )
                })
              })()}
            </div>
          )}
        </div>

        {/* Status bar */}
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '8px 22px', display: 'flex', alignItems: 'center', gap: '16px', background: '#0c0c0e', flexShrink: 0 }}>
          <div style={{ fontSize: '11px', color: '#52525b' }}><span style={{ color: '#a1a1aa', fontWeight: 500 }}>{drives.length}</span> drives</div>
          <div style={{ fontSize: '11px', color: '#52525b' }}><span style={{ color: '#a1a1aa', fontWeight: 500 }}>{totalFiles}</span> files</div>
          <div style={{ fontSize: '11px', color: '#52525b' }}><span style={{ color: '#a1a1aa', fontWeight: 500 }}>{sortedGroupedData.keys.length}</span> groupings</div>
          <div style={{ fontSize: '11px', color: '#52525b' }}><span style={{ color: '#ff6b8b', fontWeight: 500 }}>❤️ {allFavFiles.length}</span> favourites</div>
          {selected.size > 0 && <div style={{ fontSize: '11px', color: '#6c6cff', fontWeight: 500 }}>✓ {selected.size} selected</div>}
          {activeView === 'Grid' && <div style={{ fontSize: '11px', color: '#52525b' }}>tile: <span style={{ color: '#a1a1aa', fontWeight: 500 }}>{tileSize}px</span></div>}
          <div style={{ marginLeft: 'auto', fontSize: '10px', color: '#10b981', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '4px', padding: '1px 6px' }}>● index live</div>
        </div>
      </div>

      {/* Main Image Viewer */}
      {lightbox && (
        <MediaViewer
          file={lightbox.file}
          list={lightbox.list}
          isFav={favourites.has(lightbox.file.path)}
          onFav={handleFav}
          onReveal={handleReveal}
          onClose={() => setLightbox(null)}
          onNext={() => {
            const idx = lightbox.list.indexOf(lightbox.file)
            if (idx < lightbox.list.length - 1) {
              setLightbox({ file: lightbox.list[idx + 1], list: lightbox.list })
            }
          }}
          onPrev={() => {
            const idx = lightbox.list.indexOf(lightbox.file)
            if (idx > 0) {
              setLightbox({ file: lightbox.list[idx - 1], list: lightbox.list })
            }
          }}
          onDelete={handleFileDeleted}
        />
      )}

      {/* Custom Context Menu Overlay */}
      {contextMenu && (
        <div
          className="cred-glass"
          style={{
            position: 'fixed',
            top: `${contextMenu.y}px`,
            left: `${contextMenu.x}px`,
            zIndex: 9999,
            borderRadius: '12px',
            padding: '5px 0',
            minWidth: '170px',
            boxShadow: '0 12px 32px rgba(0,0,0,0.6)',
            animation: 'fadeIn 0.15s ease-out'
          }}
        >
          <div
            onClick={() => handleTileOpen(contextMenu.file, contextMenu.currentList)}
            style={{ padding: '8px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <span>🖼️</span> Open in Viewer
          </div>
          <div
            onClick={() => handleFav(contextMenu.file)}
            style={{ padding: '8px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <span>❤️</span> {favourites.has(contextMenu.file.path) ? 'Unfavourite' : 'Favourite'}
          </div>
          <div
            onClick={() => handleReveal(contextMenu.file)}
            style={{ padding: '8px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <span>📁</span> Show in Folder
          </div>
          <div
            onClick={() => navigator.clipboard.writeText(contextMenu.file.path)}
            style={{ padding: '8px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <span>📋</span> Copy Path
          </div>
          <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)', margin: '4px 0' }} />
          <div
            onClick={() => setFileToDelete(contextMenu.file)}
            style={{ padding: '8px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#ff4d4d' }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <span>🗑️</span> Move to Recycle Bin
          </div>
        </div>
      )}

      {/* Single File Recycle Bin Confirm Modal */}
      {fileToDelete && (
        <div
          onClick={() => setFileToDelete(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.7)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
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
              animation: 'slideInUp 0.25s cubic-bezier(0.16, 1, 0.3, 1)'
            }}
          >
            <div style={{ fontSize: '16px', fontWeight: 600, color: '#ffffff' }}>
              Move this file to Recycle Bin?
            </div>
            <div style={{ fontSize: '12px', color: '#8a8a9e', lineHeight: 1.5 }}>
              The file "{fileToDelete.name}" will be moved to your operating system's Recycle Bin. You can restore it from there later if needed.
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', marginTop: '8px' }}>
              <button
                onClick={() => setFileToDelete(null)}
                className="cred-button"
                style={{ flex: 1, justifyContent: 'center', padding: '10px' }}
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  try {
                    const result = await window.electron.ipcRenderer.invoke('delete-files', [fileToDelete.path]) as { success?: string[] }
                    if (result && result.success && result.success.length > 0) {
                      handleFileDeleted(fileToDelete.path)
                    }
                  } catch (err) {
                    console.error(err)
                  } finally {
                    setFileToDelete(null)
                  }
                }}
                className="cred-button"
                style={{
                  flex: 1,
                  justifyContent: 'center',
                  background: '#ff4d4d',
                  borderColor: '#ff4d4d',
                  color: '#ffffff',
                  padding: '10px'
                }}
              >
                Move to Recycle Bin
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Batch Files Recycle Bin Confirm Modal */}
      {showBatchDeleteConfirm && (
        <div
          onClick={() => setShowBatchDeleteConfirm(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.7)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
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
              animation: 'slideInUp 0.25s cubic-bezier(0.16, 1, 0.3, 1)'
            }}
          >
            <div style={{ fontSize: '16px', fontWeight: 600, color: '#ffffff' }}>
              Move this file to Recycle Bin?
            </div>
            <div style={{ fontSize: '12px', color: '#8a8a9e', lineHeight: 1.5 }}>
              Are you sure you want to move the {selected.size} selected files to your operating system's Recycle Bin?
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', marginTop: '8px' }}>
              <button
                onClick={() => setShowBatchDeleteConfirm(false)}
                className="cred-button"
                style={{ flex: 1, justifyContent: 'center', padding: '10px' }}
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  try {
                    const paths = Array.from(selected)
                    const result = await window.electron.ipcRenderer.invoke('delete-files', paths) as { success?: string[] }
                    if (result && result.success) {
                      setSelected(new Set())
                      if (selectedDrive) {
                        window.api.getFiles(selectedDrive)
                      }
                    }
                  } catch (err) {
                    console.error('Batch delete error', err)
                  } finally {
                    setShowBatchDeleteConfirm(false)
                  }
                }}
                className="cred-button"
                style={{
                  flex: 1,
                  justifyContent: 'center',
                  background: '#ff4d4d',
                  borderColor: '#ff4d4d',
                  color: '#ffffff',
                  padding: '10px'
                }}
              >
                Move to Recycle Bin
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}