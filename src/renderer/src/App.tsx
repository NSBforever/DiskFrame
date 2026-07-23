import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Virtuoso } from 'react-virtuoso'

// ─── BROWSER MOCKS FOR TESTING & WEB ENVIRONMENT ──────────────────────────────────
if (typeof window !== 'undefined' && !window.api) {
  const drivesUpdatedListeners = new Set<(d: any[]) => void>()
  const favouritesUpdatedListeners = new Set<(f: any[]) => void>()
  const scanProgressListeners = new Set<(p: any) => void>()
  const scanCompleteListeners = new Set<(c: any) => void>()
  const filesUpdatedListeners = new Set<(g: any) => void>()
  const thumbReadyListeners = new Set<(t: any) => void>()
  const favouriteToggledListeners = new Set<(t: any) => void>()
  const fsIoProgressListeners = new Set<(p: any) => void>()

  const generateMockFiles = (): Record<string, ScannedFile[]> => {
    const groups: Record<string, ScannedFile[]> = {}
    const extList = ['.jpg', '.png', '.mp4', '.pdf', '.mov']
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    const years = ['2026', '2025', '2024']

    let fileIndex = 1
    years.forEach(year => {
      months.forEach(month => {
        const key = `${month} ${year}`
        groups[key] = []
        for (let i = 0; i < 35; i++) {
          const id = fileIndex++
          const ext = extList[id % extList.length]
          const dateStr = `${year}-${String(months.indexOf(month) + 1).padStart(2, '0')}-${String((id % 28) + 1).padStart(2, '0')}T10:00:00Z`
          groups[key].push({
            path: `C:\\MockMedia\\file_${id}${ext}`,
            name: `file_${id}`,
            ext: ext,
            size: 1024 * 1024 * (id % 15 + 1),
            date: dateStr,
            year: year,
            month: month,
            lat: id % 10 === 0 ? 37.7749 + (id % 5) * 0.1 : null,
            lng: id % 10 === 0 ? -122.4194 + (id % 5) * 0.1 : null,
            drive: 'C:',
            favourited: id % 13 === 0 ? 1 : 0,
            thumb: null
          })
        }
      })
    })
    return groups
  }

  (window as any).api = {
    getDrives: () => {
      const drives = [{ name: 'C:', total: 512, free: 256, used: 256, filesystem: 'NTFS' }]
      setTimeout(() => {
        drivesUpdatedListeners.forEach(l => l(drives))
      }, 50)
    },
    getFavourites: () => {
      setTimeout(() => {
        favouritesUpdatedListeners.forEach(l => l([]))
      }, 50)
    },
    getFiles: (drive: string) => {
      const mockGroups = generateMockFiles()
      setTimeout(() => {
        filesUpdatedListeners.forEach(l => l(mockGroups))
      }, 50)
    },
    scanDrive: (drive: string) => {
      let progress = 0
      const interval = setInterval(() => {
        progress += 200
        scanProgressListeners.forEach(l => l({ count: progress }))
        if (progress >= 1200) {
          clearInterval(interval)
          scanCompleteListeners.forEach(l => l({ drive, count: 1200 }))
        }
      }, 100)
    },
    toggleFavourite: (filePath: string) => {
      setTimeout(() => {
        favouriteToggledListeners.forEach(l => l({ filePath, isFav: true }))
      }, 50)
    },
    onDrivesUpdated: (cb: any) => { drivesUpdatedListeners.add(cb); return () => drivesUpdatedListeners.delete(cb) },
    onFavouritesUpdated: (cb: any) => { favouritesUpdatedListeners.add(cb); return () => favouritesUpdatedListeners.delete(cb) },
    onScanProgress: (cb: any) => { scanProgressListeners.add(cb); return () => scanProgressListeners.delete(cb) },
    onScanComplete: (cb: any) => { scanCompleteListeners.add(cb); return () => scanCompleteListeners.delete(cb) },
    onFilesUpdated: (cb: any) => { filesUpdatedListeners.add(cb); return () => filesUpdatedListeners.delete(cb) },
    onThumbReady: (cb: any) => { thumbReadyListeners.add(cb); return () => thumbReadyListeners.delete(cb) },
    onFavouriteToggled: (cb: any) => { favouriteToggledListeners.add(cb); return () => favouriteToggledListeners.delete(cb) },
    onFsIoProgress: (cb: any) => { fsIoProgressListeners.add(cb); return () => fsIoProgressListeners.delete(cb) },
    getTileSize: async () => 120,
    setTileSize: async () => {}
  }
}

if (typeof window !== 'undefined' && !window.electron) {
  (window as any).electron = {
    ipcRenderer: {
      invoke: async (channel: string) => {
        if (channel === 'get-trashed-files') return []
        if (channel === 'get-trash-count') return 0
        return null
      },
      send: () => {},
      on: () => () => {},
    }
  }
}

import MediaViewer from './components/media-viewer/MediaViewer'
import GlobeView from './components/GlobeView'
import SearchAgent from './components/SearchAgent'
import {
  HardDrive,
  FolderArchive,
  Image as ImageIcon,
  Film,
  FileText,
  Camera,
  Map as MapIcon,
  Star,
  Heart,
  Trash2,
  AlertTriangle,
  RotateCcw,
  Sparkles,
  Check,
  Play,
  FolderOpen,
  Copy,
  X,
  Settings
} from 'lucide-react'

interface DriveInfo {
  name: string
  filesystem: string
  total: number
  used: number
  free: number
}

export interface ScannedFile {
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
  trashed_at?: string | null
}

const photoExts = ['.jpg', '.jpeg', '.png', '.webp', '.heic']
const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.wmv']
const docExts = ['.pdf', '.docx', '.doc', '.txt', '.xlsx', '.pptx', '.csv']
const FadeLoadMore: React.FC<{ monthKey: string; visible: number; onVisible: () => void }> = ({ monthKey, visible, onVisible }) => {
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        onVisible()
      }
    }, { rootMargin: '120px' })

    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [onVisible])

  return (
    <div
      ref={ref}
      onClick={onVisible}
      style={{
        position: 'relative',
        height: '60px',
        marginTop: '-30px',
        marginBottom: '20px',
        background: 'linear-gradient(to bottom, transparent, #0a0a0c 90%)',
        cursor: 'pointer',
        zIndex: 10,
        pointerEvents: 'auto'
      }}
    />
  )
}

function thumbUrl(file: ScannedFile): string {
  const src = file.thumb || file.path
  return 'media:///' + src.replace(/\\/g, '/')
}

export const FileTile = React.memo(({
  file, onOpen, onFav, isFav, isSelected, onSelect, onContextMenu, tileSize, isTrashView, onRestore, onDeletePermanently, isDeleting, onDragStart
}: {
  file: ScannedFile
  onOpen: (f: ScannedFile, e: React.MouseEvent) => void
  onFav: (f: ScannedFile) => void
  isFav: boolean
  isSelected: boolean
  onSelect: (f: ScannedFile, e: React.MouseEvent) => void
  onContextMenu: (f: ScannedFile, e: React.MouseEvent) => void
  tileSize: number
  isTrashView?: boolean
  onRestore?: (f: ScannedFile) => void
  onDeletePermanently?: (f: ScannedFile) => void
  isDeleting?: boolean
  onDragStart?: (file: ScannedFile, e: React.DragEvent) => void
}): React.JSX.Element => {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)
  const [hovered, setHovered] = useState(false)
  const isPhoto = photoExts.includes(file.ext.toLowerCase())
  const isVideo = videoExts.includes(file.ext.toLowerCase())
  const isDoc = docExts.includes(file.ext.toLowerCase())
  const hasThumb = !!file.thumb
  const imgKey = file.thumb ?? 'no-thumb'

  useEffect(() => { setLoaded(false); setError(false) }, [file.thumb])

  const iconSize = tileSize < 80 ? 20 : 28
  const subFontSize = tileSize < 80 ? '7px' : '9px'

  return (
    <div
      onClick={(e) => onOpen(file, e)}
      onContextMenu={(e) => onContextMenu(file, e)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      draggable={!isTrashView}
      onDragStart={(e) => onDragStart?.(file, e)}
      data-grid-tile={file.path}
      style={{
        borderRadius: '4px', // CRED style sharp corners
        aspectRatio: '1',
        cursor: 'pointer',
        overflow: 'hidden',
        background: '#111114',
        position: 'relative',
        border: `1px solid ${isSelected ? '#e11d2e' : hovered ? 'rgba(225,29,46,0.4)' : 'rgba(255,255,255,0.04)'}`,
        outline: isSelected ? '1px solid #e11d2e' : 'none',
        outlineOffset: '2px',
        transform: isDeleting ? 'scale(0.1)' : 'scale(1) translateY(0)',
        opacity: isDeleting ? 0 : 1,
        boxShadow: 'none',
        transition: 'transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1), border-color 0.15s, opacity 0.35s',
        zIndex: hovered ? 2 : 1
      }}
      onMouseDown={(e) => {
        if (e.button === 0) e.currentTarget.style.transform = 'scale(0.97)'
      }}
      onMouseUp={(e) => {
        if (e.button === 0) e.currentTarget.style.transform = 'scale(1)'
      }}
    >
      {isPhoto && !error ? (
        <>
          {!loaded && (
            <div style={{ position: 'absolute', inset: 0, background: '#111114', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ width: '16px', height: '16px', border: '1.5px solid #202025', borderTop: '1.5px solid #e11d2e', borderRadius: '0%', animation: 'tileSpin 0.8s linear infinite' }} />
            </div>
          )}
          <img key={imgKey} src={thumbUrl(file)} loading="lazy" decoding="async"
            onLoad={() => setLoaded(true)} onError={() => { setError(true); setLoaded(true) }}
            style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: loaded ? 1 : 0, transition: 'opacity 0.2s', willChange: 'transform' }}
          />
        </>
      ) : isVideo ? (
        hasThumb && !error ? (
          <>
            {!loaded && (
              <div style={{ position: 'absolute', inset: 0, background: '#111114', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ width: '16px', height: '16px', border: '1.5px solid #202025', borderTop: '1.5px solid #e11d2e', borderRadius: '0%', animation: 'tileSpin 0.8s linear infinite' }} />
              </div>
            )}
            <img key={imgKey} src={thumbUrl(file)} loading="lazy" decoding="async"
              onLoad={() => setLoaded(true)} onError={() => { setError(true); setLoaded(true) }}
              style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: loaded ? 1 : 0, transition: 'opacity 0.2s', willChange: 'transform' }}
            />
            {loaded && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.2)' }}>
                <div style={{ width: '26px', height: '26px', borderRadius: '4px', background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', transition: 'transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1)' }}>
                  <Play size={12} fill="#ffffff" stroke="none" />
                </div>
              </div>
            )}
          </>
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px', background: '#1b1212' }}>
            <Film size={iconSize} color="#e11d2e" />
            <div style={{ fontSize: subFontSize, color: '#8a8a8f', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{file.ext}</div>
            {tileSize >= 80 && <div style={{ fontSize: '8px', color: '#8a8a8f', maxWidth: '90%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{file.name}</div>}
          </div>
        )
      ) : isDoc ? (
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px', background: '#121a1b' }}>
          <FileText size={iconSize} color="#d0d0e0" />
          <div style={{ fontSize: subFontSize, color: '#8a8a8f', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{file.ext}</div>
          {tileSize >= 80 && <div style={{ fontSize: '8px', color: '#8a8a8f', maxWidth: '90%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{file.name}</div>}
        </div>
      ) : (
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
          <ImageIcon size={iconSize} color="#8a8a8f" />
          <div style={{ fontSize: subFontSize, color: '#8a8a8f', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{file.ext}</div>
        </div>
      )}

      {tileSize >= 70 && (
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, padding: '20px 6px 5px',
          background: 'linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.4) 50%, transparent 100%)',
          display: 'flex', alignItems: 'flex-end',
          opacity: hovered ? 1 : 0,
          transition: 'opacity 0.25s', pointerEvents: 'none'
        }}>
          <div style={{ fontSize: '9px', fontWeight: 600, color: '#f2f2f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{file.name}</div>
        </div>
      )}

      {/* Select item checkbox overlay */}
      {!isTrashView && (
        <div onClick={(e) => { e.stopPropagation(); onSelect(file, e) }}
          style={{ position: 'absolute', top: '4px', left: '4px', width: '16px', height: '16px', borderRadius: '2px', background: isSelected ? '#e11d2e' : 'rgba(0,0,0,0.6)', border: `1.5px solid ${isSelected ? '#e11d2e' : 'rgba(255,255,255,0.3)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '9px', cursor: 'pointer', color: '#f2f2f0', opacity: hovered || isSelected ? 1 : 0, transition: 'opacity 0.15s' }}
        >
          {isSelected && <Check size={10} strokeWidth={3} />}
        </div>
      )}

      {/* Favorite Heart or Restore Icon */}
      {tileSize >= 70 && (
        isTrashView ? (
          <div onClick={(e) => { e.stopPropagation(); onRestore?.(file) }}
            style={{ position: 'absolute', top: '4px', right: '4px', width: '20px', height: '20px', borderRadius: '4px', background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', opacity: hovered ? 1 : 0, transition: 'opacity 0.15s' }}
            title="Restore File"
          >
            <RotateCcw size={12} color="#f2f2f0" />
          </div>
        ) : (
          <div onClick={(e) => { e.stopPropagation(); onFav(file) }}
            style={{ position: 'absolute', top: '4px', right: '4px', width: '20px', height: '20px', borderRadius: '4px', background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', opacity: hovered || isFav ? 1 : 0, transition: 'opacity 0.15s' }}
          >
            <Heart size={12} color={isFav ? '#e11d2e' : '#f2f2f0'} fill={isFav ? '#e11d2e' : 'none'} />
          </div>
        )
      )}

      {/* Hover action bar for Trash deletion */}
      {isTrashView && hovered && tileSize >= 70 && (
        <div
          onClick={(e) => { e.stopPropagation(); onDeletePermanently?.(file) }}
          style={{
            position: 'absolute',
            bottom: '4px',
            right: '4px',
            background: '#e11d2e',
            color: '#f2f2f0',
            borderRadius: '2px',
            fontSize: '8px',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '1px',
            padding: '3px 6px',
            cursor: 'pointer'
          }}
        >
          Delete Forever
        </div>
      )}
    </div>
  )
})



function YearThumb({ src }: { src: string }): React.JSX.Element {
  const [err, setErr] = useState(false)
  if (err) return <Camera size={20} style={{ opacity: 0.15 }} />
  return <img src={src} onError={() => setErr(true)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
}

function MapView({ files, onOpen }: { files: ScannedFile[]; onOpen: (f: ScannedFile, list: ScannedFile[], e?: React.MouseEvent) => void }): React.JSX.Element {
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
        ? `<div style="width:44px;height:44px;border-radius:4px;overflow:hidden;border:2px solid #e11d2e;box-shadow:none;position:relative;"><img src="media:///${first.thumb!.replace(/\\/g, '/')}" style="width:100%;height:100%;object-fit:cover;" />${count > 1 ? `<div style="position:absolute;bottom:2px;right:2px;background:rgba(225,29,46,0.9);color:#fff;font-size:9px;font-weight:700;border-radius:2px;padding:1px 3px;">${count}</div>` : ''}</div>`
        : `<div style="width:36px;height:36px;border-radius:4px;background:#e11d2e;border:2px solid #fff;box-shadow:none;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700;"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:white;"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg></div>`
      const icon = L.divIcon({ html: iconHtml, className: '', iconSize: hasThumb ? [44, 44] : [36, 36], iconAnchor: hasThumb ? [22, 44] : [18, 36] })
      const marker = L.marker([first.lat, first.lng], { icon })
      const thumbsHtml = clusterFiles.slice(0, 4).map(f => {
        const src = f.thumb ? `media:///${f.thumb.replace(/\\/g, '/')}` : ''
        return src ? `<img src="${src}" style="width:56px;height:56px;object-fit:cover;border-radius:4px;" />` : `<div style="width:56px;height:56px;background:#222226;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:18px;">${videoExts.includes(f.ext) ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:#8a8a8f;"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>' : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:#8a8a8f;"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>'}</div>`
      }).join('')
      marker.bindPopup(`<div style="font-size:12px;min-width:140px;font-family:system-ui,sans-serif;"><div style="font-weight:600;margin-bottom:6px;color:#f2f2f0;">${count} file${count > 1 ? 's' : ''}</div><div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;">${thumbsHtml}</div><div style="font-size:10px;color:#8a8a8f;">${new Date(first.date).toLocaleDateString()}</div>${count > 4 ? `<div style="font-size:10px;color:#e11d2e;margin-top:2px;">+${count - 4} more</div>` : ''}</div>`, { maxWidth: 200 })
      
      marker.on('click', (e) => {
        if (count > 1) {
          map.setView([first.lat!, first.lng!], map.getZoom() + 2)
        } else {
          onOpen(first, clusterFiles, e.originalEvent as any)
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
      {geoFiles.length === 0 ? (
        <div style={{ flex: 1, background: '#111114', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.04)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
          <MapIcon size={48} style={{ color: '#52525b' }} />
          <div style={{ fontSize: '13px', color: '#8a8a8f', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px' }}>No Location Information</div>
          <div style={{ fontSize: '11px', color: '#52525b' }}>Photos with GPS EXIF metadata will be plotted here.</div>
        </div>
      ) : (
        <div ref={mapRef} style={{ flex: 1, borderRadius: '4px', overflow: 'hidden', minHeight: '400px', border: '1px solid rgba(255,255,255,0.05)' }} />
      )}
    </div>
  )
}



// ─── MEMOIZED SCROLL CONTENT AREA TO ISOLATE RE-RENDERS ───────────────────────
const MainContentArea: React.FC<{
  activeNav: string
  activeView: string
  scanning: boolean
  scanCount: number
  selectedDrive: string | null
  allFiles: ScannedFile[]
  favourites: Set<string>
  selected: Set<string>
  deletingPaths: Set<string>
  handleTileOpen: (file: ScannedFile, currentList: ScannedFile[], e?: React.MouseEvent) => void
  handleFav: (file: ScannedFile) => void
  handleSelect: (file: ScannedFile, e: React.MouseEvent) => void
  handleTileContextMenu: (file: ScannedFile, currentList: ScannedFile[], e: React.MouseEvent) => void
  trashedFiles: ScannedFile[]
  handleRestore: (file: ScannedFile) => void
  setShowEmptyTrashConfirm: (show: boolean) => void
  setFileToDeletePermanently: (file: ScannedFile) => void
  yearFilter: string | null
  setYearFilter: (year: string | null) => void
  tileSize: number
  setTileSize: (size: number) => void
  onTileSizeChange: (percent: number) => void
  transitioning: boolean
  setTransitioning: (transitioning: boolean) => void
  sortedGroupedData: { keys: string[]; data: Record<string, ScannedFile[]> }
  handleWheel: (e: React.WheelEvent) => void
  handleGroupCheckboxClick: (groupKey: string, e: React.MouseEvent) => void
  groupBy: string
  onDragStart: (file: ScannedFile, e: React.DragEvent) => void
  setActiveView: (view: string) => void
}> = React.memo(({
  activeNav,
  activeView,
  scanning,
  scanCount,
  selectedDrive,
  allFiles,
  favourites,
  selected,
  deletingPaths,
  handleTileOpen,
  handleFav,
  handleSelect,
  handleTileContextMenu,
  trashedFiles,
  handleRestore,
  setShowEmptyTrashConfirm,
  setFileToDeletePermanently,
  yearFilter,
  setYearFilter,
  tileSize,
  setTileSize,
  onTileSizeChange,
  transitioning,
  setTransitioning,
  sortedGroupedData,
  handleWheel,
  handleGroupCheckboxClick,
  groupBy,
  onDragStart,
  setActiveView
}) => {
  const [visibleCount, setVisibleCount] = useState<Record<string, number>>({})
  const [placesSubView, setPlacesSubView] = useState<'map' | 'globe'>('map')
  const [windowWidth, setWindowWidth] = useState(window.innerWidth)

  const virtuosoRef = useRef<any>(null)

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const getVisible = useCallback((key: string): number => visibleCount[key] ?? 40, [visibleCount])
  const handleShowMore = useCallback((key: string, visible: number) => {
    setVisibleCount(prev => ({ ...prev, [key]: visible + 40 }))
  }, [])

  const allFavFiles = useMemo(() => allFiles.filter(f => favourites.has(f.path)), [allFiles, favourites])

  const chunkArray = <T,>(array: T[], size: number): T[][] => {
    const result: T[][] = []
    for (let i = 0; i < array.length; i += size) {
      result.push(array.slice(i, i + size))
    }
    return result
  }

  // 1. Grid Items construction
  const gridItems = useMemo(() => {
    if (activeView !== 'Grid') return []
    const items: any[] = []
    const tilesPerRow = Math.max(1, Math.floor((windowWidth - 260) / (tileSize + 5)))

    sortedGroupedData.keys.forEach(monthKey => {
      const files = sortedGroupedData.data[monthKey]
      const visible = getVisible(monthKey)
      const hasMore = files.length > visible
      const actualVisible = hasMore ? Math.max(tilesPerRow, Math.floor(visible / tilesPerRow) * tilesPerRow) : visible
      const slicedFiles = files.slice(0, actualVisible)

      items.push({
        type: 'header',
        key: `header-${monthKey}-${files.length}`,
        monthKey,
        filesCount: files.length,
        allSel: files.every(f => selected.has(f.path))
      })

      const chunked = chunkArray(slicedFiles, tilesPerRow)
      chunked.forEach((rowFiles, rowIndex) => {
        items.push({
          type: 'row',
          key: `row-${monthKey}-${rowIndex}`,
          monthKey,
          rowFiles,
          rowIndex,
          files,
          isLastRowOfSection: rowIndex === chunked.length - 1 && files.length <= actualVisible
        })
      })

      if (files.length > actualVisible) {
        items.push({
          type: 'show-more',
          key: `show-more-${monthKey}`,
          monthKey,
          visible,
          remaining: files.length - actualVisible
        })
      }
    })
    return items
  }, [sortedGroupedData, getVisible, selected, tileSize, activeView, windowWidth])

  // Keep a reference to the latest gridItems for scrolling from YearsView click
  const latestGridItemsRef = useRef<any[]>([])
  useEffect(() => {
    latestGridItemsRef.current = gridItems
  }, [gridItems])

  // 2. Timeline Items construction
  const timelineItems = useMemo(() => {
    if (activeView !== 'Timeline') return []
    const items: any[] = []
    sortedGroupedData.keys.forEach(monthKey => {
      const files = sortedGroupedData.data[monthKey]
      items.push({
        type: 'timeline-header',
        key: `timeline-header-${monthKey}-${files.length}`,
        monthKey,
        filesCount: files.length,
        allSel: files.every(f => selected.has(f.path))
      })
      items.push({
        type: 'timeline-row',
        key: `timeline-row-${monthKey}`,
        monthKey,
        rowFiles: files.slice(0, 12),
        files,
        hasMore: files.length > 12,
        remaining: files.length - 12
      })
    })
    return items
  }, [sortedGroupedData, selected, activeView])

  // 3. Years Items construction
  const yearsItems = useMemo(() => {
    if (activeView !== 'Years') return []
    const items: any[] = []
    items.push({
      type: 'years-header',
      key: 'years-header'
    })
    const yearMap: Record<string, ScannedFile[]> = {}
    for (const [key, files] of Object.entries(sortedGroupedData.data)) {
      const year = key.split('-')[0]
      if (!yearMap[year]) yearMap[year] = []
      yearMap[year].push(...files)
    }
    const years = Object.keys(yearMap).sort((a, b) => Number(b) - Number(a))

    const yearsPerRow = Math.max(1, Math.floor((windowWidth - 260) / (200 + 16)))
    const chunked = chunkArray(years, yearsPerRow)
    chunked.forEach((rowYears, rowIndex) => {
      items.push({
        type: 'years-row',
        key: `years-row-${rowIndex}`,
        rowYears,
        yearMap
      })
    })
    return items
  }, [sortedGroupedData, activeView, windowWidth])

  // 4. Favourites Items construction
  const favouritesItems = useMemo(() => {
    if (activeNav !== 'favourites') return []
    const items: any[] = []
    items.push({
      type: 'favourites-header',
      key: 'favourites-header'
    })
    const tilesPerRow = Math.max(1, Math.floor((windowWidth - 260) / (100 + 5)))
    const chunked = chunkArray(allFavFiles, tilesPerRow)
    chunked.forEach((rowFiles, rowIndex) => {
      items.push({
        type: 'favourites-row',
        key: `favourites-row-${rowIndex}`,
        rowFiles
      })
    })
    return items
  }, [allFavFiles, activeNav, windowWidth])

  // 5. Trash Items construction
  const trashItems = useMemo(() => {
    if (activeNav !== 'trash') return []
    const items: any[] = []
    items.push({
      type: 'trash-header',
      key: 'trash-header'
    })
    const tilesPerRow = Math.max(1, Math.floor((windowWidth - 260) / (100 + 5)))
    const chunked = chunkArray(trashedFiles, tilesPerRow)
    chunked.forEach((rowFiles, rowIndex) => {
      items.push({
        type: 'trash-row',
        key: `trash-row-${rowIndex}`,
        rowFiles
      })
    })
    return items
  }, [trashedFiles, activeNav, windowWidth])

  // Combine items list based on current active state
  const virtualItems = useMemo(() => {
    if (activeNav === 'favourites') return favouritesItems
    if (activeNav === 'trash') return trashItems
    if (activeView === 'Grid') return gridItems
    if (activeView === 'Timeline') return timelineItems
    if (activeView === 'Years') return yearsItems
    return []
  }, [activeNav, activeView, favouritesItems, trashItems, gridItems, timelineItems, yearsItems])

  const handleYearClick = useCallback((year: string) => {
    setYearFilter(year)
    setTileSize(120)
    setActiveView('Grid')
    setTransitioning(true)
    setTimeout(() => {
      const targetMonthKey = Object.keys(sortedGroupedData.data).find(m => m.includes(year))
      if (targetMonthKey) {
        const index = latestGridItemsRef.current.findIndex(item => item.type === 'header' && item.monthKey === targetMonthKey)
        if (index !== -1) {
          virtuosoRef.current?.scrollToIndex({
            index,
            align: 'start',
            behavior: 'smooth'
          })
        }
      }
      setTransitioning(false)
    }, 150)
  }, [sortedGroupedData, setYearFilter, setTileSize, setActiveView, setTransitioning])

  const renderItem = (item: any) => {
    switch (item.type) {
      case 'header': {
        const { monthKey, filesCount, allSel } = item
        return (
          <div style={{ marginTop: '16px', marginBottom: '12px' }}>
            <div className="group-header" style={{ display: 'flex', alignItems: 'center', gap: '8px', height: '24px' }}>
              <div style={{ fontSize: '18px', fontWeight: 700, color: '#ffffff', letterSpacing: '-0.3px', lineHeight: 1 }}>
                {monthKey}
              </div>
              {groupBy === 'day' && (
                <div
                  onClick={(e) => handleGroupCheckboxClick(monthKey, e)}
                  className={`group-header-checkbox ${allSel ? 'group-header-checkbox-active' : ''}`}
                  style={{
                    width: '16px',
                    height: '16px',
                    borderRadius: '2px',
                    background: allSel ? '#e11d2e' : 'rgba(0,0,0,0.6)',
                    border: `1.5px solid ${allSel ? '#e11d2e' : 'rgba(255,255,255,0.3)'}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '9px',
                    cursor: 'pointer',
                    color: '#f2f2f0',
                    marginLeft: '4px'
                  }}
                >
                  {allSel && <Check size={10} strokeWidth={3} />}
                </div>
              )}
            </div>
            <div style={{ fontSize: '9px', color: '#8a8a8f', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{filesCount} files</div>
          </div>
        )
      }
      case 'row': {
        const { rowFiles, files, isLastRowOfSection } = item
        return (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(auto-fill, minmax(${tileSize}px, 1fr))`,
              gap: '5px',
              marginBottom: isLastRowOfSection ? '28px' : '5px'
            }}
          >
            {rowFiles.map((file: ScannedFile) => (
              <FileTile
                key={file.path}
                file={file}
                onOpen={(f, e) => handleTileOpen(f, files, e)}
                onFav={handleFav}
                isFav={favourites.has(file.path)}
                isSelected={selected.has(file.path)}
                onSelect={handleSelect}
                onContextMenu={(f, e) => handleTileContextMenu(f, files, e)}
                tileSize={tileSize}
                isDeleting={deletingPaths.has(file.path)}
                onDragStart={onDragStart}
              />
            ))}
          </div>
        )
      }
      case 'show-more': {
        const { monthKey, visible } = item
        return (
          <FadeLoadMore
            monthKey={monthKey}
            visible={visible}
            onVisible={() => handleShowMore(monthKey, visible)}
          />
        )
      }
      case 'timeline-header': {
        const { monthKey, filesCount, allSel } = item
        return (
          <div style={{ position: 'relative', marginBottom: '10px' }}>
            <div style={{ position: 'absolute', left: '-28.5px', top: '8px', width: '8px', height: '8px', borderRadius: '50%', background: '#e11d2e', border: '2px solid #0a0a0c' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', height: '24px' }}>
              <div style={{ fontSize: '18px', fontWeight: 700, color: '#ffffff', letterSpacing: '-0.3px', lineHeight: 1 }}>
                {monthKey}
              </div>
              {groupBy === 'day' && (
                <div
                  onClick={(e) => handleGroupCheckboxClick(monthKey, e)}
                  className={`group-header-checkbox ${allSel ? 'group-header-checkbox-active' : ''}`}
                  style={{
                    width: '16px',
                    height: '16px',
                    borderRadius: '2px',
                    background: allSel ? '#e11d2e' : 'rgba(0,0,0,0.6)',
                    border: `1.5px solid ${allSel ? '#e11d2e' : 'rgba(255,255,255,0.3)'}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '9px',
                    cursor: 'pointer',
                    color: '#f2f2f0',
                    marginLeft: '4px'
                  }}
                >
                  {allSel && <Check size={10} strokeWidth={3} />}
                </div>
              )}
            </div>
            <div style={{ fontSize: '11px', color: '#8a8a8f', marginTop: '4px' }}>{filesCount} files</div>
          </div>
        )
      }
      case 'timeline-row': {
        const { rowFiles, files, hasMore, remaining } = item
        return (
          <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', marginBottom: '28px' }}>
            {rowFiles.map((file: ScannedFile) => (
              <div
                key={file.path}
                onClick={(e) => handleTileOpen(file, files, e)}
                onContextMenu={(e) => handleTileContextMenu(file, files, e)}
                draggable={activeNav !== 'trash'}
                onDragStart={(e) => onDragStart(file, e)}
                data-grid-tile={file.path}
                style={{ width: '80px', height: '80px', borderRadius: '4px', overflow: 'hidden', cursor: 'pointer', background: '#111114', position: 'relative', opacity: deletingPaths.has(file.path) ? 0 : 1, transform: deletingPaths.has(file.path) ? 'scale(0.1)' : 'none', transition: 'all 0.35s' }}
              >
                {(photoExts.includes(file.ext.toLowerCase()) || (videoExts.includes(file.ext.toLowerCase()) && file.thumb)) ? (
                  <>
                    <img src={thumbUrl(file)} loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    {videoExts.includes(file.ext.toLowerCase()) && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.3)' }}><Play size={16} fill="#ffffff" stroke="none" /></div>}
                  </                  >
                ) : (
                  <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#141420' }}>
                    {videoExts.includes(file.ext.toLowerCase()) ? <Film size={24} color="#e11d2e" /> : <FileText size={24} color="#8a8a8f" />}
                  </div>
                )}
              </div>
            ))}
            {hasMore && <div style={{ width: '80px', height: '80px', borderRadius: '4px', background: '#161619', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', color: '#e11d2e', cursor: 'pointer', fontWeight: 600 }}>+{remaining} more</div>}
          </div>
        )
      }
      case 'years-header': {
        return (
          <div style={{ fontSize: '22px', fontWeight: 700, color: '#ffffff', letterSpacing: '-0.5px', marginBottom: '14px' }}>
            All Years {yearFilter && <span onClick={() => setYearFilter(null)} style={{ fontSize: '13px', color: '#e11d2e', cursor: 'pointer', fontWeight: 400, marginLeft: '10px' }}>× {yearFilter}</span>}
          </div>
        )
      }
      case 'years-row': {
        const { rowYears, yearMap } = item
        return (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '16px', marginBottom: '16px' }}>
            {rowYears.map((year: string) => {
              const files = yearMap[year]
              const previewFiles = [...files.filter(f => f.thumb), ...files.filter(f => photoExts.includes(f.ext.toLowerCase()) && !f.thumb)].slice(0, 4)
              return (
                <div key={year} onClick={() => handleYearClick(year)}
                  style={{ background: '#111114', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.04)', overflow: 'hidden', cursor: 'pointer', transition: 'transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1), border-color 0.25s' }}
                  onMouseEnter={e => { const el = e.currentTarget as HTMLDivElement; el.style.borderColor = '#e11d2e' }}
                  onMouseLeave={e => { const el = e.currentTarget as HTMLDivElement; el.style.borderColor = 'rgba(255,255,255,0.04)' }}
                  onMouseDown={e => { e.currentTarget.style.transform = 'scale(0.97)' }}
                  onMouseUp={e => { e.currentTarget.style.transform = 'scale(1)' }}
                >
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', height: '140px' }}>
                    {[0, 1, 2, 3].map(i => {
                      const f = previewFiles[i]
                      const src = f ? ('media:///' + (f.thumb || f.path).replace(/\\/g, '/')) : null
                      return (
                        <div key={i} style={{ background: '#161619', overflow: 'hidden', borderRight: i % 2 === 0 ? '1px solid #0a0a0c' : undefined, borderBottom: i < 2 ? '1px solid #0a0a0c' : undefined, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {src ? <YearThumb src={src} /> : <Camera size={20} style={{ opacity: 0.15 }} />}
                        </div>
                      )
                    })}
                  </div>
                  <div style={{ padding: '12px 14px 14px' }}>
                    <div style={{ fontSize: '18px', fontWeight: 700, color: '#f2f2f0', letterSpacing: '-0.3px' }}>{year}</div>
                    <div style={{ fontSize: '9px', color: '#8a8a8f', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{files.length} files</div>
                  </div>
                </div>
              )
            })}
          </div>
        )
      }
      case 'favourites-row': {
        const { rowFiles } = item
        return (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: '5px', marginBottom: '5px' }}>
            {rowFiles.map((file: ScannedFile) => (
              <FileTile key={file.path} file={file} onOpen={(f, e) => handleTileOpen(f, allFavFiles, e)} onFav={handleFav} isFav={true} isSelected={selected.has(file.path)} onSelect={handleSelect} onContextMenu={(f, e) => handleTileContextMenu(f, allFavFiles, e)} tileSize={100} isDeleting={deletingPaths.has(file.path)} onDragStart={onDragStart} />
            ))}
          </div>
        )
      }
      case 'favourites-header': {
        return (
          <div style={{ fontSize: '22px', fontWeight: 700, color: '#ffffff', letterSpacing: '-0.5px', marginBottom: '16px' }}>
            Favourites <span style={{ color: '#e11d2e', fontSize: '14px', fontWeight: 500 }}>{allFavFiles.length} items</span>
          </div>
        )
      }
      case 'trash-row': {
        const { rowFiles } = item
        return (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: '5px', marginBottom: '5px' }}>
            {rowFiles.map((file: ScannedFile) => (
              <FileTile 
                key={file.path} 
                file={file} 
                onOpen={(f, e) => handleTileOpen(f, trashedFiles, e)} 
                onFav={handleFav} 
                isFav={false} 
                isSelected={false} 
                onSelect={handleSelect} 
                onContextMenu={(f, e) => handleTileContextMenu(f, trashedFiles, e)} 
                tileSize={100}
                isTrashView={true}
                onRestore={handleRestore}
                onDeletePermanently={f => setFileToDeletePermanently(f)}
                isDeleting={deletingPaths.has(file.path)}
              />
            ))}
          </div>
        )
      }
      case 'trash-header': {
        return (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <div>
              <h2 style={{ fontSize: '22px', fontWeight: 700, color: '#f2f2f0', letterSpacing: '-0.5px', margin: 0 }}>
                Trash Collection
              </h2>
              <div style={{ fontSize: '9px', color: '#8a8a8f', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Items in trash are soft-deleted and permanently purged after 30 days.
              </div>
            </div>
            {trashedFiles.length > 0 && (
              <button
                onClick={() => setShowEmptyTrashConfirm(true)}
                className="cred-button"
                style={{ background: '#e11d2e', color: '#f2f2f0', border: 'none', fontWeight: 700 }}
              >
                Empty Trash ({trashedFiles.length})
              </button>
            )}
          </div>
        )
      }
      default:
        return null
    }
  }

  const animationStyle = useMemo(() => {
    if (activeNav === 'favourites' || activeNav === 'trash') return undefined
    if (activeView === 'Years') {
      return { animation: transitioning ? 'slideOutLeft 0.28s forwards' : 'slideInRight 0.28s forwards' }
    }
    if (activeView === 'Grid' || activeView === 'Timeline') {
      return {
        animation: transitioning && activeView === 'Grid' ? 'slideOutLeft 0.28s forwards'
          : transitioning && activeView === 'Timeline' ? 'slideOutRight 0.28s forwards'
            : activeView === 'Timeline' ? 'slideInRight 0.28s forwards' : 'slideInLeft 0.28s forwards'
      }
    }
    return undefined
  }, [activeView, activeNav, transitioning])

  const virtuosoComponents = useMemo(() => {
    const listStyle: React.CSSProperties = {
      padding: '20px',
      boxSizing: 'border-box'
    }
    if (activeView === 'Timeline' && activeNav !== 'favourites' && activeNav !== 'trash' && activeNav !== 'places') {
      listStyle.paddingLeft = '44px'
      listStyle.borderLeft = '1.5px solid rgba(255,255,255,0.04)'
      listStyle.marginLeft = '20px'
    }
    return {
      List: React.forwardRef<HTMLDivElement, any>(({ style, children, ...props }, ref) => (
        <div
          ref={ref}
          {...props}
          style={{
            ...style,
            ...listStyle
          }}
        >
          {children}
        </div>
      ))
    }
  }, [activeView, activeNav])

  const overscanPx = useMemo(() => {
    if (activeView === 'Grid') return Math.max(300, 5 * (tileSize + 5))
    if (activeView === 'Timeline') return 550
    if (activeView === 'Years') return 1000
    return 500
  }, [activeView, tileSize])

  const tileSizePercent = (tileSize / 120) * 100

  const isVirtualized =
    !scanning &&
    selectedDrive &&
    activeNav !== 'places' &&
    activeNav !== 'archive' &&
    activeNav !== 'settings' &&
    activeView !== 'Map' &&
    !(activeNav === 'trash' && trashedFiles.length === 0) &&
    !(activeNav === 'favourites' && allFavFiles.length === 0)

  if (isVirtualized) {
    return (
      <div
        onWheel={handleWheel}
        className="view-transition-enter"
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          minHeight: 0,
          ...animationStyle
        }}
      >
        <Virtuoso
          style={{ flex: 1 }}
          data={virtualItems}
          itemContent={(_, item) => renderItem(item)}
          overscan={overscanPx}
          components={virtuosoComponents}
          ref={virtuosoRef}
        />
      </div>
    )
  }

  return (
    <div
      style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '20px' }}
      onWheel={handleWheel}
    >
      {/* Settings Panel View */}
      {!scanning && activeNav === 'settings' && (
        <div className="view-transition-enter" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <div>
            <h2 style={{ fontSize: '22px', fontWeight: 700, color: '#f2f2f0', letterSpacing: '-0.5px', margin: 0 }}>
              Settings
            </h2>
            <div style={{ fontSize: '9px', color: '#8a8a8f', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Configure application parameters and interface layout
            </div>
          </div>

          <div style={{
            background: '#111114',
            borderRadius: '4px',
            border: '1px solid rgba(255, 255, 255, 0.04)',
            padding: '24px',
            display: 'flex',
            flexDirection: 'column',
            gap: '24px',
            maxWidth: '600px'
          }}>
            {/* Interface Section */}
            <div>
              <h3 style={{ fontSize: '13px', fontWeight: 700, color: '#ffffff', letterSpacing: '0.5px', textTransform: 'uppercase', margin: '0 0 16px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '8px' }}>
                Interface Layout
              </h3>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label htmlFor="settings-tile-size-slider" style={{ fontSize: '12px', fontWeight: 600, color: '#f2f2f0' }}>Grid Tile Size</label>
                  <span style={{ fontSize: '11px', color: '#e11d2e', fontWeight: 700 }}>
                    {Math.round(tileSizePercent)}% ({tileSize}px)
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                  <input
                    id="settings-tile-size-slider"
                    type="range"
                    min="50"
                    max="200"
                    step="5"
                    value={Math.round(tileSizePercent)}
                    onChange={(e) => onTileSizeChange(Number(e.target.value))}
                    style={{
                      flex: 1,
                      height: '4px',
                      outline: 'none',
                      cursor: 'pointer',
                      accentColor: '#e11d2e',
                      background: 'rgba(255, 255, 255, 0.1)'
                    }}
                  />
                </div>
                <div style={{ fontSize: '10px', color: '#8a8a8f', marginTop: '4px' }}>
                  Adjusts the scale of grid item cards in the main lists.
                </div>
              </div>
            </div>

            {/* Placeholder for future sections */}
            <div>
              <h3 style={{ fontSize: '13px', fontWeight: 700, color: '#8a8a8f', letterSpacing: '0.5px', textTransform: 'uppercase', margin: '0 0 8px 0', opacity: 0.5 }}>
                Advanced settings (coming soon)
              </h3>
            </div>
          </div>
        </div>
      )}

      {/* Coming soon components */}
      {!scanning && activeNav === 'archive' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '12px' }} className="view-transition-enter">
          <FolderArchive size={48} style={{ color: '#52525b' }} />
          <div style={{ fontSize: '13px', fontWeight: 700, color: '#f2f2f0', textTransform: 'uppercase', letterSpacing: '1px' }}>Archive</div>
          <div style={{ fontSize: '11px', color: '#8a8a8f', padding: '5px 12px', borderRadius: '4px', background: '#111114', border: '1px solid rgba(255,255,255,0.04)' }}>Coming soon</div>
        </div>
      )}

      {/* Trash Lifecycle Bin View - Empty state only */}
      {!scanning && activeNav === 'trash' && trashedFiles.length === 0 && (
        <div className="view-transition-enter">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <div>
              <h2 style={{ fontSize: '22px', fontWeight: 700, color: '#f2f2f0', letterSpacing: '-0.5px', margin: 0 }}>
                Trash Collection
              </h2>
              <div style={{ fontSize: '9px', color: '#8a8a8f', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Items in trash are soft-deleted and permanently purged after 30 days.
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '50vh', gap: '12px' }}>
            <Trash2 size={48} style={{ color: '#52525b' }} />
            <div style={{ fontSize: '13px', color: '#8a8a8f', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px' }}>Trash is empty.</div>
            <div style={{ fontSize: '10px', color: '#52525b' }}>Soft-deleted photos and videos will appear here.</div>
          </div>
        </div>
      )}

      {/* Prompt scan drive */}
      {!selectedDrive && activeNav !== 'archive' && activeNav !== 'trash' && activeNav !== 'settings' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '10px' }} className="view-transition-enter">
          <HardDrive size={48} style={{ color: '#52525b' }} />
          <div style={{ fontSize: '13px', color: '#8a8a8f', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px' }}>Select a drive to scan and explore</div>
          <div style={{ fontSize: '10px', color: '#52525b' }}>Smart EXIF-based local photo organizer</div>
        </div>
      )}

      {/* Indexing scanner progress */}
      {scanning && activeNav !== 'archive' && activeNav !== 'trash' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '12px' }} className="view-transition-enter">
          <div style={{ fontSize: '13px', color: '#e11d2e', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px' }}>Indexing media on {selectedDrive}...</div>
          <div style={{ fontSize: '10px', color: '#8a8a8f', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{scanCount} files mapped</div>
          <div style={{ width: '200px', height: '2px', background: '#1c1c22', borderRadius: '0px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: '40%', background: 'linear-gradient(90deg, transparent, #e11d2e, transparent)', animation: 'shimmer 1.4s ease-in-out infinite' }} />
          </div>
        </div>
      )}

      {/* Favourites Grid - Empty state only */}
      {!scanning && activeNav === 'favourites' && allFavFiles.length === 0 && (
        <div className="view-transition-enter">
          <div style={{ fontSize: '22px', fontWeight: 700, color: '#ffffff', letterSpacing: '-0.5px', marginBottom: '8px' }}>
            Favourites <span style={{ color: '#e11d2e', fontSize: '14px', fontWeight: 500 }}>0 items</span>
          </div>
          <div style={{ color: '#8a8a8f', fontSize: '13px', marginTop: '16px' }}>No favourites yet. Add items to your favorites.</div>
        </div>
      )}

      {/* Places Map View featuring Map/Globe toggle */}
      {!scanning && activeNav === 'places' && (
        <div style={{ height: 'calc(100vh - 120px)', display: 'flex', flexDirection: 'column', gap: '10px' }} className="view-transition-enter">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
            <div style={{ fontSize: '10px', color: '#8a8a8f', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 700 }}>
              📍 {allFiles.filter(f => f.lat !== null && f.lng !== null).length} Mapped Coordinates
            </div>
            <div style={{ display: 'flex', background: '#111113', borderRadius: '4px', padding: '2px', border: '1px solid rgba(255,255,255,0.04)' }}>
              <button
                onClick={() => setPlacesSubView('map')}
                style={{
                  padding: '4px 12px',
                  borderRadius: '3px',
                  border: 'none',
                  fontSize: '10px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  background: placesSubView === 'map' ? 'rgba(225,29,46,0.15)' : 'transparent',
                  color: placesSubView === 'map' ? '#e11d2e' : '#8a8a8f',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  transition: 'transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1)'
                }}
                onMouseDown={e => e.currentTarget.style.transform = 'scale(0.95)'}
                onMouseUp={e => e.currentTarget.style.transform = 'scale(1)'}
              >
                Map
              </button>
              <button
                onClick={() => setPlacesSubView('globe')}
                style={{
                  padding: '4px 12px',
                  borderRadius: '3px',
                  border: 'none',
                  fontSize: '10px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  background: placesSubView === 'globe' ? 'rgba(225,29,46,0.15)' : 'transparent',
                  color: placesSubView === 'globe' ? '#e11d2e' : '#8a8a8f',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  transition: 'transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1)'
                }}
                onMouseDown={e => e.currentTarget.style.transform = 'scale(0.95)'}
                onMouseUp={e => e.currentTarget.style.transform = 'scale(1)'}
              >
                Globe
              </button>
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            {placesSubView === 'map' ? (
              <MapView files={allFiles.filter(f => f.lat !== null && f.lng !== null)} onOpen={(f, list, e) => handleTileOpen(f, list, e)} />
            ) : (
              <GlobeView files={allFiles} onOpen={(f, list) => handleTileOpen(f, list)} />
            )}
          </div>
        </div>
      )}

      {/* Map View tab */}
      {!scanning && activeView === 'Map' && activeNav !== 'places' && activeNav !== 'archive' && activeNav !== 'trash' && (
        <div style={{ height: 'calc(100vh - 120px)' }} className="view-transition-enter">
          <MapView files={allFiles} onOpen={(f, list, e) => handleTileOpen(f, list, e)} />
        </div>
      )}
    </div>
  )
})

// ─── ROOT COMPONENT ──────────────────────────────────────────────────────────
export default function App(): React.JSX.Element {
  const [activeNav, setActiveNav] = useState('all')
  const [drives, setDrives] = useState<DriveInfo[]>([])
  const [selectedDrive, setSelectedDrive] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanCount, setScanCount] = useState(0)
  
  // Pruned state: keeps ONLY the active drive files to release previous drive allocations
  const [driveFiles, setDriveFiles] = useState<Record<string, Record<string, ScannedFile[]>>>({})
  const currentDriveRef = useRef<string | null>(null)

  const [favourites, setFavourites] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lightbox, setLightbox] = useState<{ file: ScannedFile; list: ScannedFile[]; rect?: DOMRect } | null>(null)
  const [activeView, setActiveView] = useState('Grid')

  const zoomLevelRef = useRef(1.0)
  const [tileSize, setTileSize] = useState(120)
  const [transitioning, setTransitioning] = useState(false)
  const zoomTicksRef = useRef(0)
  const lastZoomDirRef = useRef<'in' | 'out' | null>(null)

  // Redesign / Trash / AI State
  const [groupBy, setGroupBy] = useState<'day' | 'month' | 'year' | 'location' | 'favorites'>('day')
  const [searchQuery, setSearchQuery] = useState('')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: ScannedFile; currentList: ScannedFile[] } | null>(null)
  const [fileToDelete, setFileToDelete] = useState<ScannedFile | null>(null)
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState(false)

  // Trash UI States
  const [trashedFiles, setTrashedFiles] = useState<ScannedFile[]>([])
  const [trashCount, setTrashCount] = useState(0)
  const [fileToDeletePermanently, setFileToDeletePermanently] = useState<ScannedFile | null>(null)
  const [showEmptyTrashConfirm, setShowEmptyTrashConfirm] = useState(false)
  const [deletingPaths, setDeletingPaths] = useState<Set<string>>(new Set())

  // Floating AI search interface states
  const [showAiOverlay, setShowAiOverlay] = useState(false)

  // File Copy/Cut/Paste States
  const [ioProgress, setIoProgress] = useState<{ completed: number; total: number; currentFile: string } | null>(null)
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const [dragOverDrive, setDragOverDrive] = useState<string | null>(null)
  const clipboardPathsRef = useRef<string[]>([])
  const clipboardActionRef = useRef<'copy' | 'cut' | null>(null)

  // Queue to buffer thumbnail ready events, preventing multiple full re-renders
  const thumbQueueRef = useRef<{ filePath: string; thumbPath: string }[]>([])

  const refreshTrash = useCallback(async () => {
    try {
      const list = await window.electron.ipcRenderer.invoke('get-trashed-files')
      setTrashedFiles(list || [])
      const count = await window.electron.ipcRenderer.invoke('get-trash-count')
      setTrashCount(count || 0)
    } catch (e) {
      console.error('Error fetching trash list/count:', e)
    }
  }, [])

  // Auto-clear toast alert messages after 3s
  useEffect(() => {
    if (toastMsg) {
      const t = setTimeout(() => setToastMsg(null), 3000)
      return () => clearTimeout(t)
    }
    return undefined
  }, [toastMsg])

  // Hook background copy/move I/O progress listener
  useEffect(() => {
    const unsubProgress = window.api.onFsIoProgress((data) => {
      setIoProgress(data)
    })
    return () => unsubProgress()
  }, [])

  // Process buffered thumbnails queue on a interval (once every 300ms)
  useEffect(() => {
    const timer = setInterval(() => {
      if (thumbQueueRef.current.length === 0) return
      const batch = [...thumbQueueRef.current]
      thumbQueueRef.current = []

      const batchMap = new Map(batch.map(item => [item.filePath, item.thumbPath]))

      setDriveFiles(prev => {
        const updated: Record<string, Record<string, ScannedFile[]>> = {}
        for (const drive in prev) {
          updated[drive] = {}
          for (const month in prev[drive]) {
            let hasChanges = false
            const newFiles = prev[drive][month].map(f => {
              const t = batchMap.get(f.path)
              if (t) {
                hasChanges = true
                return { ...f, thumb: t }
              }
              return f
            })
            // Only update month mapping array if there are actual thumbnail changes
            updated[drive][month] = hasChanges ? newFiles : prev[drive][month]
          }
        }
        return updated
      })

      setTrashedFiles(prev => {
        let hasChanges = false
        const newFiles = prev.map(f => {
          const t = batchMap.get(f.path)
          if (t) {
            hasChanges = true
            return { ...f, thumb: t }
          }
          return f
        })
        return hasChanges ? newFiles : prev
      })
    }, 300)

    return () => clearInterval(timer)
  }, [])

  // Setup fully cleanable IPC listeners on mount and return cleanup callbacks
  useEffect(() => {
    const unsubDrives = window.api.onDrivesUpdated((d) => setDrives(d as DriveInfo[]))
    const unsubFavs = window.api.onFavouritesUpdated((files) => {
      setFavourites(new Set((files as Array<{ path: string }>).map(f => f.path)))
    })
    const unsubProgress = window.api.onScanProgress((d) => setScanCount(d.count))
    const unsubComplete = window.api.onScanComplete((d) => {
      setScanning(false); setScanCount(d.count)
      currentDriveRef.current = d.drive
      window.api.getFiles(d.drive)
    })
    const unsubFiles = window.api.onFilesUpdated((g) => {
      if (currentDriveRef.current) {
        // Enforce active drive caching only, replacing any previous caches completely
        setDriveFiles({ [currentDriveRef.current!]: g as Record<string, ScannedFile[]> })
      }
      refreshTrash()
    })
    const unsubThumb = window.api.onThumbReady((d) => {
      thumbQueueRef.current.push(d)
    })
    const unsubToggled = window.api.onFavouriteToggled((d) => {
      setFavourites(prev => {
        const next = new Set(prev)
        if (d.isFav) next.add(d.filePath); else next.delete(d.filePath)
        return next
      })
    })

    window.api.getTileSize()
      .then((size) => {
        if (size && size >= 55) {
          setTileSize(size)
          zoomLevelRef.current = Math.max(0.3, Math.min(1.0, size / 120))
        }
      })
      .catch((err) => console.error('Error loading tile size preference:', err))

    window.api.getDrives()
    window.api.getFavourites()
    refreshTrash()

    return () => {
      unsubDrives()
      unsubFavs()
      unsubProgress()
      unsubComplete()
      unsubFiles()
      unsubThumb()
      unsubToggled()
    }
  }, [refreshTrash])

  // Trigger reload when navigating
  useEffect(() => {
    if (activeNav === 'trash') {
      refreshTrash()
    }
  }, [activeNav, refreshTrash])

  // Escape key listener for the AI search overlay modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowAiOverlay(false)
      }
    }
    if (showAiOverlay) {
      window.addEventListener('keydown', handleKeyDown)
    }
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [showAiOverlay])

  const handleDriveClick = (name: string): void => {
    setSelectedDrive(name); currentDriveRef.current = name
    setScanning(true); setScanCount(0); setActiveNav('all'); setActiveView('Grid')
    zoomLevelRef.current = 1.0; setTileSize(120); setSelected(new Set())
    
    // Force prune previous drive files cache immediately on click
    setDriveFiles({ [name]: {} })
    
    window.api.scanDrive(name)
  }

  const handleSettingsTileSizeChange = (percent: number) => {
    const newSize = Math.max(55, Math.round((percent / 100) * 120))
    setTileSize(newSize)
    zoomLevelRef.current = Math.max(0.3, Math.min(1.0, newSize / 120))
    window.api.setTileSize(newSize).catch((err) => console.error(err))
  }

  const handleRescan = useCallback((name: string): void => {
    setScanning(true); setScanCount(0); currentDriveRef.current = name
    setSelected(new Set())
    window.electron.ipcRenderer.send('rescan-drive', name)
  }, [])

  const handleFav = useCallback((file: ScannedFile): void => {
    // Optimistic Update immediately in renderer
    setFavourites(prev => {
      const next = new Set(prev)
      if (next.has(file.path)) next.delete(file.path); else next.add(file.path)
      return next
    })
    window.api.toggleFavourite(file.path)
  }, [])

  const handleReveal = useCallback((file: ScannedFile): void => { window.electron.ipcRenderer.send('reveal-file', file.path) }, [])
  const openLightbox = useCallback((file: ScannedFile, list: ScannedFile[], rect?: DOMRect): void => { setLightbox({ file, list, rect }) }, [])

  const groupedFiles = selectedDrive && driveFiles[selectedDrive] ? driveFiles[selectedDrive] : {}
  const allFiles = useMemo(() => Object.values(groupedFiles).flat(), [groupedFiles])
  const allFavFiles = useMemo(() => allFiles.filter(f => favourites.has(f.path)), [allFiles, favourites])
  const totalFiles = allFiles.length

  const handleWheel = useCallback((e: React.WheelEvent): void => {
    if (!e.ctrlKey) return
    e.preventDefault()
    if (activeView !== 'Grid' && activeView !== 'Timeline' && activeView !== 'Years') return

    const dir: 'in' | 'out' = e.deltaY > 0 ? 'out' : 'in'
    if (dir !== lastZoomDirRef.current) { zoomTicksRef.current = 0; lastZoomDirRef.current = dir }
    zoomTicksRef.current++

    const newZoom = Math.max(0.3, Math.min(1.0, zoomLevelRef.current + (dir === 'in' ? 0.025 : -0.025)))
    zoomLevelRef.current = newZoom
    const newTileSize = Math.max(55, Math.round(120 * Math.min(newZoom * 1.8, 1)))
    setTileSize(newTileSize)
    window.api.setTileSize(newTileSize).catch((err) => console.error(err))

    if (transitioning) return

    if (activeView === 'Grid' && newTileSize <= 58 && zoomTicksRef.current >= 3) {
      setTransitioning(true); zoomTicksRef.current = 0
      setTimeout(() => { setActiveView('Timeline'); zoomLevelRef.current = 1.0; setTileSize(120); setTransitioning(false) }, 320)
      return
    }
    if (activeView === 'Timeline' && dir === 'in' && zoomTicksRef.current >= 3) {
      setTransitioning(true); zoomTicksRef.current = 0
      setTimeout(() => { setActiveView('Grid'); zoomLevelRef.current = 1.0; setTileSize(120); setTransitioning(false) }, 320)
      return
    }
    if (activeView === 'Timeline' && dir === 'out' && zoomTicksRef.current >= 4) {
      setTransitioning(true); zoomTicksRef.current = 0
      setTimeout(() => { setActiveView('Years'); zoomLevelRef.current = 1.0; setTileSize(120); setTransitioning(false) }, 320)
      return
    }
    if (activeView === 'Years' && dir === 'in' && zoomTicksRef.current >= 3) {
      setTransitioning(true); zoomTicksRef.current = 0
      setTimeout(() => { setActiveView('Timeline'); zoomLevelRef.current = 1.0; setTileSize(120); setTransitioning(false) }, 320)
      return
    }
  }, [activeView, transitioning])

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

  const handleSelect = useCallback((file: ScannedFile, e: React.MouseEvent): void => {
    setSelected(prev => {
      const next = new Set(prev)
      const isSelected = next.has(file.path)

      if (e.shiftKey && lastSelectedPathRef.current) {
        const allGridFiles = Object.keys(groupedFiles)
          .sort()
          .flatMap(monthKey => getFiltered(groupedFiles[monthKey] || []))
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
  }, [groupedFiles, getFiltered])

  const lastSelectedPathRef = useRef<string | null>(null)

  const handleTileOpen = useCallback((file: ScannedFile, currentList: ScannedFile[], e?: React.MouseEvent): void => {
    const rect = e?.currentTarget?.getBoundingClientRect()
    if (selected.size > 0 && selected.has(file.path)) {
      const selectionList = allFiles.filter(f => selected.has(f.path))
      openLightbox(file, selectionList, rect)
    } else {
      openLightbox(file, currentList, rect)
    }
  }, [selected, allFiles, openLightbox])

  const handleFileDeleted = useCallback((deletedPath: string): void => {
    setDeletingPaths(prev => {
      const next = new Set(prev)
      next.add(deletedPath)
      return next
    })
    
    setTimeout(() => {
      setDeletingPaths(prev => {
        const next = new Set(prev)
        next.delete(deletedPath)
        return next
      })
      setSelected(prev => {
        const next = new Set(prev)
        next.delete(deletedPath)
        return next
      })
      if (selectedDrive) {
        window.api.getFiles(selectedDrive)
      }
      refreshTrash()
    }, 350)
  }, [selectedDrive, refreshTrash])

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

  // Day bulk select & contiguous shift click
  const lastSelectedGroupRef = useRef<string | null>(null)

  const handleGroupCheckboxClick = useCallback((groupKey: string, e: React.MouseEvent) => {
    const groupFiles = sortedGroupedData.data[groupKey] || []
    const allSel = groupFiles.every(f => selected.has(f.path))
    const targetState = !allSel

    setSelected(prev => {
      const next = new Set(prev)

      if (e.shiftKey && lastSelectedGroupRef.current) {
        const startIdx = sortedGroupedData.keys.indexOf(lastSelectedGroupRef.current)
        const endIdx = sortedGroupedData.keys.indexOf(groupKey)
        if (startIdx !== -1 && endIdx !== -1) {
          const min = Math.min(startIdx, endIdx)
          const max = Math.max(startIdx, endIdx)
          const keysInRange = sortedGroupedData.keys.slice(min, max + 1)
          for (const key of keysInRange) {
            const filesInRange = sortedGroupedData.data[key] || []
            for (const f of filesInRange) {
              if (targetState) next.add(f.path); else next.delete(f.path)
            }
          }
        }
      } else {
        for (const f of groupFiles) {
          if (targetState) next.add(f.path); else next.delete(f.path)
        }
      }

      return next
    })
    lastSelectedGroupRef.current = groupKey
  }, [sortedGroupedData, selected])

  // Drag and Drop tiles
  const handleDragStart = useCallback((file: ScannedFile, e: React.DragEvent) => {
    const paths = Array.from(selected.size > 0 && selected.has(file.path) ? selected : [file.path])
    e.dataTransfer.setData('text/plain', JSON.stringify({ paths }))

    const badge = document.createElement('div')
    badge.style.position = 'absolute'
    badge.style.top = '-1000px'
    badge.style.background = '#e11d2e'
    badge.style.color = '#fff'
    badge.style.padding = '4px 8px'
    badge.style.borderRadius = '4px'
    badge.style.fontFamily = 'sans-serif'
    badge.style.fontSize = '12px'
    badge.style.fontWeight = 'bold'
    badge.style.border = '1px solid rgba(255,255,255,0.1)'
    badge.innerText = `${paths.length} file${paths.length > 1 ? 's' : ''}`

    document.body.appendChild(badge)
    e.dataTransfer.setDragImage(badge, 0, 0)
    setTimeout(() => {
      if (document.body.contains(badge)) {
        document.body.removeChild(badge)
      }
    }, 0)
  }, [selected])

  // Drag and Drop drop-zones (Sidebar Drives)
  const handleDragOverDrive = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const handleDragEnterDrive = useCallback((driveName: string, e: React.DragEvent) => {
    e.preventDefault()
    setDragOverDrive(driveName)
  }, [])

  const handleDragLeaveDrive = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOverDrive(null)
  }, [])

  const handleDropDrive = useCallback(async (driveName: string, e: React.DragEvent) => {
    e.preventDefault()
    setDragOverDrive(null)
    try {
      const dataStr = e.dataTransfer.getData('text/plain')
      if (!dataStr) return
      const payload = JSON.parse(dataStr) as { paths?: string[] }
      if (!payload.paths || payload.paths.length === 0) return

      const action = e.ctrlKey ? 'copy' : 'cut'
      const paths = payload.paths

      setIoProgress({ completed: 0, total: paths.length, currentFile: 'Initializing...' })

      let result
      if (action === 'copy') {
        result = await window.api.fsCopyPaste(paths, driveName)
      } else {
        result = await window.api.fsCutPaste(paths, driveName)
      }

      const successCount = result?.success?.length ?? 0
      const failedCount = result?.failed?.length ?? 0

      setToastMsg(`${action === 'copy' ? 'Copied' : 'Moved'} ${successCount} files to ${driveName}${failedCount > 0 ? `, ${failedCount} failed` : ''}`)
      setSelected(new Set())
    } catch (err) {
      console.error('Drop error', err)
      setToastMsg('Failed to process dropped files')
    } finally {
      setIoProgress(null)
    }
  }, [])

  // Keyboard I/O shortcuts (Ctrl+C, Ctrl+X, Ctrl+V)
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      const active = document.activeElement
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.getAttribute('contenteditable') === 'true')) {
        return
      }

      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'c' || e.key === 'C') {
          if (selected.size > 0) {
            e.preventDefault()
            clipboardPathsRef.current = Array.from(selected)
            clipboardActionRef.current = 'copy'
            setToastMsg(`${selected.size} file${selected.size > 1 ? 's' : ''} copied to clipboard`)
          }
        } else if (e.key === 'x' || e.key === 'X') {
          if (selected.size > 0) {
            e.preventDefault()
            clipboardPathsRef.current = Array.from(selected)
            clipboardActionRef.current = 'cut'
            setToastMsg(`${selected.size} file${selected.size > 1 ? 's' : ''} cut to clipboard`)
          }
        } else if (e.key === 'v' || e.key === 'V') {
          if (selectedDrive && clipboardPathsRef.current.length > 0 && clipboardActionRef.current) {
            e.preventDefault()
            const action = clipboardActionRef.current
            const paths = clipboardPathsRef.current
            
            setIoProgress({ completed: 0, total: paths.length, currentFile: 'Initializing...' })
            
            try {
              let result
              if (action === 'copy') {
                result = await window.api.fsCopyPaste(paths, selectedDrive)
              } else {
                result = await window.api.fsCutPaste(paths, selectedDrive)
              }
              
              const successCount = result?.success?.length ?? 0
              const failedCount = result?.failed?.length ?? 0
              
              setToastMsg(`${action === 'copy' ? 'Copied' : 'Moved'} ${successCount} files successfully${failedCount > 0 ? `, ${failedCount} failed` : ''}`)
              
              setSelected(new Set())
              if (action === 'cut') {
                clipboardPathsRef.current = []
                clipboardActionRef.current = null
              }
            } catch (err) {
              console.error(err)
              setToastMsg('File transfer failed')
            } finally {
              setIoProgress(null)
            }
          }
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selected, selectedDrive])

  // Custom Trash Operations
  const handleRestore = useCallback(async (file: ScannedFile) => {
    setDeletingPaths(prev => {
      const next = new Set(prev)
      next.add(file.path)
      return next
    })
    setTimeout(async () => {
      try {
        await window.electron.ipcRenderer.invoke('restore-files', [file.path])
        setDeletingPaths(prev => {
          const next = new Set(prev)
          next.delete(file.path)
          return next
        })
        refreshTrash()
        if (selectedDrive) {
          window.api.getFiles(selectedDrive)
        }
      } catch (err) {
        console.error(err)
      }
    }, 350)
  }, [selectedDrive, refreshTrash])

  // Close context menu helper
  useEffect(() => {
    const closeMenu = () => setContextMenu(null)
    window.addEventListener('click', closeMenu)
    return () => window.removeEventListener('click', closeMenu)
  }, [])

  const [yearFilter, setYearFilter] = useState<string | null>(null)

  return (
    <div style={{ display: 'flex', width: '100vw', height: '100vh', background: '#0a0a0c', color: '#f2f2f0', fontFamily: 'system-ui, sans-serif', fontSize: '13px', overflow: 'hidden', position: 'fixed', inset: 0 }}>
      <style>{`
        /* Inline animations for AI Search FAB Breathing Pulse */
        @keyframes breathingPulse {
          0% { transform: scale(1); opacity: 0.95; }
          50% { transform: scale(1.03); opacity: 1; box-shadow: 0 0 20px rgba(225, 29, 46, 0.55); }
          100% { transform: scale(1); opacity: 0.95; }
        }
        
        /* Checkbox visibility selectors on group-header hover */
        .group-header .group-header-checkbox {
          opacity: 0;
          transition: opacity 0.15s ease-in-out;
        }
        .group-header:hover .group-header-checkbox {
          opacity: 1;
        }
        .group-header-checkbox-active {
          opacity: 1 !important;
        }

        /* Embedded core visual parameters */
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: #0a0a0c; }
        ::-webkit-scrollbar-thumb { background: #1c1c22; border-radius: 0px; }
        ::-webkit-scrollbar-thumb:hover { background: #e11d2e; }
      `}</style>

      {/* Sidebar */}
      <div style={{ width: '230px', minWidth: '230px', background: '#0c0c0f', borderRight: '1px solid rgba(255,255,255,0.04)', display: 'flex', flexDirection: 'column', height: '100vh', overflowY: 'auto' }}>
        <div style={{ padding: '20px 22px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: '#ffffff', letterSpacing: '1px', textTransform: 'uppercase' }}>DiskFrame</div>
          <div style={{ fontSize: '9px', color: '#8a8a8f', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Universal media indexing</div>
        </div>

        {/* Drives section */}
        {drives.map(drive => {
          const pct = drive.total > 0 ? Math.round((drive.used / drive.total) * 100) : 0
          const sel = selectedDrive === drive.name
          const isDragOver = dragOverDrive === drive.name
          return (
            <div key={drive.name}
              onClick={() => handleDriveClick(drive.name)} 
              onDragOver={handleDragOverDrive}
              onDragEnter={(e) => handleDragEnterDrive(drive.name, e)}
              onDragLeave={handleDragLeaveDrive}
              onDrop={(e) => handleDropDrive(drive.name, e)}
              style={{ 
                margin: '8px 12px', 
                background: sel ? 'rgba(225, 29, 46, 0.05)' : isDragOver ? 'rgba(225, 29, 46, 0.1)' : '#111114', 
                borderRadius: '4px', // CRED sharp corners
                padding: '12px', 
                border: `1px solid ${sel ? 'rgba(225, 29, 46, 0.35)' : isDragOver ? '#e11d2e' : 'rgba(255,255,255,0.04)'}`, 
                cursor: 'pointer',
                outline: isDragOver ? '1px solid #e11d2e' : 'none',
                transition: 'transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1), border-color 0.25s, background-color 0.25s'
              }}
              onMouseEnter={e => e.currentTarget.style.borderColor = sel ? 'rgba(225, 29, 46, 0.5)' : isDragOver ? '#e11d2e' : 'rgba(255,255,255,0.1)'}
              onMouseLeave={e => e.currentTarget.style.borderColor = sel ? 'rgba(225, 29, 46, 0.35)' : isDragOver ? '#e11d2e' : 'rgba(255,255,255,0.04)'}
              onMouseDown={e => { e.currentTarget.style.transform = 'scale(0.97)' }}
              onMouseUp={e => { e.currentTarget.style.transform = 'scale(1)' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', fontWeight: 700, color: '#f2f2f0', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                <div style={{ width: '4px', height: '4px', borderRadius: '0%', background: '#e11d2e' }} />
                {drive.name}
              </div>
              <div style={{ fontSize: '9px', color: '#8a8a8f', marginTop: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{drive.total} GB · {drive.free} GB free</div>
              <div style={{ height: '2px', background: '#1c1c22', borderRadius: '0px', marginTop: '8px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: '#e11d2e' }} />
              </div>
              {sel && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '8px' }}>
                  <div style={{ fontSize: '9px', color: '#e11d2e', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{scanning ? `Indexing... ${scanCount}` : `${scanCount} files`}</div>
                  {!scanning && scanCount > 0 && (
                    <div onClick={e => { e.stopPropagation(); handleRescan(drive.name) }} style={{ fontSize: '8px', fontWeight: 700, color: '#f2f2f0', textTransform: 'uppercase', letterSpacing: '0.5px', cursor: 'pointer', padding: '2px 6px', borderRadius: '2px', background: 'rgba(225, 29, 46, 0.25)', border: '1px solid rgba(225,29,46,0.3)' }}>↺ Rescan</div>
                  )}
                </div>
              )}
            </div>
          )
        })}

        <div style={{ height: '1px', background: 'rgba(255,255,255,0.04)', margin: '14px 16px' }} />

        {/* Collections */}
        <div style={{ padding: '4px 0' }}>
          <div style={{ fontSize: '9px', color: '#8a8a8f', textTransform: 'uppercase', letterSpacing: '1px', padding: '0 22px', marginBottom: '8px', fontWeight: 700 }}>Collections</div>
          {[
            { id: 'all', label: 'All files', icon: <FolderArchive size={14} /> },
            { id: 'photos', label: 'Photos', icon: <ImageIcon size={14} /> },
            { id: 'videos', label: 'Videos', icon: <Film size={14} /> },
            { id: 'docs', label: 'Documents', icon: <FileText size={14} /> },
            { id: 'screenshots', label: 'Screenshots', icon: <Camera size={14} /> },
            { id: 'places', label: 'Places Map', icon: <MapIcon size={14} /> },
            { id: 'favourites', label: 'Favourites', icon: <Star size={14} /> },
            { id: 'trash', label: 'Trash', icon: <Trash2 size={14} /> },
            { id: 'settings', label: 'Settings', icon: <Settings size={14} /> }
          ].map(item => (
            <div key={item.id} onClick={() => setActiveNav(item.id)} className={`snav ${activeNav === item.id ? 'active' : ''}`}>
              <span style={{ display: 'flex', alignItems: 'center', marginRight: '12px', color: activeNav === item.id ? '#e11d2e' : '#8a8a8f' }}>{item.icon}</span>
              <span style={{ flex: 1, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{item.label}</span>
              {item.id === 'favourites' && allFavFiles.length > 0 && (
                <span style={{ fontSize: '9px', color: '#f2f2f0', background: 'rgba(225, 29, 46, 0.25)', borderRadius: '2px', padding: '2px 5px', fontWeight: 700 }}>{allFavFiles.length}</span>
              )}
              {item.id === 'trash' && trashCount > 0 && (
                <span style={{ fontSize: '9px', color: '#f2f2f0', background: '#e11d2e', borderRadius: '2px', padding: '2px 5px', fontWeight: 700 }}>{trashCount}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Main Container */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', minWidth: 0, background: '#0a0a0c' }}>
        
        {/* Top bar header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 22px', borderBottom: '1px solid rgba(255,255,255,0.04)', background: '#0c0c0f', flexShrink: 0 }}>
          
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ fontSize: '10px', color: '#8a8a8f', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 700 }}>
              {selectedDrive ? <><span style={{ color: '#ffffff' }}>{selectedDrive}</span> · <span style={{ color: '#e11d2e' }}>{activeNav}</span></> : 'Select a drive'}
            </div>
            
            {/* Search Input */}
            {selectedDrive && (
              <input
                type="text"
                placeholder="Search file, camera:, date:, ext:, loc: ..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="cred-input"
                style={{ width: '260px', padding: '4px 10px', fontSize: '11px', height: '24px', border: '1px solid rgba(225,29,46,0.1)' }}
              />
            )}
          </div>

          {selected.size > 0 && activeNav !== 'trash' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', color: '#f2f2f0', background: 'rgba(225,29,46,0.08)', border: '1px solid rgba(225,29,46,0.35)', borderRadius: '2px', padding: '3px 10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              <span>{selected.size} selected</span>
              <button onClick={handleBatchFavorite} style={{ background: 'transparent', border: 'none', color: '#e11d2e', cursor: 'pointer', fontWeight: 700, textTransform: 'uppercase' }}>❤️ Fav</button>
              <button onClick={handleBatchDelete} style={{ background: 'transparent', border: 'none', color: '#e11d2e', cursor: 'pointer', fontWeight: 700, textTransform: 'uppercase' }}>🗑️ Delete</button>
              <span onClick={() => setSelected(new Set())} style={{ cursor: 'pointer', color: '#8a8a8f', marginLeft: '2px' }}>✕</span>
            </div>
          )}

          {/* Group By selector */}
          {selectedDrive && (activeView === 'Grid' || activeView === 'Timeline') && activeNav !== 'trash' && (
            <select
              value={groupBy}
              onChange={e => setGroupBy(e.target.value as any)}
              className="cred-input"
              style={{ padding: '2px 8px', fontSize: '10px', background: '#111113', border: '1px solid rgba(255,255,255,0.05)', height: '24px', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}
            >
              <option value="day">Group by Day</option>
              <option value="month">Group by Month</option>
              <option value="year">Group by Year</option>
              <option value="location">Group by Location</option>
              <option value="favorites">Group by Favorites</option>
            </select>
          )}

          {activeView === 'Grid' && activeNav !== 'trash' && activeNav !== 'globe' && <div style={{ fontSize: '9px', color: '#8a8a8f', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Ctrl+Scroll to resize</div>}

          {/* Views selector tab */}
          {activeNav !== 'trash' && (
            <div style={{ display: 'flex', gap: '2px', background: '#111113', borderRadius: '4px', padding: '2px', border: '1px solid rgba(255,255,255,0.04)' }}>
              {['Grid', 'Timeline', 'Years', 'Map'].map(v => (
                <div key={v} onClick={() => setActiveView(v)} style={{ padding: '3px 10px', borderRadius: '3px', cursor: 'pointer', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', background: activeView === v ? '#1e1e24' : 'transparent', color: activeView === v ? '#ffffff' : '#8a8a8f', transition: 'all 0.15s ease' }}>{v}</div>
              ))}
            </div>
          )}
        </div>

        {/* Isolated Scroll Content Area */}
        <MainContentArea
          activeNav={activeNav}
          activeView={activeView}
          scanning={scanning}
          scanCount={scanCount}
          selectedDrive={selectedDrive}
          allFiles={allFiles}
          favourites={favourites}
          selected={selected}
          deletingPaths={deletingPaths}
          handleTileOpen={handleTileOpen}
          handleFav={handleFav}
          handleSelect={handleSelect}
          handleTileContextMenu={handleTileContextMenu}
          trashedFiles={trashedFiles}
          handleRestore={handleRestore}
          setShowEmptyTrashConfirm={setShowEmptyTrashConfirm}
          setFileToDeletePermanently={setFileToDeletePermanently}
          yearFilter={yearFilter}
          setYearFilter={setYearFilter}
          tileSize={tileSize}
          setTileSize={setTileSize}
          onTileSizeChange={handleSettingsTileSizeChange}
          transitioning={transitioning}
          setTransitioning={setTransitioning}
          sortedGroupedData={sortedGroupedData}
          handleWheel={handleWheel}
          handleGroupCheckboxClick={handleGroupCheckboxClick}
          groupBy={groupBy}
          onDragStart={handleDragStart}
          setActiveView={setActiveView}
        />

        {/* Status bar */}
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.04)', padding: '8px 22px', display: 'flex', alignItems: 'center', gap: '16px', background: '#08080a', flexShrink: 0 }}>
          <div style={{ fontSize: '9px', color: '#8a8a8f', textTransform: 'uppercase', letterSpacing: '0.5px' }}><span style={{ color: '#f2f2f0', fontWeight: 700 }}>{drives.length}</span> drives</div>
          <div style={{ fontSize: '9px', color: '#8a8a8f', textTransform: 'uppercase', letterSpacing: '0.5px' }}><span style={{ color: '#f2f2f0', fontWeight: 700 }}>{totalFiles}</span> files</div>
          <div style={{ fontSize: '9px', color: '#8a8a8f', textTransform: 'uppercase', letterSpacing: '0.5px' }}><span style={{ color: '#f2f2f0', fontWeight: 700 }}>{sortedGroupedData.keys.length}</span> groupings</div>
          <div style={{ fontSize: '9px', color: '#8a8a8f', textTransform: 'uppercase', letterSpacing: '0.5px' }}><span style={{ color: '#e11d2e', fontWeight: 700 }}><Heart size={8} fill="#e11d2e" style={{ display: 'inline', verticalAlign: 'middle', marginRight: '3px' }} /> {allFavFiles.length}</span> favourites</div>
          {selected.size > 0 && <div style={{ fontSize: '9px', color: '#e11d2e', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}><Check size={8} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '3px' }} /> {selected.size} selected</div>}
          {activeView === 'Grid' && <div style={{ fontSize: '9px', color: '#8a8a8f', textTransform: 'uppercase', letterSpacing: '0.5px' }}>tile: <span style={{ color: '#f2f2f0', fontWeight: 700 }}>{tileSize}px</span></div>}
          <div style={{ marginLeft: 'auto', fontSize: '8px', color: '#e11d2e', background: 'rgba(225, 29, 46, 0.08)', border: '1px solid rgba(225, 29, 46, 0.2)', borderRadius: '2px', padding: '1px 6px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>● index live</div>
        </div>
      </div>

      {/* Floating AI search action button (offset bottom: 55px to float above status bar) */}
      {selectedDrive && (
        <button
          onClick={() => setShowAiOverlay(true)}
          style={{
            position: 'fixed',
            bottom: '55px',
            right: '24px',
            width: '56px',
            height: '56px',
            borderRadius: '50%',
            background: '#0a0a0c',
            border: '1px solid #e11d2e',
            boxShadow: '0 0 16px rgba(225, 29, 46, 0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            zIndex: 2000,
            outline: 'none',
            animation: 'breathingPulse 4s ease-in-out infinite',
            transition: 'transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.15s'
          }}
          onMouseEnter={e => {
            e.currentTarget.style.transform = 'scale(1.08)'
            e.currentTarget.style.boxShadow = '0 0 24px rgba(225, 29, 46, 0.6)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.transform = 'scale(1)'
            e.currentTarget.style.boxShadow = '0 0 16px rgba(225, 29, 46, 0.4)'
          }}
          onMouseDown={e => {
            e.currentTarget.style.transform = 'scale(0.95)'
          }}
          onMouseUp={e => {
            e.currentTarget.style.transform = 'scale(1.08)'
          }}
          title="Ask AI Search Agent"
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="12" r="10" stroke="#e11d2e" strokeWidth="1.5" strokeDasharray="3 3" />
            <circle cx="12" cy="12" r="5" stroke="#f2f2f0" strokeWidth="1.5" />
            <path d="M12 2C12 7M12 17C12 22M2 12C7 12M17 12C22 12" stroke="#e11d2e" strokeWidth="1" strokeLinecap="round" />
          </svg>
        </button>
      )}

      {/* AI Search overlay modal */}
      {showAiOverlay && (
        <div
          onClick={() => setShowAiOverlay(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
            backdropFilter: 'blur(10px)',
            zIndex: 2500,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            animation: 'fadeIn 0.25s cubic-bezier(0.22, 1, 0.36, 1)'
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            className="cred-glass"
            style={{
              width: '95%',
              maxWidth: '680px',
              height: '80vh',
              borderRadius: '4px', // CRED sharp corners
              border: '1px solid rgba(225, 29, 46, 0.25)',
              boxShadow: 'none',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              animation: 'slideInUp 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)'
            }}
          >
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.04)', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', fontSize: '10px', fontWeight: 700, color: '#e11d2e', textTransform: 'uppercase', letterSpacing: '1.5px' }}>
                <Sparkles size={12} style={{ marginRight: '6px' }} /> AI Search Agent
              </div>
              <button
                onClick={() => setShowAiOverlay(false)}
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
                onMouseEnter={e => e.currentTarget.style.color = '#e11d2e'}
                onMouseLeave={e => e.currentTarget.style.color = '#8a8a8f'}
                onMouseDown={e => e.currentTarget.style.transform = 'scale(0.85)'}
                onMouseUp={e => e.currentTarget.style.transform = 'scale(1)'}
              >
                <X size={16} />
              </button>
            </div>
            
            {/* Search Agent content */}
            <div style={{ flex: 1, minHeight: 0, padding: '20px', overflowY: 'auto' }}>
              <SearchAgent
                files={allFiles}
                favourites={favourites}
                onOpen={(f, list) => {
                  setShowAiOverlay(false)
                  handleTileOpen(f, list)
                }}
                onFav={handleFav}
                selectedPaths={selected}
                onSelect={handleSelect}
                onContextMenu={handleTileContextMenu}
              />
            </div>
          </div>
        </div>
      )}

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
          rect={lightbox.rect}
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
            borderRadius: '4px', // CRED sharp corners
            padding: '5px 0',
            minWidth: '170px',
            boxShadow: 'none',
            animation: 'fadeIn 0.15s ease-out'
          }}
        >
          {activeNav !== 'trash' ? (
            <>
              <div
                onClick={(e) => handleTileOpen(contextMenu.file, contextMenu.currentList, e)}
                style={{ padding: '8px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <ImageIcon size={12} color="#8a8a8f" /> Open in Viewer
              </div>
              <div
                onClick={() => handleFav(contextMenu.file)}
                style={{ padding: '8px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <Heart size={12} color="#e11d2e" fill={favourites.has(contextMenu.file.path) ? '#e11d2e' : 'none'} /> {favourites.has(contextMenu.file.path) ? 'Unfavourite' : 'Favourite'}
              </div>
              <div
                onClick={() => handleReveal(contextMenu.file)}
                style={{ padding: '8px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <FolderOpen size={12} color="#8a8a8f" /> Show in Folder
              </div>
              <div
                onClick={() => navigator.clipboard.writeText(contextMenu.file.path)}
                style={{ padding: '8px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <Copy size={12} color="#8a8a8f" /> Copy Path
              </div>
              <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)', margin: '4px 0' }} />
              <div
                onClick={() => setFileToDelete(contextMenu.file)}
                style={{ padding: '8px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700, color: '#e11d2e' }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <Trash2 size={12} color="#e11d2e" /> Move to Trash
              </div>
            </>
          ) : (
            <>
              <div
                onClick={() => handleRestore(contextMenu.file)}
                style={{ padding: '8px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <RotateCcw size={12} color="#8a8a8f" /> Restore File
              </div>
              <div
                onClick={() => setFileToDeletePermanently(contextMenu.file)}
                style={{ padding: '8px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700, color: '#e11d2e' }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <Trash2 size={12} color="#e11d2e" /> Delete Forever
              </div>
            </>
          )}
        </div>
      )}

      {/* Floating toast notification */}
      {toastMsg && (
        <div className="cred-glass" style={{ position: 'fixed', bottom: '80px', right: '24px', padding: '12px 20px', borderRadius: '4px', zIndex: 10000, display: 'flex', alignItems: 'center', gap: '8px', color: '#f2f2f0', border: '1px solid #e11d2e', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1.5px', fontWeight: 700 }}>
          <Sparkles size={12} color="#e11d2e" /> {toastMsg}
        </div>
      )}

      {/* Floating copy/move I/O progress window overlay */}
      {ioProgress && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px' }}>
          <div className="cred-glass" style={{ width: '90%', maxWidth: '400px', padding: '24px 32px', borderRadius: '4px', display: 'flex', flexDirection: 'column', gap: '16px', boxShadow: 'none' }}>
            <div style={{ fontSize: '13px', fontWeight: 700, color: '#e11d2e', textTransform: 'uppercase', letterSpacing: '1.5px' }}>
              {ioProgress.completed === ioProgress.total ? 'Processing Complete' : 'Transferring Files...'}
            </div>
            <div style={{ fontSize: '10px', color: '#8a8a8f', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textTransform: 'uppercase' }}>
              {ioProgress.currentFile}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', fontWeight: 700 }}>
              <span style={{ color: '#8a8a8f', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Progress:</span>
              <span style={{ color: '#f2f2f0' }}>{ioProgress.completed} / {ioProgress.total}</span>
            </div>
            <div style={{ width: '100%', height: '4px', background: '#111114', overflow: 'hidden' }}>
              <div style={{ width: `${(ioProgress.completed / ioProgress.total) * 100}%`, height: '100%', background: '#e11d2e', transition: 'width 0.15s ease' }} />
            </div>
          </div>
        </div>
      )}

      {/* Single File Soft Trash Confirm Modal */}
      {fileToDelete && (
        <div
          onClick={() => setFileToDelete(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
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
              borderRadius: '4px', // CRED sharp corners
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
            <div style={{ fontSize: '11px', color: '#8a8a8f', lineHeight: 1.5 }}>
              The file "{fileToDelete.name}" will be moved to DiskFrame Trash. It will be permanently deleted after 30 days.
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

      {/* Batch Files Soft Trash Confirm Modal */}
      {showBatchDeleteConfirm && (
        <div
          onClick={() => setShowBatchDeleteConfirm(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
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
              borderRadius: '4px', // CRED sharp corners
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
              Move selected files to Trash?
            </div>
            <div style={{ fontSize: '11px', color: '#8a8a8f', lineHeight: 1.5 }}>
              Are you sure you want to move the {selected.size} selected files to Trash? They will be permanently deleted after 30 days.
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
                    
                    // Trigger batch animation
                    setDeletingPaths(prev => {
                      const next = new Set(prev)
                      paths.forEach(p => next.add(p))
                      return next
                    })
                    
                    const result = await window.electron.ipcRenderer.invoke('delete-files', paths) as { success?: string[] }
                    
                    setTimeout(() => {
                      setDeletingPaths(prev => {
                        const next = new Set(prev)
                        paths.forEach(p => next.delete(p))
                        return next
                      })
                      if (result && result.success) {
                        setSelected(new Set())
                        if (selectedDrive) {
                          window.api.getFiles(selectedDrive)
                        }
                        refreshTrash()
                      }
                    }, 350)
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

      {/* Single File Delete Forever Confirm Modal */}
      {fileToDeletePermanently && (
        <div
          onClick={() => setFileToDeletePermanently(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.85)',
            backdropFilter: 'blur(12px)',
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
              padding: '28px 36px',
              borderRadius: '4px', // CRED sharp corners
              maxWidth: '420px',
              width: '90%',
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              gap: '20px',
              border: '1.5px solid #e11d2e',
              boxShadow: 'none',
              animation: 'slideInUp 0.25s cubic-bezier(0.22, 1, 0.36, 1)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', fontSize: '16px', fontWeight: 700, color: '#e11d2e', textTransform: 'uppercase', letterSpacing: '1px' }}>
              <AlertTriangle size={18} /> Permanent Deletion
            </div>
            <div style={{ fontSize: '11px', color: '#8a8a8f', lineHeight: 1.5 }}>
              Are you sure you want to permanently delete "{fileToDeletePermanently.name}"? This will move the file to the OS Recycle Bin.
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', marginTop: '8px' }}>
              <button
                onClick={() => setFileToDeletePermanently(null)}
                className="cred-button"
                style={{ flex: 1, justifyContent: 'center', padding: '10px' }}
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  try {
                    await window.electron.ipcRenderer.invoke('delete-files-permanently', [fileToDeletePermanently.path])
                    refreshTrash()
                  } catch (err) {
                    console.error(err)
                  } finally {
                    setFileToDeletePermanently(null)
                  }
                }}
                className="cred-button"
                style={{
                  flex: 1,
                  justifyContent: 'center',
                  background: '#e11d2e',
                  borderColor: '#e11d2e',
                  color: '#f2f2f0',
                  padding: '10px'
                }}
              >
                Delete Forever
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Empty Trash Confirm Modal */}
      {showEmptyTrashConfirm && (
        <div
          onClick={() => setShowEmptyTrashConfirm(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.85)',
            backdropFilter: 'blur(12px)',
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
              padding: '28px 36px',
              borderRadius: '4px', // CRED sharp corners
              maxWidth: '420px',
              width: '90%',
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              gap: '20px',
              border: '1.5px solid #e11d2e',
              boxShadow: 'none',
              animation: 'slideInUp 0.25s cubic-bezier(0.22, 1, 0.36, 1)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', fontSize: '16px', fontWeight: 700, color: '#e11d2e', textTransform: 'uppercase', letterSpacing: '1px' }}>
              <AlertTriangle size={18} /> Empty Trash Bin
            </div>
            <div style={{ fontSize: '11px', color: '#8a8a8f', lineHeight: 1.5 }}>
              Are you sure you want to permanently delete all {trashCount} items in the trash? This will move the files physically to the OS Recycle Bin.
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', marginTop: '8px' }}>
              <button
                onClick={() => setShowEmptyTrashConfirm(false)}
                className="cred-button"
                style={{ flex: 1, justifyContent: 'center', padding: '10px' }}
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  try {
                    await window.electron.ipcRenderer.invoke('empty-trash')
                    refreshTrash()
                  } catch (err) {
                    console.error(err)
                  } finally {
                    setShowEmptyTrashConfirm(false)
                  }
                }}
                className="cred-button"
                style={{
                  flex: 1,
                  justifyContent: 'center',
                  background: '#e11d2e',
                  borderColor: '#e11d2e',
                  color: '#f2f2f0',
                  padding: '10px'
                }}
              >
                Empty Trash
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}