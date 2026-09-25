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
        filesUpdatedListeners.forEach(l => l({ drive, groups: mockGroups, reason: 'initial' }))
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
import DriveSelectionView from './components/DriveSelectionView'
import PhotoGrid from './components/PhotoGrid'
import MagneticDock from './components/MagneticDock'
import MapPage from './components/MapPage'
import UnresolvedFolders from './components/UnresolvedFolders'
import AppearanceSetting from './components/AppearanceSetting'
import GlassSelect from './components/GlassSelect'
import DateScrubber from './components/DateScrubber'
import { useLibrary, type LibraryGroup, type LibraryQuery } from './hooks/useLibrary'

/**
 * Group keys come out of SQL in a sortable form (an ISO date slice, rounded
 * coordinates, a flag). Turning them into something readable stays here so
 * locale formatting never has to happen in a query.
 */
function makeGroupFormatter(groupBy: string): (key: string) => string {
  if (groupBy === 'day') {
    const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    return (k) => { const d = new Date(k + 'T00:00:00'); return isNaN(d.getTime()) ? 'Unknown date' : fmt.format(d) }
  }
  if (groupBy === 'month') {
    const fmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long' })
    return (k) => { const d = new Date(k + '-01T00:00:00'); return isNaN(d.getTime()) ? 'Unknown date' : fmt.format(d) }
  }
  if (groupBy === 'year') return (k) => k || 'Unknown year'
  if (groupBy === 'location') return (k) => (k === 'none' ? 'No location info' : `Coords (${k})`)
  return (k) => (k === 'fav' ? 'Favourites' : 'Other files')
}
import {
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
  Settings,
  ArrowLeft,
  PanelLeft,
  PanelLeftClose
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

const ScanProgressDisplay: React.FC<{ scanning: boolean; scanCount: number }> = React.memo(({ scanning, scanCount }) => {
  if (!scanning) return null
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        fontSize: '10px',
        color: '#ffffff',
        fontWeight: 600,
        background: 'rgba(225, 29, 46, 0.15)',
        border: '1px solid rgba(225, 29, 46, 0.4)',
        borderRadius: '3px',
        padding: '2px 8px',
        letterSpacing: '0.5px'
      }}
    >
      <div
        style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          border: '2px solid rgba(255,255,255,0.2)',
          borderTop: '2px solid #e11d2e',
          animation: 'tileSpin 0.8s linear infinite'
        }}
      />
      <span>Fast Enumeration: <strong style={{ color: '#e11d2e' }}>{scanCount.toLocaleString()}</strong> files mapped</span>
    </div>
  )
})
function thumbUrl(file: ScannedFile): string {
  const src = file.thumb || file.path
  return 'media:///' + src.replace(/\\/g, '/')
}

export const FileTile = React.memo(({
  file, onOpen, onFav, isFav, isSelected, onSelect, onContextMenu, tileSize, isTrashView, onRestore, onDeletePermanently, isDeleting, onDragStart, selectedPaths
}: {
  file: ScannedFile
  /** Changes when file.thumb is patched in place, so memo re-renders. */
  thumbKey?: string | null
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
  selectedPaths?: string[]
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

  const dragInfoRef = useRef<{
    startX: number
    startY: number
    isDragging: boolean
    hasTriggered: boolean
  } | null>(null)

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || isTrashView) return
    e.currentTarget.style.transform = 'scale(0.97)'
    dragInfoRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      isDragging: false,
      hasTriggered: false
    }
  }, [isTrashView])

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragInfoRef.current || dragInfoRef.current.hasTriggered || isTrashView) return
    const dx = e.clientX - dragInfoRef.current.startX
    const dy = e.clientY - dragInfoRef.current.startY
    const dist = Math.hypot(dx, dy)

    if (dist > 5) {
      dragInfoRef.current.isDragging = true
      dragInfoRef.current.hasTriggered = true
      e.preventDefault()
      e.currentTarget.style.transform = 'scale(1)'

      const filePaths = (isSelected && selectedPaths && selectedPaths.length > 0 && selectedPaths.includes(file.path))
        ? selectedPaths
        : [file.path]

      window.api.startNativeDrag(filePaths)
    }
  }, [file.path, isSelected, selectedPaths, isTrashView])

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.style.transform = 'scale(1)'
    const wasDragging = dragInfoRef.current?.isDragging
    dragInfoRef.current = null
    if (!wasDragging) {
      onOpen(file, e)
    }
  }, [file, onOpen])

  const handleMouseLeave = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    setHovered(false)
    e.currentTarget.style.transform = 'scale(1)'
  }, [])

  return (
    <div
      onContextMenu={(e) => onContextMenu(file, e)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={handleMouseLeave}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      draggable={!isTrashView}
      onDragStart={(e) => onDragStart?.(file, e)}
      data-grid-tile={file.path}
      style={{
        borderRadius: '4px', // CRED style sharp corners
        aspectRatio: '1',
        cursor: 'pointer',
        overflow: 'hidden',
        background: 'var(--app-surface, var(--app-surface, #111114))',
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
    >
      {(isPhoto || isVideo) && (isPhoto ? !error : (hasThumb && !error)) ? (
        <>
          {!loaded && (
            <div style={{ position: 'absolute', inset: 0, background: 'var(--app-surface, var(--app-surface, #111114))', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ width: '16px', height: '16px', border: '1.5px solid #202025', borderTop: '1.5px solid #e11d2e', borderRadius: '0%', animation: 'tileSpin 0.8s linear infinite' }} />
            </div>
          )}
          <img key={imgKey} src={thumbUrl(file)} loading="lazy" decoding="async"
            onLoad={() => setLoaded(true)} onError={() => { setError(true); setLoaded(true) }}
            style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: loaded ? 1 : 0, transition: 'opacity 0.2s', willChange: 'transform' }}
          />
          {isVideo && loaded && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.2)' }}>
              <div style={{ width: '26px', height: '26px', borderRadius: '4px', background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', transition: 'transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1)' }}>
                <Play size={12} fill="#ffffff" stroke="none" />
              </div>
            </div>
          )}
        </>
      ) : isVideo ? (
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px', background: '#1b1212' }}>
          <Film size={iconSize} color="#e11d2e" />
          <div style={{ fontSize: subFontSize, color: 'var(--app-fg-dim, #8a8a8f)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{file.ext}</div>
          {tileSize >= 80 && <div style={{ fontSize: '8px', color: 'var(--app-fg-dim, #8a8a8f)', maxWidth: '90%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{file.name}</div>}
        </div>
      ) : isDoc ? (
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px', background: '#121a1b' }}>
          <FileText size={iconSize} color="#d0d0e0" />
          <div style={{ fontSize: subFontSize, color: 'var(--app-fg-dim, #8a8a8f)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{file.ext}</div>
          {tileSize >= 80 && <div style={{ fontSize: '8px', color: 'var(--app-fg-dim, #8a8a8f)', maxWidth: '90%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{file.name}</div>}
        </div>
      ) : (
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
          <ImageIcon size={iconSize} color="var(--app-fg-dim, #8a8a8f)" />
          <div style={{ fontSize: subFontSize, color: 'var(--app-fg-dim, #8a8a8f)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{file.ext}</div>
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
          <div style={{ fontSize: '9px', fontWeight: 600, color: 'var(--app-fg, #f2f2f0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{file.name}</div>
        </div>
      )}

      {/* Select item checkbox overlay */}
      {!isTrashView && (
        <div onClick={(e) => { e.stopPropagation(); onSelect(file, e) }}
          style={{ position: 'absolute', top: '4px', left: '4px', width: '16px', height: '16px', borderRadius: '2px', background: isSelected ? '#e11d2e' : 'rgba(0,0,0,0.6)', border: `1.5px solid ${isSelected ? '#e11d2e' : 'rgba(255,255,255,0.3)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '9px', cursor: 'pointer', color: 'var(--app-fg, #f2f2f0)', opacity: hovered || isSelected ? 1 : 0, transition: 'opacity 0.15s' }}
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
            <RotateCcw size={12} color="var(--app-fg, #f2f2f0)" />
          </div>
        ) : (
          <div onClick={(e) => { e.stopPropagation(); onFav(file) }}
            style={{ position: 'absolute', top: '4px', right: '4px', width: '20px', height: '20px', borderRadius: '4px', background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', opacity: hovered || isFav ? 1 : 0, transition: 'opacity 0.15s' }}
          >
            <Heart size={12} color={isFav ? '#e11d2e' : 'var(--app-fg, #f2f2f0)'} fill={isFav ? '#e11d2e' : 'none'} />
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
            color: 'var(--app-fg, #f2f2f0)',
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
        return src ? `<img src="${src}" style="width:56px;height:56px;object-fit:cover;border-radius:4px;" />` : `<div style="width:56px;height:56px;background:#222226;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:18px;">${videoExts.includes(f.ext) ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--app-fg-dim, #8a8a8f);"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>' : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--app-fg-dim, #8a8a8f);"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>'}</div>`
      }).join('')
      marker.bindPopup(`<div style="font-size:12px;min-width:140px;font-family:system-ui,sans-serif;"><div style="font-weight:600;margin-bottom:6px;color:var(--app-fg, #f2f2f0);">${count} file${count > 1 ? 's' : ''}</div><div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;">${thumbsHtml}</div><div style="font-size:10px;color:var(--app-fg-dim, #8a8a8f);">${new Date(first.date).toLocaleDateString()}</div>${count > 4 ? `<div style="font-size:10px;color:#e11d2e;margin-top:2px;">+${count - 4} more</div>` : ''}</div>`, { maxWidth: 200 })
      
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
        <div style={{ flex: 1, background: 'var(--app-surface, var(--app-surface, #111114))', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.04)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
          <MapIcon size={48} style={{ color: 'var(--app-fg-muted, #52525b)' }} />
          <div style={{ fontSize: '13px', color: 'var(--app-fg-dim, #8a8a8f)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px' }}>No Location Information</div>
          <div style={{ fontSize: '11px', color: 'var(--app-fg-muted, #52525b)' }}>Photos with GPS EXIF metadata will be plotted here.</div>
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
  drives: DriveInfo[]
  handleDriveClick: (name: string) => void
  driveFiles?: Record<string, Record<string, ScannedFile[]>>
  allFiles: ScannedFile[]
  favourites: Set<string>
  /** Every favourite row across all drives, already filtered by the main process. */
  favRecords: ScannedFile[]
  selected: Set<string>
  deletingPaths: Set<string>
  handleTileOpen: (file: ScannedFile, indexOrList: number | ScannedFile[], e?: React.MouseEvent) => void
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
  onTileSizeCommit: (size: number) => void
  transitioning: boolean
  setTransitioning: (transitioning: boolean) => void
  libraryGroups: LibraryGroup[]
  getRow: (index: number) => ScannedFile | undefined
  pageVersion: number
  ensureRange: (start: number, end: number) => void
  /** Four thumbnails per year for the Years cards, read outside the page cache. */
  yearPreviews: Record<string, ScannedFile[]>
  /** The gallery's query, so the Map page honours the same filter and search. */
  libraryQuery: LibraryQuery | null
  /** Called after a folder relink, to re-read the library with the new paths. */
  onFoldersRelinked: () => void
  formatGroupKey: (key: string) => string
  handleWheel: (e: React.WheelEvent) => void
  handleGroupCheckboxClick: (groupKey: string, e: React.MouseEvent) => void
  groupBy: string
  onDragStart: (file: ScannedFile, e: React.DragEvent) => void
  setActiveView: (view: string) => void
  /** Bumped to send the grid back to the top after a grouping/order change. */
  scrollToTopNonce: number
  onGridZoomOutBeyond: () => void
  onGridZoomInBeyond: () => void
  visibleKeyRefProp: React.MutableRefObject<string | null>
  pendingGroupAnchorRef: React.MutableRefObject<string | null>
  thumbVersion: number
  hoverPreviewsEnabled: boolean
  onHoverPreviewsChange: (enabled: boolean) => void
  libraryState: 'idle' | 'loading' | 'ready'
  runtimeMode: { safeMode: boolean; userDataPath: string; isDefaultUserData: boolean } | null
  driveOpened: { drive: string; indexed: number; needsInitialScan: boolean } | null
  onReconcile: () => void
}> = React.memo(({
  activeNav,
  activeView,
  scanning,
  scanCount,
  selectedDrive,
  drives,
  handleDriveClick,
  driveFiles,
  allFiles,
  favourites,
  favRecords,
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
  onTileSizeChange,
  onTileSizeCommit,
  transitioning,
  libraryGroups,
  getRow,
  pageVersion,
  ensureRange,
  yearPreviews,
  libraryQuery,
  onFoldersRelinked,
  formatGroupKey,
  handleWheel,
  handleGroupCheckboxClick,
  groupBy,
  onDragStart,
  setActiveView,
  scrollToTopNonce,
  onGridZoomOutBeyond,
  onGridZoomInBeyond,
  visibleKeyRefProp,
  pendingGroupAnchorRef,
  thumbVersion,
  hoverPreviewsEnabled,
  onHoverPreviewsChange,
  libraryState,
  runtimeMode,
  driveOpened,
  onReconcile
}) => {
  const [placesSubView, setPlacesSubView] = useState<'map' | 'globe'>('map')
  const [windowWidth, setWindowWidth] = useState(window.innerWidth)

  const virtuosoRef = useRef<any>(null)
  // Timeline preview strips are sized to the row they sit in. They used to be
  // a fixed twelve thumbnails, which on a wide window filled about a third of
  // the width and left the rest empty - the large blank region in the gallery.
  const listWrapRef = useRef<HTMLDivElement>(null)
  const [listWidth, setListWidth] = useState(0)
  useEffect(() => {
    const el = listWrapRef.current
    if (!el) return
    const measure = (): void => setListWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [activeView])
  // 80px tile + 5px gap. One cell is held back for the "+N more" affordance.
  const TIMELINE_CELL = 85
  const timelinePreviewCount = Math.max(
    6,
    Math.min(40, Math.floor((listWidth - 90) / TIMELINE_CELL) - 1)
  )

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // Not `allFiles.filter(...)`: allFiles only holds the open drive's loaded
  // rows, so favourites on any other drive were silently dropped.
  const allFavFiles = favRecords

  const chunkArray = <T,>(array: T[], size: number): T[][] => {
    const result: T[][] = []
    for (let i = 0; i < array.length; i += size) {
      result.push(array.slice(i, i + size))
    }
    return result
  }

  // 2. Timeline Items construction
  // Built from the group summary. Preview rows resolve through the same paged
  // getRow the grid uses, so a timeline over a million files still holds only
  // the handful of rows actually shown.
  const timelineItems = useMemo(() => {
    if (activeView !== 'Timeline') return []
    const items: any[] = []
    for (const g of libraryGroups) {
      items.push({
        type: 'timeline-header',
        key: `timeline-header-${g.key}`,
        monthKey: g.key,
        label: formatGroupKey(g.key),
        filesCount: g.count
      })
      const previewCount = Math.min(timelinePreviewCount, g.count)
      const rowFiles: ScannedFile[] = []
      for (let i = 0; i < previewCount; i++) {
        const f = getRow(g.offset + i)
        if (f) rowFiles.push(f)
      }
      items.push({
        type: 'timeline-row',
        key: `timeline-row-${g.key}`,
        monthKey: g.key,
        offset: g.offset,
        previewCount,
        rowFiles,
        hasMore: g.count > previewCount,
        remaining: g.count - previewCount
      })
    }
    return items
  }, [libraryGroups, formatGroupKey, getRow, activeView, timelinePreviewCount])

  // Keep the previews for visible timeline groups resident.
  useEffect(() => {
    if (activeView !== 'Timeline' || libraryGroups.length === 0) return
    const first = libraryGroups[0]
    const last = libraryGroups[Math.min(libraryGroups.length - 1, 20)]
    ensureRange(first.offset, last.offset + Math.min(timelinePreviewCount, last.count))
  }, [activeView, libraryGroups, ensureRange, timelinePreviewCount])

  // 3. Years Items construction
  // Year totals come from the summary, so no file rows are needed to build this.
  const yearsItems = useMemo(() => {
    if (activeView !== 'Years') return []
    const items: any[] = []
    items.push({ type: 'years-header', key: 'years-header' })
    const yearTotals: Record<string, { count: number; offset: number }> = {}
    for (const g of libraryGroups) {
      const year = (g.maxDate || g.key).slice(0, 4) || 'Unknown'
      const bucket = yearTotals[year]
      if (bucket) bucket.count += g.count
      else yearTotals[year] = { count: g.count, offset: g.offset }
    }
    const yearNum = (y: string): number => (/^\d+$/.test(y) ? Number(y) : -Infinity)
    const years = Object.keys(yearTotals).sort((a, b) => yearNum(b) - yearNum(a))
    const yearsPerRow = Math.max(1, Math.floor((windowWidth - 260) / (200 + 16)))
    chunkArray(years, yearsPerRow).forEach((rowYears, rowIndex) => {
      items.push({ type: 'years-row', key: `years-row-${rowIndex}`, rowYears, yearTotals, getRow, yearPreviews })
    })
    return items
  }, [libraryGroups, activeView, windowWidth, getRow, yearPreviews])

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
    if (activeView === 'Timeline') return timelineItems
    if (activeView === 'Years') return yearsItems
    return []
  }, [activeNav, activeView, favouritesItems, trashItems, timelineItems, yearsItems])

  const [gridScrollRequest, setGridScrollRequest] = useState<{ key: string; nonce: number } | null>(null)

  // Re-anchor after a grouping change. Group keys are date slices, so the group
  // covering the same moment is whichever key is a prefix of the old one, or
  // has the old one as its prefix. Resolved against the new summary, so keeping
  // the user's place needs no file rows at all.
  useEffect(() => {
    const anchor = pendingGroupAnchorRef.current
    if (!anchor || libraryGroups.length === 0) return
    pendingGroupAnchorRef.current = null
    const match =
      libraryGroups.find((g) => anchor.startsWith(g.key)) ??
      libraryGroups.find((g) => g.key.startsWith(anchor))
    if (match) setGridScrollRequest({ key: match.key, nonce: Date.now() })
  }, [libraryGroups, pendingGroupAnchorRef])
  const [visibleKey, setVisibleKey] = useState<string | null>(null)
  const onVisibleKeyChange = useCallback((key: string | null) => {
    setVisibleKey(key)
    visibleKeyRefProp.current = key
  }, [])
  const jumpToGroup = useCallback((key: string | undefined) => {
    setActiveView('Grid')
    if (key) setGridScrollRequest({ key, nonce: Date.now() })
  }, [setActiveView])
  const handleYearClick = useCallback((year: string) => {
    setYearFilter(null)
    jumpToGroup(libraryGroups.find(g => (g.maxDate || g.key).slice(0, 4) === year)?.key)
  }, [libraryGroups, setYearFilter, jumpToGroup])

  const renderItem = (item: any) => {
    switch (item.type) {
      case 'timeline-header': {
        const { monthKey, filesCount, allSel } = item
        return (
          <div style={{ position: 'relative', marginBottom: '10px' }}>
            <div style={{ position: 'absolute', left: '-28.5px', top: '8px', width: '8px', height: '8px', borderRadius: '50%', background: '#e11d2e', border: '2px solid var(--app-bg, #0a0a0c)' }} />
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
                    color: 'var(--app-fg, #f2f2f0)',
                    marginLeft: '4px'
                  }}
                >
                  {allSel && <Check size={10} strokeWidth={3} />}
                </div>
              )}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--app-fg-dim, #8a8a8f)', marginTop: '4px' }}>{filesCount} files</div>
          </div>
        )
      }
      case 'timeline-row': {
        const { rowFiles, files, hasMore, remaining, monthKey } = item
        return (
          <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', marginBottom: '28px' }}>
            {rowFiles.map((file: ScannedFile) => (
              <div key={file.path} style={{ width: '80px', height: '80px', flexShrink: 0 }}>
              <FileTile
                file={file}
                thumbKey={file.thumb}
                onOpen={(f, e) => handleTileOpen(f, files, e)}
                onFav={handleFav}
                isFav={favourites.has(file.path)}
                isSelected={selected.has(file.path)}
                onSelect={handleSelect}
                onContextMenu={(f, e) => handleTileContextMenu(f, files, e)}
                tileSize={80}
                isDeleting={deletingPaths.has(file.path)}
                onDragStart={onDragStart}
                selectedPaths={Array.from(selected)}
              />
              </div>
            ))}
            {hasMore && <div onClick={() => jumpToGroup(monthKey)} title="Show all in grid" style={{ width: '80px', height: '80px', borderRadius: '4px', background: 'var(--app-surface-2, var(--app-surface-2, #161619))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', color: '#e11d2e', cursor: 'pointer', fontWeight: 600 }}>+{remaining} more</div>}
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
        // `yearMap` never existed on this item. When the years view moved to
        // the paged summary the item started carrying `yearTotals` (a count
        // and a starting offset per year) instead of arrays of file rows, but
        // this branch still destructured the old name - so `yearMap[year]`
        // threw on the first render and took the whole app down with it,
        // which is the blank screen on opening Years.
        const { rowYears, yearTotals, getRow: getYearRow, yearPreviews: previews } = item
        return (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '16px', marginBottom: '16px' }}>
            {rowYears.map((year: string) => {
              const info = yearTotals?.[year] as { count: number; offset: number } | undefined
              // Prefer the four rows fetched for this year. Resident grid
              // rows are only a fallback for the moment before they land.
              let previewFiles: ScannedFile[] = previews?.[year] ?? []
              if (previewFiles.length === 0 && info && typeof getYearRow === 'function') {
                const fallback: ScannedFile[] = []
                for (let i = 0; i < 40 && fallback.length < 4; i++) {
                  const f = getYearRow(info.offset + i) as ScannedFile | undefined
                  if (f && f.thumb) fallback.push(f)
                }
                previewFiles = fallback
              }
              return (
                <div key={year} onClick={() => handleYearClick(year)}
                  style={{ background: 'var(--app-surface, var(--app-surface, #111114))', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.04)', overflow: 'hidden', cursor: 'pointer', transition: 'transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1), border-color 0.25s' }}
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
                        <div key={i} style={{ background: 'var(--app-surface-2, var(--app-surface-2, #161619))', overflow: 'hidden', borderRight: i % 2 === 0 ? '1px solid var(--app-bg, #0a0a0c)' : undefined, borderBottom: i < 2 ? '1px solid var(--app-bg, #0a0a0c)' : undefined, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {src ? <YearThumb src={src} /> : <Camera size={20} style={{ opacity: 0.15 }} />}
                        </div>
                      )
                    })}
                  </div>
                  <div style={{ padding: '12px 14px 14px' }}>
                    <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--app-fg, #f2f2f0)', letterSpacing: '-0.3px' }}>{year}</div>
                    <div style={{ fontSize: '9px', color: 'var(--app-fg-dim, #8a8a8f)', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{info?.count ?? 0} files</div>
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
              <FileTile key={file.path} file={file} thumbKey={file.thumb} onOpen={(f, e) => handleTileOpen(f, allFavFiles, e)} onFav={handleFav} isFav={true} isSelected={selected.has(file.path)} onSelect={handleSelect} onContextMenu={(f, e) => handleTileContextMenu(f, allFavFiles, e)} tileSize={100} isDeleting={deletingPaths.has(file.path)} onDragStart={onDragStart} selectedPaths={Array.from(selected)} />
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
                thumbKey={file.thumb}
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
              <h2 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--app-fg, #f2f2f0)', letterSpacing: '-0.5px', margin: 0 }}>
                Trash Collection
              </h2>
              <div style={{ fontSize: '9px', color: 'var(--app-fg-dim, #8a8a8f)', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Items in trash are soft-deleted and permanently purged after 30 days.
              </div>
            </div>
            {trashedFiles.length > 0 && (
              <button
                onClick={() => setShowEmptyTrashConfirm(true)}
                className="cred-button"
                style={{ background: '#e11d2e', color: 'var(--app-fg, #f2f2f0)', border: 'none', fontWeight: 700 }}
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
    if (activeView === 'Timeline') return 550
    if (activeView === 'Years') return 1000
    return 500
  }, [activeView])

  const tileSizePercent = (tileSize / 120) * 100

  // Cached files for this drive are already loaded (see hasFiles below) - background
  // scanning/indexing must never hide them. Only a genuinely empty, never-scanned
  // drive falls through to the full-screen "indexing" state further down.
  const hasFiles = allFiles.length > 0

  const isVirtualized =
    (hasFiles || !scanning) &&
    selectedDrive &&
    activeNav !== 'places' &&
    activeNav !== 'archive' &&
    activeNav !== 'settings' &&
    activeView !== 'Map' &&
    !(activeNav === 'trash' && trashedFiles.length === 0) &&
    !(activeNav === 'favourites' && allFavFiles.length === 0)

  // A gallery with nothing in it has several very different causes, and showing
  // the same blank grid for all of them is what made a diagnostic session look
  // like a lost library. Each one now says which it is.
  // Map is a destination of its own, like Settings: a full-height page with
  // none of the gallery chrome. The bottom inset keeps the floating dock clear
  // of the map's own controls at every window size.
  // Not gated on `scanning`: the map reads the index, so a background scan is
  // no reason to drop the user back into the gallery when they ask for Map.
  if (activeNav === 'map') {
    return (
      <div
        className="view-transition-enter"
        style={{ flex: 1, minHeight: 0, padding: '16px 20px 104px', display: 'flex' }}
      >
        <MapPage query={libraryQuery} onOpenFile={handleTileOpen} />
      </div>
    )
  }

  if (selectedDrive && !hasFiles && activeNav !== 'archive' && activeNav !== 'trash' && activeNav !== 'settings' && activeNav !== 'places') {
    const loading = libraryState !== 'ready' || scanning
    const diagnostic = !!runtimeMode?.safeMode
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '14px', padding: '40px', textAlign: 'center' }}>
        {loading ? (
          <>
            <div style={{ width: '220px', height: '2px', background: '#1c1c22', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: '40%', background: 'linear-gradient(90deg, transparent, #e11d2e, transparent)', animation: 'shimmer 1.4s ease-in-out infinite' }} />
            </div>
            <div style={{ fontSize: '12px', color: 'var(--app-fg, #f2f2f0)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>
              Loading {selectedDrive}…
            </div>
            <div style={{ fontSize: '10px', color: 'var(--app-fg-dim, #8a8a8f)' }}>
              {scanning ? `${scanCount.toLocaleString()} files mapped so far` : 'Reading the cached index'}
            </div>
          </>
        ) : diagnostic ? (
          <>
            <AlertTriangle size={40} color="#f5c542" />
            <div style={{ fontSize: '13px', color: '#f5c542', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>
              Diagnostic mode — your library is not loaded
            </div>
            <div style={{ fontSize: '11px', color: 'var(--app-fg-dim, #8a8a8f)', maxWidth: '520px', lineHeight: 1.6 }}>
              This window is using an isolated diagnostic database, so {selectedDrive} has no records here.
              Your real library is untouched. Close this window and open <strong style={{ color: 'var(--app-fg, #f2f2f0)' }}>DiskFrame</strong> (not
              “DiskFrame — Diagnostics”) to browse it.
            </div>
            <div style={{ fontSize: '9px', color: 'var(--app-fg-muted, #52525b)', wordBreak: 'break-all', maxWidth: '520px' }}>{runtimeMode?.userDataPath}</div>
          </>
        ) : driveOpened?.needsInitialScan ? (
          <>
            <FolderOpen size={40} style={{ color: 'var(--app-fg-muted, #52525b)' }} />
            <div style={{ fontSize: '13px', color: 'var(--app-fg, #f2f2f0)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>
              {selectedDrive} has not been indexed yet
            </div>
            <div style={{ fontSize: '11px', color: 'var(--app-fg-dim, #8a8a8f)', maxWidth: '460px', lineHeight: 1.6 }}>
              Opening a drive only reads the existing index — it never scans on its own. Scanning a large
              drive reads every folder and can take a long time.
            </div>
            <button onClick={onReconcile} className="cred-button" style={{ marginTop: '4px', padding: '8px 18px', background: '#e11d2e', borderColor: '#e11d2e', color: '#fff', fontWeight: 700 }}>
              Scan {selectedDrive} now
            </button>
          </>
        ) : (
          <>
            <FolderOpen size={40} style={{ color: 'var(--app-fg-muted, #52525b)' }} />
            <div style={{ fontSize: '13px', color: 'var(--app-fg, #f2f2f0)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>
              Nothing matches in {selectedDrive}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--app-fg-dim, #8a8a8f)', maxWidth: '460px', lineHeight: 1.6 }}>
              {driveOpened ? `${driveOpened.indexed.toLocaleString()} records are indexed for this drive, but none match the current filter or search.` : 'No records match the current filter or search.'}
            </div>
          </>
        )}
      </div>
    )
  }

  if (isVirtualized && activeView === 'Grid' && activeNav !== 'favourites' && activeNav !== 'trash') {
    return (
      <div className="view-transition-enter" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, ...animationStyle }}>
        {/* Above the grid, because it explains why a block of it is unavailable
            and offers the one action that fixes the whole block. */}
        <div style={{ padding: '0 20px' }}>
          <UnresolvedFolders drive={selectedDrive} onRelinked={onFoldersRelinked} />
        </div>
        <PhotoGrid
          groups={libraryGroups}
          getRow={getRow}
          pageVersion={pageVersion}
          ensureRange={ensureRange}
          formatGroupKey={formatGroupKey}
          selected={selected}
          favourites={favourites}
          deletingPaths={deletingPaths}
          tileSize={tileSize}
          onTileSizeCommit={onTileSizeCommit}
          onZoomOutBeyond={onGridZoomOutBeyond}
          onZoomInBeyond={onGridZoomInBeyond}
          onOpen={handleTileOpen}
          onSelect={handleSelect}
          onFav={handleFav}
          onContextMenu={handleTileContextMenu}
          onGroupCheckboxClick={handleGroupCheckboxClick}
          scrollRequest={gridScrollRequest}
          scrollToTopNonce={scrollToTopNonce}
          thumbVersion={thumbVersion}
          hoverPreviewsEnabled={hoverPreviewsEnabled}
          onVisibleKeyChange={onVisibleKeyChange}
        />
        <DateScrubber
          groups={libraryGroups}
          formatGroupKey={formatGroupKey}
          currentKey={visibleKey}
          onJump={jumpToGroup}
        />
      </div>
    )
  }

  if (isVirtualized) {
    return (
      <div
        ref={listWrapRef}
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
        {/* Only in the library itself; Settings and Map have their own pages. */}
        {activeNav !== 'trash' && (
          <div style={{ padding: '0 20px' }}>
            <UnresolvedFolders drive={selectedDrive} onRelinked={onFoldersRelinked} />
          </div>
        )}
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
        <div className="view-transition-enter settings-page">
          <div>
            <h2 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--app-fg, #f2f2f0)', letterSpacing: '-0.5px', margin: 0 }}>
              Settings
            </h2>
            <div style={{ fontSize: '9px', color: 'var(--app-fg-dim, #8a8a8f)', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Configure application parameters and interface layout
            </div>
          </div>

          <AppearanceSetting />

          {/* Same glass card as Appearance and the dock, so Settings reads as
              one surface rather than three different boxes. */}
          <section className="glass-panel settings-card" aria-labelledby="interface-heading">
            <h3 id="interface-heading" className="settings-heading">
              Interface Layout
            </h3>
            <div className="settings-field">
              <div className="settings-field-head">
                <label htmlFor="settings-tile-size-slider" className="settings-label">
                  Grid Tile Size
                </label>
                <span className="settings-value">
                  {Math.round(tileSizePercent)}% ({tileSize}px)
                </span>
              </div>
              <input
                id="settings-tile-size-slider"
                className="settings-slider"
                type="range"
                min="50"
                max="200"
                step="5"
                value={Math.round(tileSizePercent)}
                onChange={(e) => onTileSizeChange(Number(e.target.value))}
              />
              <div className="settings-hint">Adjusts the scale of grid item cards in the main lists.</div>
            </div>
          </section>

          <section className="glass-panel settings-card" aria-labelledby="playback-heading">
            <h3 id="playback-heading" className="settings-heading">
              Playback
            </h3>
            <div className="settings-field">
              <div className="settings-field-head">
                <label htmlFor="settings-hover-previews" className="settings-label">
                  Video hover previews
                </label>
                <input
                  id="settings-hover-previews"
                  className="settings-switch"
                  type="checkbox"
                  checked={hoverPreviewsEnabled}
                  onChange={(e) => onHoverPreviewsChange(e.target.checked)}
                />
              </div>
              <div className="settings-hint">Play a short muted preview when hovering a video tile.</div>
            </div>
          </section>
        </div>
      )}

      {/* Coming soon components */}
      {!scanning && activeNav === 'archive' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '12px' }} className="view-transition-enter">
          <FolderArchive size={48} style={{ color: 'var(--app-fg-muted, #52525b)' }} />
          <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--app-fg, #f2f2f0)', textTransform: 'uppercase', letterSpacing: '1px' }}>Archive</div>
          <div style={{ fontSize: '11px', color: 'var(--app-fg-dim, #8a8a8f)', padding: '5px 12px', borderRadius: '4px', background: 'var(--app-surface, var(--app-surface, #111114))', border: '1px solid rgba(255,255,255,0.04)' }}>Coming soon</div>
        </div>
      )}

      {/* Trash Lifecycle Bin View - Empty state only */}
      {!scanning && activeNav === 'trash' && trashedFiles.length === 0 && (
        <div className="view-transition-enter">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <div>
              <h2 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--app-fg, #f2f2f0)', letterSpacing: '-0.5px', margin: 0 }}>
                Trash Collection
              </h2>
              <div style={{ fontSize: '9px', color: 'var(--app-fg-dim, #8a8a8f)', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Items in trash are soft-deleted and permanently purged after 30 days.
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '50vh', gap: '12px' }}>
            <Trash2 size={48} style={{ color: 'var(--app-fg-muted, #52525b)' }} />
            <div style={{ fontSize: '13px', color: 'var(--app-fg-dim, #8a8a8f)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px' }}>Trash is empty.</div>
            <div style={{ fontSize: '10px', color: 'var(--app-fg-muted, #52525b)' }}>Soft-deleted photos and videos will appear here.</div>
          </div>
        </div>
      )}

      {/* Prompt scan drive / Interactive Drive Selection Grid */}
      {!selectedDrive && activeNav !== 'archive' && activeNav !== 'trash' && activeNav !== 'settings' && (
        <DriveSelectionView
          drives={drives}
          onDriveSelect={handleDriveClick}
          driveFiles={driveFiles}
        />
      )}

      {/* Indexing scanner progress - only shown when a drive has never been indexed yet.
          Once any cached files exist, isVirtualized takes over and the grid renders
          instead, with the scan running quietly in the status bar (ScanProgressDisplay). */}
      {scanning && !hasFiles && activeNav !== 'archive' && activeNav !== 'trash' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '12px' }} className="view-transition-enter">
          <div style={{ fontSize: '13px', color: '#e11d2e', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px' }}>Indexing media on {selectedDrive}...</div>
          <div style={{ fontSize: '10px', color: 'var(--app-fg-dim, #8a8a8f)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{scanCount} files mapped</div>
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
          <div style={{ color: 'var(--app-fg-dim, #8a8a8f)', fontSize: '13px', marginTop: '16px' }}>No favourites yet. Add items to your favorites.</div>
        </div>
      )}

      {/* Places Map View featuring Map/Globe toggle */}
      {!scanning && activeNav === 'places' && (
        <div style={{ height: 'calc(100vh - 120px)', display: 'flex', flexDirection: 'column', gap: '10px' }} className="view-transition-enter">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
            <div style={{ fontSize: '10px', color: 'var(--app-fg-dim, #8a8a8f)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 700 }}>
              📍 {allFiles.filter(f => f.lat !== null && f.lng !== null).length} Mapped Coordinates
            </div>
            <div style={{ display: 'flex', background: 'var(--app-surface, var(--app-surface, #111113))', borderRadius: '4px', padding: '2px', border: '1px solid rgba(255,255,255,0.04)' }}>
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
                  color: placesSubView === 'map' ? '#e11d2e' : 'var(--app-fg-dim, #8a8a8f)',
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
                  color: placesSubView === 'globe' ? '#e11d2e' : 'var(--app-fg-dim, #8a8a8f)',
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

  // Background changes are parked here rather than applied, so the gallery
  // never rearranges itself under an active reader. The user applies them with
  // the "Updates available" button.
  // Set only when the main process launched in diagnostic mode with a sample folder.
  const [safeModeSample, setSafeModeSample] = useState<{ folder: string; count: number } | null>(null)
  // Queried once on mount. A pushed event could be missed if the renderer
  // subscribed after it fired, which is how a diagnostic session (isolated,
  // empty database) was mistaken for the real app having lost its library.
  const [runtimeMode, setRuntimeMode] = useState<{
    safeMode: boolean
    userDataPath: string
    isDefaultUserData: boolean
  } | null>(null)
  // Distinguishes "still loading" from "genuinely empty" so the status bar
  // never reports a confident 0 for data that simply has not arrived.
  const [libraryState, setLibraryState] = useState<'idle' | 'loading' | 'ready'>('idle')
  // The group key currently under the top edge, and the one to re-anchor to
  // after a grouping change.
  const visibleKeyRef = useRef<string | null>(null)
  const pendingGroupAnchorRef = useRef<string | null>(null)
  // What the cached open reported: how many records exist for this drive, and
  // whether it has never been indexed (which needs a first scan the user asks for).
  const [driveOpened, setDriveOpened] = useState<{ drive: string; indexed: number; needsInitialScan: boolean } | null>(null)
  const [updatesPending, setUpdatesPending] = useState(false)
  const pendingFilesRef = useRef<{ drive: string; groups: Record<string, ScannedFile[]> } | null>(null)
  const hasFilesRef = useRef(false)

  const [favourites, setFavourites] = useState<Set<string>>(new Set())
  // Full favourite rows, across every drive, already filtered of trashed
  // and hidden items by the main process.
  const [favRecords, setFavRecords] = useState<ScannedFile[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // `index` navigates the paged library. `list` is only set by the views that
  // are not the library - favourites, trash - which hold their own arrays.
  const [lightbox, setLightbox] = useState<{ file: ScannedFile; index: number; rect?: DOMRect; list?: ScannedFile[] } | null>(null)
  // Navigation reads the library live, so it is not pinned to whatever rows
  // happened to be resident when the viewer opened.
  const libraryRef = useRef<ReturnType<typeof useLibrary> | null>(null)
  const lightboxRef = useRef<typeof lightbox>(null)
  lightboxRef.current = lightbox
  const [activeView, setActiveView] = useState('Grid')

  // Both of these are user preferences, so they outlive the window. Same
  // localStorage the theme uses - no round trip to the main process for a
  // value the renderer is the only reader of.
  const [tileSize, setTileSize] = useState(() => {
    const v = Number(localStorage.getItem('diskframe-tile-size'))
    return v >= 60 && v <= 240 ? v : 120
  })
  const [transitioning, setTransitioning] = useState(false)
  const zoomTicksRef = useRef(0)
  const lastZoomDirRef = useRef<'in' | 'out' | null>(null)

  // Redesign / Trash / AI State
  const [groupBy, setGroupBy] = useState<'day' | 'month' | 'year' | 'location' | 'favorites'>('day')
  const [viewOrder, setViewOrder] = useState<'default' | 'reverse'>('default')
  // Bumped when the user picks a different grouping or order from the menus.
  // The list they were looking at no longer exists, so staying at the same
  // pixel offset drops them somewhere arbitrary in the new one - which reads
  // as "the sort did nothing". Zoom-driven grouping changes do NOT bump this:
  // they keep their own anchor so the zoom animation stays continuous.
  const [scrollToTopNonce, setScrollToTopNonce] = useState(0)

  // Settings and Map are destinations, not library filters. Keeping the query
  // on the last gallery filter means visiting one neither re-runs the library
  // query nor loses which filter the user was browsing.
  const [galleryNav, setGalleryNav] = useState('all')
  useEffect(() => {
    if (activeNav !== 'settings' && activeNav !== 'map') setGalleryNav(activeNav)
  }, [activeNav])
  const [hoverPreviewsEnabled, setHoverPreviewsEnabled] = useState(
    () => localStorage.getItem('diskframe-hover-previews') !== 'off'
  )
  useEffect(() => {
    localStorage.setItem('diskframe-tile-size', String(tileSize))
  }, [tileSize])
  useEffect(() => {
    localStorage.setItem('diskframe-hover-previews', hoverPreviewsEnabled ? 'on' : 'off')
  }, [hoverPreviewsEnabled])
  // Collapsed on every fresh launch. sessionStorage remembers the choice for
  // this window only, so reopening the app starts collapsed again.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem('df.sidebarCollapsed') !== 'false'
    } catch {
      return true
    }
  })
  useEffect(() => {
    try {
      sessionStorage.setItem('df.sidebarCollapsed', String(sidebarCollapsed))
    } catch {
      /* private mode - the default (collapsed) still applies */
    }
  }, [sidebarCollapsed])
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
  const [indexingFolder, setIndexingFolder] = useState(false)

  // The one signal that hides gallery chrome. `lightbox` is the shared
  // viewer-open state, so every viewer - photo, video, PDF, generic preview,
  // and the loading and error states of each - hides the circle, dock and date
  // ruler identically. A class on <body> rather than prop-drilling a flag into
  // the grid subtree for three widgets that only need to disappear.
  useEffect(() => {
    document.body.classList.toggle('viewer-open', !!lightbox)
    return () => document.body.classList.remove('viewer-open')
  }, [lightbox])

  // Index one folder the user picks, through the normal library path.
  // Bounded by the main process (file count + depth); no thumbnails are
  // generated here - those follow the viewport like any other view.
  const handleIndexFolder = useCallback(async (): Promise<void> => {
    const folder = await window.api.pickFolder()
    if (!folder) return
    setIndexingFolder(true)
    try {
      const r = await window.api.indexFolder(folder)
      if (!r.ok) {
        setToastMsg(`Could not index folder: ${r.error ?? 'unknown error'}`)
        return
      }
      // Say plainly when the walk stopped early. A partial result must not
      // read like a complete one - nothing outside what was visited has been
      // examined, let alone found missing.
      const why =
        r.stoppedBy === 'cancelled'
          ? ' - cancelled, partial'
          : r.stoppedBy === 'files'
            ? ' - stopped at the file cap, run again to continue'
            : r.stoppedBy === 'entries'
              ? ' - stopped at the entry cap, run again to continue'
              : ''
      setToastMsg(
        `Indexed ${r.added} new file${r.added === 1 ? '' : 's'} of ${r.seen ?? 0} seen ` +
          `(${r.visited ?? 0} entries visited) from ${folder}${why}`
      )
    } catch (err) {
      setToastMsg(`Could not index folder: ${String(err)}`)
    } finally {
      setIndexingFolder(false)
    }
  }, [])
  const [_dragOverDrive, _setDragOverDrive] = useState<string | null>(null)
  const clipboardPathsRef = useRef<string[]>([])
  const clipboardActionRef = useRef<'copy' | 'cut' | null>(null)

  // Queue to buffer thumbnail ready events, preventing multiple full re-renders
  const thumbQueueRef = useRef<{ filePath: string; thumbPath: string; tries?: number }[]>([])
  const fileIndexRef = useRef<Map<string, ScannedFile>>(new Map())
  // Held in a ref so the drain interval (created once) always reaches the
  // current library instance without being torn down and rebuilt.
  const patchLibraryThumbRef = useRef<(path: string, thumb: string) => boolean>(() => false)
  const [thumbVersion, setThumbVersion] = useState(0)

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

      // Thumbnails don't change grouping or order, so patch the file objects in place and
      // bump a version counter instead of rebuilding (and re-sorting) the whole library.
      // Rows live in the library's bounded page cache now, not in a
      // renderer-wide array. Patching only fileIndexRef meant any thumbnail
      // that arrived AFTER its page had been fetched never reached the tile -
      // which is why slower video thumbnails stayed as placeholders while
      // photos (already thumbed when the page was queried) looked fine.
      const index = fileIndexRef.current
      let patched = false
      const unmatched: { filePath: string; thumbPath: string; tries?: number }[] = []
      for (const item of batch) {
        const thumbPath = batchMap.get(item.filePath)!
        const inLibrary = patchLibraryThumbRef.current(item.filePath, thumbPath)
        if (inLibrary) { patched = true; continue }
        const f = index.get(item.filePath)
        if (!f) {
          const tries = (item.tries ?? 0) + 1
          if (tries <= 10) unmatched.push({ filePath: item.filePath, thumbPath, tries })
          continue
        }
        if (f.thumb !== thumbPath) { f.thumb = thumbPath; patched = true }
      }
      if (unmatched.length > 0) thumbQueueRef.current.unshift(...unmatched.slice(0, 2000))
      if (patched) setThumbVersion(v => v + 1)

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
      // One source for both the badge and the Favourites view.
      //
      // The badge used to count favourite_paths (every drive, including
      // trashed items) while the view filtered the OPEN drive's loaded rows -
      // so a favourite on an unplugged drive was counted but never listed,
      // which is the 4-vs-3 discrepancy. getFavourites() in the main process
      // already returns exactly the right set: favourited, not trashed, not
      // hidden, across all drives.
      const records = (files as ScannedFile[]) || []
      setFavRecords(records)
      setFavourites(new Set(records.map((f) => f.path)))
    })
    // Ask for the authoritative list once on mount, then again whenever a
    // favourite is toggled, so the badge and the view never drift.
    const loadFavs = (): void => window.api.getFavourites()
    loadFavs()
    const unsubFavToggle = window.api.onFavouriteToggled
      ? window.api.onFavouriteToggled(() => loadFavs())
      : () => {}
    const unsubProgress = window.api.onScanProgress((d) => setScanCount(d.count))
    const unsubComplete = window.api.onScanComplete((d) => {
      // A scan of some other drive finishing must not take over the view.
      if (d.drive !== currentDriveRef.current) return
      setScanning(false); setScanCount(d.count)
      window.api.getFiles(d.drive)
    })
    const unsubFiles = window.api.onFilesUpdated(({ drive, groups, reason }) => {
      // Payloads are now tagged with the drive they describe. Previously
      // whichever payload arrived last was filed under whatever drive was on
      // screen, so a background sync of another volume replaced the open
      // gallery with a different drive's files.
      if (!drive || drive !== currentDriveRef.current) return

      const next = groups as Record<string, ScannedFile[]>
      if (reason === 'background' && hasFilesRef.current) {
        // Something changed underneath a gallery the user is already reading.
        // Applying it here would re-sort and re-anchor the grid mid-scroll, so
        // it is held until they ask for it.
        pendingFilesRef.current = { drive, groups: next }
        setUpdatesPending(true)
        return
      }
      pendingFilesRef.current = null
      setUpdatesPending(false)
      setDriveFiles({ [drive]: next })
      setLibraryState('ready')
      refreshTrash()
    })
    const unsubThumb = window.api.onThumbReady((d) => {
      thumbQueueRef.current.push(d)
    })
    const unsubElevation = window.api.onElevationStatus
      ? window.api.onElevationStatus((status) => {
          if (!status.isElevated) {
            setToastMsg(`MFT Notice: ${status.message}`)
          }
        })
      : () => {}
    // Diagnostic mode: the main process has indexed one small sample folder
    // and nothing else. Open it directly - no drive click, no scan request.
    const unsubSample = window.api.onSafeModeSample
      ? window.api.onSafeModeSample(({ drive, folder, count }) => {
          console.log(`[safe-mode] sample folder ${folder} (${count} files)`)
          currentDriveRef.current = drive
          setSelectedDrive(drive)
          setSafeModeSample({ folder, count })
          setScanning(false)
          setActiveNav('all')
          setActiveView('Grid')
          setHoverPreviewsEnabled(false)
          window.api.getFiles(drive)
        })
      : () => {}

    const unsubOpened = window.api.onDriveOpened
      ? window.api.onDriveOpened((d) => {
          if (d.drive !== currentDriveRef.current) return
          setDriveOpened(d)
          setScanning(false)
          // A cached open is complete the moment the records land. If there are
          // none, that is a real answer, not a loading state.
          if (d.indexed === 0) setLibraryState('ready')
        })
      : () => {}

    const unsubToggled = window.api.onFavouriteToggled((d) => {
      setFavourites(prev => {
        const next = new Set(prev)
        if (d.isFav) next.add(d.filePath); else next.delete(d.filePath)
        return next
      })
    })

    window.api.getTileSize()
      .then((size) => {
        if (size && size >= 30) {
          setTileSize(size)
        }
      })
      .catch((err) => console.error('Error loading tile size preference:', err))

    window.api.getViewOrder()
      .then((order) => setViewOrder(order === 'reverse' ? 'reverse' : 'default'))
      .catch((err) => console.error('Error loading view order preference:', err))

    window.api.getHoverPreviews()
      .then((enabled) => setHoverPreviewsEnabled(enabled !== false))
      .catch((err) => console.error('Error loading hover previews preference:', err))

    window.api.getRuntimeMode?.()
      .then(setRuntimeMode)
      .catch(() => setRuntimeMode(null))

    window.api.getDrives()
    window.api.getFavourites()
    refreshTrash()

    return () => {
      unsubDrives()
      unsubFavs()
      unsubFavToggle()
      unsubProgress()
      unsubComplete()
      unsubFiles()
      unsubThumb()
      unsubElevation()
      unsubToggled()
      unsubSample()
      unsubOpened()
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
    setSelected(new Set())
    // Switching drives discards anything parked for the previous one.
    pendingFilesRef.current = null
    setUpdatesPending(false)
    hasFilesRef.current = false
    setLibraryState('loading')

    setDriveOpened(null)
    // Cached-only. Opening a drive no longer reconciles it: that used to stat
    // every indexed file before the user had even decided to stay. Use the
    // "Check for changes" action to reconcile.
    window.api.openDrive(name)
  }

  const handleReconcile = useCallback((): void => {
    if (!selectedDrive) return
    setScanning(true)
    setScanCount(0)
    window.api.reconcileDrive(selectedDrive)
  }, [selectedDrive])

  const handleSettingsTileSizeChange = (percent: number) => {
    const newSize = Math.max(55, Math.round((percent / 100) * 120))
    setTileSize(newSize)
    window.api.setTileSize(newSize).catch((err) => console.error(err))
  }

  const handleViewOrderChange = (order: 'default' | 'reverse') => {
    setViewOrder(order)
    setScrollToTopNonce((n) => n + 1)
    window.api.setViewOrder(order).catch((err) => console.error(err))
  }

  const handleHoverPreviewsChange = (enabled: boolean) => {
    setHoverPreviewsEnabled(enabled)
    window.api.setHoverPreviews(enabled).catch((err) => console.error(err))
  }

  const _handleRescan = useCallback((name: string): void => {
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

  // The library is read through SQLite. The renderer keeps the group summary
  // and a bounded window of pages - never the whole index.
  const libraryQuery = useMemo<LibraryQuery | null>(
    () =>
      selectedDrive
        ? { drive: selectedDrive, nav: galleryNav, search: searchQuery, groupBy, order: viewOrder }
        : null,
    [selectedDrive, galleryNav, searchQuery, groupBy, viewOrder]
  )
  const library = useLibrary(libraryQuery)

  // A relink rewrites where thousands of rows point, so the library is re-read
  // and any remembered failure for those paths is dropped rather than left to
  // keep showing the old state.
  const handleFoldersRelinked = useCallback((): void => {
    library.reload()
    setThumbVersion((n) => n + 1)
  }, [library])

  useEffect(() => {
    return window.api.onFolderRelinked(() => {
      library.reload()
      setThumbVersion((n) => n + 1)
    })
  }, [library])

  // Each Years card shows four thumbnails. Those rows are almost never in the
  // page cache, because the cache follows the grid's viewport, so the cards
  // fell back to grey camera placeholders and nothing ever filled them in -
  // a screen of empty blocks that looked like a broken gallery.
  //
  // This reads a dozen rows per year directly, outside the page cache, so the
  // whole view costs about twenty small LIMIT queries however large the
  // library is. The grid's bounded cache is untouched.
  const [yearPreviews, setYearPreviews] = useState<Record<string, ScannedFile[]>>({})
  useEffect(() => {
    if (activeView !== 'Years' || !libraryQuery || library.groups.length === 0) return
    const totals: Record<string, { offset: number }> = {}
    for (const g of library.groups) {
      const y = (g.maxDate || g.key).slice(0, 4) || 'Unknown'
      if (!totals[y]) totals[y] = { offset: g.offset }
    }
    let cancelled = false
    const q = libraryQuery
    void (async () => {
      const next: Record<string, ScannedFile[]> = {}
      for (const [year, info] of Object.entries(totals)) {
        if (cancelled) return
        try {
          const res = await window.api.libraryPage(q, info.offset, 12)
          const rows = (res.rows as ScannedFile[]).filter((r) => r.thumb).slice(0, 4)
          if (rows.length) next[year] = rows
        } catch {
          // Leave that one card on its placeholder rather than failing the view.
        }
      }
      if (!cancelled) setYearPreviews(next)
    })()
    return () => {
      cancelled = true
    }
  }, [activeView, libraryQuery, library.groups])
  libraryRef.current = library
  // Settings is its own page: grouping, sorting, the view tabs, gallery
  // search, Index Folder, the date ruler, the action circle and the
  // gallery footer all belong to the library, not to it.
  const isGalleryPage = activeNav !== 'settings' && activeNav !== 'map'
  const formatGroupKey = useMemo(() => makeGroupFormatter(groupBy), [groupBy])
  patchLibraryThumbRef.current = library.patchThumb


  const groupedFiles = useMemo<Record<string, ScannedFile[]>>(
    () => (selectedDrive && driveFiles[selectedDrive]) || {},
    [selectedDrive, driveFiles]
  )
  const allFiles = useMemo(() => Object.values(groupedFiles).flat(), [groupedFiles])
  useEffect(() => {
    fileIndexRef.current = new Map(allFiles.map(f => [f.path, f]))
    hasFilesRef.current = allFiles.length > 0
  }, [allFiles])

  const applyPendingUpdates = useCallback((): void => {
    const pending = pendingFilesRef.current
    pendingFilesRef.current = null
    setUpdatesPending(false)
    if (!pending || pending.drive !== currentDriveRef.current) return
    setDriveFiles({ [pending.drive]: pending.groups })
    refreshTrash()
  }, [refreshTrash])
  const allFavFiles = useMemo(() => allFiles.filter(f => favourites.has(f.path)), [allFiles, favourites])
  const totalFiles = library.total

  // Stable reference so MagneticDock (not memoized against unrelated App
  // re-renders otherwise) only actually re-renders when one of these changes,
  // not on every drive-poll/thumbnail-batch tick.
  // favourites holds every favourited path across all drives; allFavFiles is
  // only the ones resident for the drive in view. Counting the latter made the
  // badge read "1" while four files were favourited, because the other three
  // were on a drive that was not open.
  // Same list the Favourites view renders, so the badge cannot disagree.
  const favCount = favRecords.length
  // Favourites whose drive is not currently connected. They are kept and
  // counted - never deleted to make a number match - but called out so the
  // list does not look as though items are missing.
  const connectedLetters = useMemo(
    () => new Set(drives.map((d) => (d.name || '').slice(0, 2).toUpperCase())),
    [drives]
  )
  const offlineFavCount = favRecords.filter(
    (f) => f.drive && !connectedLetters.has(f.drive.slice(0, 2).toUpperCase())
  ).length
  const dockItems = useMemo(
    () => [
      { id: 'all', label: 'All files', icon: <FolderArchive size={18} />, isActive: activeNav === 'all', onClick: () => setActiveNav('all') },
      { id: 'photos', label: 'Photos', icon: <ImageIcon size={18} />, isActive: activeNav === 'photos', onClick: () => setActiveNav('photos') },
      { id: 'videos', label: 'Videos', icon: <Film size={18} />, isActive: activeNav === 'videos', onClick: () => setActiveNav('videos') },
      { id: 'map', label: 'Map', icon: <MapIcon size={18} />, isActive: activeNav === 'map', onClick: () => setActiveNav('map') },
      { id: 'favourites', label: 'Favourites', icon: <Star size={18} />, isActive: activeNav === 'favourites', badge: favCount, onClick: () => setActiveNav('favourites') },
      { id: 'trash', label: 'Trash', icon: <Trash2 size={18} />, isActive: activeNav === 'trash', badge: trashCount, onClick: () => setActiveNav('trash') },
      { id: 'settings', label: 'Settings', icon: <Settings size={18} />, isActive: activeNav === 'settings', onClick: () => setActiveNav('settings') }
    ],
    [activeNav, favCount, trashCount]
  )

  const handleGridTileSizeCommit = useCallback((size: number): void => {
    setTileSize(size)
    window.api.setTileSize(size).catch((err) => console.error(err))
  }, [])

  const switchView = useCallback((view: string): void => {
    setTransitioning(true)
    zoomTicksRef.current = 0
    setTimeout(() => { setActiveView(view); setTransitioning(false) }, 280)
  }, [])

  // Zooming past either end of the tile-size range steps the grouping instead
  // of switching view: day -> month -> year on the way out, and back on the way
  // in. The zoom animation itself is untouched; this only reacts to the
  // boundary callbacks the grid already emitted.
  const GROUP_LADDER = ['day', 'month', 'year'] as const
  const groupZoomLockRef = useRef(0)

  const stepGrouping = useCallback(
    (direction: 'coarser' | 'finer'): void => {
      // Near a threshold a gesture can fire twice; a short lock stops the
      // grouping flickering between two levels.
      const now = performance.now()
      if (now - groupZoomLockRef.current < 450) return

      const idx = GROUP_LADDER.indexOf(groupBy as (typeof GROUP_LADDER)[number])
      if (idx === -1) return // a non-date grouping (location/favorites) is left alone
      const nextIdx = direction === 'coarser' ? idx + 1 : idx - 1
      if (nextIdx < 0 || nextIdx >= GROUP_LADDER.length) return
      groupZoomLockRef.current = now

      // Keep the date the user is looking at anchored across the change. Group
      // keys are date slices, so the containing group in the next level is a
      // prefix of the current key (or vice versa).
      const anchor = visibleKeyRef.current
      setGroupBy(GROUP_LADDER[nextIdx])
      if (anchor) pendingGroupAnchorRef.current = anchor
    },
    [groupBy]
  )

  const handleGridZoomOutBeyond = useCallback((): void => stepGrouping('coarser'), [stepGrouping])
  const handleGridZoomInBeyond = useCallback((): void => stepGrouping('finer'), [stepGrouping])

  // Ctrl+wheel / pinch on the Timeline and Years views (the Grid handles its own zoom).
  // Grid ⇄ Timeline ⇄ Years, like All Photos ⇄ Months ⇄ Years.
  const handleWheel = useCallback((e: React.WheelEvent): void => {
    if (!e.ctrlKey || transitioning) return
    if (activeView !== 'Timeline' && activeView !== 'Years') return

    const dir: 'in' | 'out' = e.deltaY > 0 ? 'out' : 'in'
    if (dir !== lastZoomDirRef.current) { zoomTicksRef.current = 0; lastZoomDirRef.current = dir }
    // Trackpads fire many small events; count accumulated distance instead of raw events.
    zoomTicksRef.current += Math.min(1, Math.abs(e.deltaY) / 40)
    if (zoomTicksRef.current < 2) return

    if (activeView === 'Timeline') switchView(dir === 'in' ? 'Grid' : 'Years')
    else if (dir === 'in') switchView('Timeline')
    else zoomTicksRef.current = 0
  }, [activeView, transitioning, switchView])

  // Grouping the library is O(n log n) over every file on the drive, and it used
  // to re-run whenever `favourites` changed - so hearting a single photo
  // re-filtered, re-grouped and re-sorted all 40k of them before the heart even
  // filled in. Favourites only actually affect the result in the few modes
  // below, so the set is read through a ref and only those modes take it as a
  // dependency.
  const favouritesRef = useRef(favourites)
  favouritesRef.current = favourites
  const favouritesAffectGrouping =
    activeNav === 'favourites' ||
    groupBy === 'favorites' ||
    ['is:fav', 'fav:true'].includes(searchQuery.trim().toLowerCase())
  const favouritesDep = favouritesAffectGrouping ? favourites : null

  const getFiltered = useCallback((files: ScannedFile[]): ScannedFile[] => {
    const favourites = favouritesRef.current
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNav, favouritesDep, searchQuery])

  const orderedGroupsRef = useRef<{ keys: string[]; data: Record<string, ScannedFile[]> }>({ keys: [], data: {} })
  const handleSelect = useCallback((file: ScannedFile, e: React.MouseEvent): void => {
    setSelected(prev => {
      const next = new Set(prev)
      const isSelected = next.has(file.path)

      if (e.shiftKey && lastSelectedPathRef.current) {
        const { keys, data } = orderedGroupsRef.current
        const allGridFiles = keys.flatMap(k => data[k] || [])
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
  }, [])

  const lastSelectedPathRef = useRef<string | null>(null)

  const handleTileOpen = useCallback((file: ScannedFile, indexOrList: number | ScannedFile[], e?: React.MouseEvent): void => {
    const rect = e?.currentTarget?.getBoundingClientRect()
    if (typeof indexOrList === 'number') {
      setLightbox({ file, index: indexOrList, rect })
    } else {
      const i = indexOrList.indexOf(file)
      setLightbox({ file, index: i < 0 ? 0 : i, rect, list: indexOrList })
    }
  }, [])

  /**
   * Step to the next/previous file in the ACTIVE query order.
   *
   * The grid used to hand the viewer a one-element array, so prev/next had
   * nowhere to go at all. Navigating by library index instead follows the
   * current filter and sort, and crosses a database page boundary by asking
   * for the page and waiting briefly for it rather than stopping at the edge
   * of what is resident.
   */
  const navigateLightbox = useCallback(async (delta: number): Promise<void> => {
    const lb = lightboxRef.current
    const lib = libraryRef.current
    if (!lb) return
    // A view with its own array (favourites, trash) navigates that array.
    if (lb.list) {
      const next = lb.index + delta
      if (next < 0 || next >= lb.list.length) return
      setLightbox({ file: lb.list[next], index: next, list: lb.list })
      return
    }
    if (!lib) return
    const next = lb.index + delta
    if (next < 0 || next >= lib.total) return
    let row = lib.getRow(next)
    if (!row) {
      lib.ensureRange(next, next)
      for (let i = 0; i < 24 && !row; i++) {
        await new Promise((r) => setTimeout(r, 50))
        row = libraryRef.current?.getRow(next)
      }
    }
    if (row) setLightbox({ file: row, index: next })
  }, [])

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
  const sortedGroupedData = useMemo(() => {
    const filtered = getFiltered(allFiles)
    const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    const dayKeyCache = new Map<number, string>()
    const time = (f: ScannedFile): number => {
      const t = Date.parse(f.date)
      return Number.isNaN(t) ? -Infinity : t
    }

    const groups: Record<string, ScannedFile[]> = {}
    const newest: Record<string, number> = {}
    for (const file of filtered) {
      let key: string
      const t = time(file)
      if (groupBy === 'day') {
        if (t === -Infinity) key = 'Unknown Date'
        else {
          const d = new Date(t)
          const day = d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate()
          key = dayKeyCache.get(day) ?? ''
          if (!key) { key = dayFmt.format(t); dayKeyCache.set(day, key) }
        }
      } else if (groupBy === 'month') {
        key = `${file.month || 'Unknown'} ${file.year || ''}`.trim()
      } else if (groupBy === 'year') {
        key = file.year || 'Unknown Year'
      } else if (groupBy === 'location') {
        key = file.lat != null && file.lng != null
          ? `📍 Coords (${Math.round(file.lat * 2) / 2}, ${Math.round(file.lng * 2) / 2})`
          : 'No Location Info'
      } else {
        key = favouritesRef.current.has(file.path) ? '❤️ Favourites' : 'Other Files'
      }
      const g = groups[key]
      if (g) g.push(file); else groups[key] = [file]
      if (!(key in newest) || t > newest[key]) newest[key] = t
    }

    // Newest first, inside and across groups; undated groups go last.
    for (const key in groups) {
      if (groups[key].length > 1) groups[key].sort((a, b) => time(b) - time(a) || a.name.localeCompare(b.name))
    }
    const keys = Object.keys(groups).sort((a, b) => {
      const d = newest[b] - newest[a]
      return Number.isNaN(d) ? 0 : d || a.localeCompare(b)
    })

    // Reverse (both group order and items within each group) rather than
    // re-deriving a separate comparator - the tie-break above is already
    // deterministic, so reversing it stays deterministic.
    if (viewOrder === 'reverse') {
      keys.reverse()
      for (const key in groups) groups[key].reverse()
    }

    return { keys, data: groups }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allFiles, groupBy, favouritesDep, getFiltered, viewOrder])
  orderedGroupsRef.current = sortedGroupedData

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
  const _handleDragOverDrive = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const _handleDragEnterDrive = useCallback((driveName: string, e: React.DragEvent) => {
    e.preventDefault()
    _setDragOverDrive(driveName)
  }, [])

  const _handleDragLeaveDrive = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    _setDragOverDrive(null)
  }, [])

  const _handleDropDrive = useCallback(async (driveName: string, e: React.DragEvent) => {
    e.preventDefault()
    _setDragOverDrive(null)
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

  void [_handleRescan, _handleDragOverDrive, _handleDragEnterDrive, _handleDragLeaveDrive, _handleDropDrive]

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
    <div style={{ display: 'flex', width: '100vw', height: '100vh', background: 'var(--app-bg, #0a0a0c)', color: 'var(--app-fg, #f2f2f0)', fontFamily: 'system-ui, sans-serif', fontSize: '13px', overflow: 'hidden', position: 'fixed', inset: 0 }}>
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
        ::-webkit-scrollbar-track { background: var(--app-bg, #0a0a0c); }
        ::-webkit-scrollbar-thumb { background: #1c1c22; border-radius: 0px; }
        ::-webkit-scrollbar-thumb:hover { background: #e11d2e; }
      `}</style>

      {/* Sidebar - only rendered after a drive is selected, and when not collapsed */}
      {selectedDrive && !sidebarCollapsed && (
        <div style={{ width: '230px', minWidth: '230px', background: '#0c0c0f', borderRight: '1px solid rgba(255,255,255,0.04)', display: 'flex', flexDirection: 'column', height: '100vh', overflowY: 'auto' }}>
          <div style={{ padding: '20px 22px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: '#ffffff', letterSpacing: '1px', textTransform: 'uppercase' }}>DiskFrame</div>
            <div style={{ fontSize: '9px', color: 'var(--app-fg-dim, #8a8a8f)', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Universal media indexing</div>
          </div>

          {/* Collections */}
          <div style={{ padding: '4px 0' }}>
            <div style={{ fontSize: '9px', color: 'var(--app-fg-dim, #8a8a8f)', textTransform: 'uppercase', letterSpacing: '1px', padding: '0 22px', marginBottom: '8px', fontWeight: 700 }}>Collections</div>
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
                <span style={{ display: 'flex', alignItems: 'center', marginRight: '12px', color: activeNav === item.id ? '#e11d2e' : 'var(--app-fg-dim, #8a8a8f)' }}>{item.icon}</span>
                <span style={{ flex: 1, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{item.label}</span>
                {item.id === 'favourites' && allFavFiles.length > 0 && (
                  <span style={{ fontSize: '9px', color: 'var(--app-fg, #f2f2f0)', background: 'rgba(225, 29, 46, 0.25)', borderRadius: '2px', padding: '2px 5px', fontWeight: 700 }}>{allFavFiles.length}</span>
                )}
                {item.id === 'trash' && trashCount > 0 && (
                  <span style={{ fontSize: '9px', color: 'var(--app-fg, #f2f2f0)', background: '#e11d2e', borderRadius: '2px', padding: '2px 5px', fontWeight: 700 }}>{trashCount}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main Container */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', minWidth: 0, background: 'var(--app-bg, #0a0a0c)' }}>
        
        {/* Top bar header - only rendered after a drive is selected */}
        {selectedDrive && (
          <div className="df-glass df-glass-strong" style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '12px 18px', flexShrink: 0, borderRadius: 0, borderLeft: 'none', borderRight: 'none', borderTop: 'none', flexWrap: 'wrap', rowGap: '8px' }}>
            
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '12px' }}>
              <button
                onClick={() => setSidebarCollapsed(v => !v)}
                title={sidebarCollapsed ? 'Show side panel' : 'Hide side panel'}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '26px', height: '26px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '4px', cursor: 'pointer', color: 'var(--app-fg-dim, #8a8a8f)' }}
              >
                {sidebarCollapsed ? <PanelLeft size={13} /> : <PanelLeftClose size={13} />}
              </button>
              {selectedDrive ? (
                <div
                  onClick={() => {
                    setSelectedDrive(null)
                    setActiveNav('all')
                  }}
                  title="Return to Drive Selection screen"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    cursor: 'pointer',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.06)',
                    fontSize: '10px',
                    color: 'var(--app-fg-dim, #8a8a8f)',
                    textTransform: 'uppercase',
                    letterSpacing: '1px',
                    fontWeight: 700,
                    transition: 'all 0.15s cubic-bezier(0.34, 1.56, 0.64, 1)',
                    userSelect: 'none'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(225, 29, 46, 0.12)'
                    e.currentTarget.style.borderColor = 'rgba(225, 29, 46, 0.4)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.03)'
                    e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.06)'
                  }}
                >
                  <ArrowLeft size={12} color="#e11d2e" />
                  <span>
                    <span style={{ color: '#ffffff' }}>{selectedDrive}</span> · <span style={{ color: '#e11d2e' }}>{activeNav}</span>
                  </span>
                </div>
              ) : (
                <div style={{ fontSize: '10px', color: 'var(--app-fg-dim, #8a8a8f)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 700 }}>
                  Select a drive
                </div>
              )}
              
              {/* Search Input */}
              {selectedDrive && isGalleryPage && (
                <input
                  type="text"
                  placeholder="Search file, camera:, date:, ext:, loc: ..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="cred-input"
                  style={{ width: '260px', padding: '4px 10px', fontSize: '11px', height: '24px', border: '1px solid rgba(225,29,46,0.1)' }}
                />
              )}
              {/* Bounded: indexes exactly the chosen folder, nothing drive-wide. */}
              {selectedDrive && isGalleryPage && (
                <button
                  onClick={handleIndexFolder}
                  disabled={indexingFolder}
                  className="cred-input"
                  style={{ padding: '4px 10px', fontSize: '10px', height: '24px', cursor: indexingFolder ? 'default' : 'pointer', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700, background: 'var(--app-surface, var(--app-surface, #111113))', border: '1px solid rgba(225,29,46,0.35)', color: indexingFolder ? 'var(--app-fg-dim, #8a8a8f)' : '#e11d2e' }}
                  title="Index one folder into the library (bounded, no drive-wide scan)"
                >
                  {indexingFolder ? 'Indexing...' : '+ Index folder'}
                </button>
              )}
              {indexingFolder && (
                <button
                  onClick={() => void window.api.cancelIndexFolder()}
                  className="cred-input"
                  style={{ padding: '4px 10px', fontSize: '10px', height: '24px', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700, background: 'var(--app-surface, var(--app-surface, #111113))', border: '1px solid rgba(255,255,255,0.15)', color: 'var(--app-fg-dim, #8a8a8f)' }}
                  title="Stop indexing and keep whatever has been found so far"
                >
                  Cancel
                </button>
              )}
            </div>

            {selected.size > 0 && activeNav !== 'trash' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', color: 'var(--app-fg, #f2f2f0)', background: 'rgba(225,29,46,0.08)', border: '1px solid rgba(225,29,46,0.35)', borderRadius: '2px', padding: '3px 10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                <span>{selected.size} selected</span>
                <button onClick={handleBatchFavorite} style={{ background: 'transparent', border: 'none', color: '#e11d2e', cursor: 'pointer', fontWeight: 700, textTransform: 'uppercase' }}>❤️ Fav</button>
                <button onClick={handleBatchDelete} style={{ background: 'transparent', border: 'none', color: '#e11d2e', cursor: 'pointer', fontWeight: 700, textTransform: 'uppercase' }}>🗑️ Delete</button>
                <span onClick={() => setSelected(new Set())} style={{ cursor: 'pointer', color: 'var(--app-fg-dim, #8a8a8f)', marginLeft: '2px' }}>✕</span>
              </div>
            )}

            {/* Group By selector */}
            {selectedDrive && isGalleryPage && (activeView === 'Grid' || activeView === 'Timeline') && activeNav !== 'trash' && (
              <GlassSelect
                label="Grouping"
                value={groupBy}
                onChange={(v) => { setGroupBy(v as never); setScrollToTopNonce((n) => n + 1) }}
                options={[
                  { value: 'day', label: 'Group by Day' },
                  { value: 'month', label: 'Group by Month' },
                  { value: 'year', label: 'Group by Year' },
                  { value: 'location', label: 'Group by Location' },
                  { value: 'favorites', label: 'Group by Favorites' }
                ]}
              />
            )}

            {isGalleryPage && (activeView === 'Grid' || activeView === 'Timeline' || activeView === 'Years') && activeNav !== 'trash' && <div style={{ fontSize: '9px', color: 'var(--app-fg-dim, #8a8a8f)', textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>{activeView === 'Grid' ? 'Pinch to zoom' : 'Pinch to switch views'}</div>}

            {/* View order */}
            {selectedDrive && isGalleryPage && (activeView === 'Grid' || activeView === 'Timeline') && activeNav !== 'trash' && (
              <GlassSelect
                label="View order"
                value={viewOrder}
                onChange={(v) => handleViewOrderChange(v as 'default' | 'reverse')}
                options={[
                  { value: 'default', label: 'Top to bottom' },
                  { value: 'reverse', label: 'Bottom to top' }
                ]}
              />
            )}

            {/* Views selector tab */}
            {isGalleryPage && activeNav !== 'trash' && (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: '2px', background: 'var(--app-surface, var(--app-surface, #111113))', borderRadius: '4px', padding: '2px', border: '1px solid rgba(255,255,255,0.04)' }}>
                  {['Grid', 'Timeline', 'Years'].map(v => (
                    <div key={v} onClick={() => setActiveView(v)} style={{ padding: '3px 10px', borderRadius: '3px', cursor: 'pointer', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', background: activeView === v ? '#1e1e24' : 'transparent', color: activeView === v ? '#ffffff' : 'var(--app-fg-dim, #8a8a8f)', transition: 'all 0.15s ease' }}>{v}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Isolated Scroll Content Area */}
        <MainContentArea
          favRecords={favRecords}
          activeNav={activeNav}
          activeView={activeView}
          scanning={scanning}
          scanCount={scanCount}
          selectedDrive={selectedDrive}
          drives={drives}
          handleDriveClick={handleDriveClick}
          driveFiles={driveFiles}
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
          libraryGroups={library.groups}
          getRow={library.getRow}
          pageVersion={library.pageVersion}
          ensureRange={library.ensureRange}
          yearPreviews={yearPreviews}
          libraryQuery={libraryQuery}
          onFoldersRelinked={handleFoldersRelinked}
          formatGroupKey={formatGroupKey}
          handleWheel={handleWheel}
          handleGroupCheckboxClick={handleGroupCheckboxClick}
          groupBy={groupBy}
          onDragStart={handleDragStart}
          setActiveView={setActiveView}
          onTileSizeCommit={handleGridTileSizeCommit}
          scrollToTopNonce={scrollToTopNonce}
          onGridZoomOutBeyond={handleGridZoomOutBeyond}
          onGridZoomInBeyond={handleGridZoomInBeyond}
          visibleKeyRefProp={visibleKeyRef}
          pendingGroupAnchorRef={pendingGroupAnchorRef}
          thumbVersion={thumbVersion}
          hoverPreviewsEnabled={hoverPreviewsEnabled}
          onHoverPreviewsChange={handleHoverPreviewsChange}
          libraryState={libraryState}
          runtimeMode={runtimeMode}
          driveOpened={driveOpened}
          onReconcile={handleReconcile}
        />

        {/* Status bar - only rendered after a drive is selected */}
        {selectedDrive && (
          <div className="df-glass" style={{ padding: '7px 18px', display: 'flex', alignItems: 'center', gap: '14px', flexShrink: 0, flexWrap: 'wrap', rowGap: '6px', borderRadius: 0, borderLeft: 'none', borderRight: 'none', borderBottom: 'none' }}>
            <div style={{ fontSize: '9px', color: 'var(--app-fg-dim, #8a8a8f)', textTransform: 'uppercase', letterSpacing: '0.5px' }}><span style={{ color: 'var(--app-fg, #f2f2f0)', fontWeight: 700 }}>{drives.length}</span> drives</div>
            {/* While the library is still arriving these counts are unknown, not
                zero. Printing 0 made a loading gallery indistinguishable from an
                empty one - and from a diagnostic database with nothing in it. */}
            <div style={{ fontSize: '9px', color: 'var(--app-fg-dim, #8a8a8f)', textTransform: 'uppercase', letterSpacing: '0.5px' }}><span style={{ color: 'var(--app-fg, #f2f2f0)', fontWeight: 700 }}>{libraryState === 'ready' ? totalFiles.toLocaleString() : '—'}</span> files</div>
            {isGalleryPage && (
            <div style={{ fontSize: '9px', color: 'var(--app-fg-dim, #8a8a8f)', textTransform: 'uppercase', letterSpacing: '0.5px' }}><span style={{ color: 'var(--app-fg, #f2f2f0)', fontWeight: 700 }}>{libraryState === 'ready' ? sortedGroupedData.keys.length : '—'}</span> groupings</div>
            )}
            <div style={{ fontSize: '9px', color: 'var(--app-fg-dim, #8a8a8f)', textTransform: 'uppercase', letterSpacing: '0.5px' }}><span style={{ color: '#e11d2e', fontWeight: 700 }}><Heart size={8} fill="#e11d2e" style={{ display: 'inline', verticalAlign: 'middle', marginRight: '3px' }} /> {libraryState === 'ready' ? favCount : '—'}</span> favourites{offlineFavCount > 0 && (
                <span title="Favourites on a drive that is not connected. They are kept and counted, not deleted."> ({offlineFavCount} offline)</span>
              )}</div>
            {selected.size > 0 && <div style={{ fontSize: '9px', color: '#e11d2e', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}><Check size={8} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '3px' }} /> {selected.size} selected</div>}
            {isGalleryPage && activeView === 'Grid' && <div style={{ fontSize: '9px', color: 'var(--app-fg-dim, #8a8a8f)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>tile: <span style={{ color: 'var(--app-fg, #f2f2f0)', fontWeight: 700 }}>{tileSize}px</span></div>}
            {/* Driven by a queried flag, not a one-shot event, so a diagnostic
                session is always labelled even if the sample never loaded or
                the user navigated to a real drive. */}
            {runtimeMode?.safeMode && (
              <div
                title={`Diagnostic mode. Isolated data at ${runtimeMode.userDataPath}. Your real library is not loaded here.`}
                style={{
                  fontSize: '9px',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  color: 'var(--app-bg, #0a0a0c)',
                  background: '#f5c542',
                  borderRadius: '2px',
                  padding: '3px 10px',
                  whiteSpace: 'nowrap'
                }}
              >
                Diagnostic mode — isolated data
              </div>
            )}
            {!runtimeMode?.safeMode && runtimeMode && !runtimeMode.isDefaultUserData && (
              <div
                title={`Using a non-default data directory: ${runtimeMode.userDataPath}`}
                style={{
                  fontSize: '9px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px',
                  color: 'var(--app-bg, #0a0a0c)', background: '#f5c542', borderRadius: '2px', padding: '3px 10px', whiteSpace: 'nowrap'
                }}
              >
                Alternate data directory
              </div>
            )}
            {/* Reconciliation is a deliberate action now. Opening a drive only
                reads the cached index. */}
            {selectedDrive && !scanning && isGalleryPage && (
              <button
                onClick={handleReconcile}
                title={`Re-check ${selectedDrive} for new, changed or removed files. This reads the drive and may take a while on a large library.`}
                style={{
                  display: 'flex', alignItems: 'center', gap: '6px',
                  fontSize: '9px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px',
                  color: 'var(--app-fg-dim, #8a8a8f)', background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.08)', borderRadius: '2px',
                  padding: '3px 10px', cursor: 'pointer', whiteSpace: 'nowrap'
                }}
              >
                <RotateCcw size={10} /> Check for changes
              </button>
            )}
            {safeModeSample && (
              <div
                title={safeModeSample.folder}
                style={{
                  fontSize: '9px',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  color: 'var(--app-bg, #0a0a0c)',
                  background: '#f5c542',
                  borderRadius: '2px',
                  padding: '3px 10px',
                  whiteSpace: 'nowrap'
                }}
              >
                Diagnostic mode — sample folder, {safeModeSample.count} files
              </div>
            )}
            {updatesPending && (
              <button
                onClick={applyPendingUpdates}
                title="New or changed files were found. Click to apply them."
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '9px',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  color: 'var(--app-fg, #f2f2f0)',
                  background: 'rgba(225,29,46,0.12)',
                  border: '1px solid rgba(225,29,46,0.45)',
                  borderRadius: '2px',
                  padding: '3px 10px',
                  cursor: 'pointer'
                }}
              >
                <RotateCcw size={10} color="#e11d2e" /> Updates available — Refresh
              </button>
            )}
            <div style={{ marginLeft: 'auto' }}>
              {scanning ? (
                <ScanProgressDisplay scanning={scanning} scanCount={scanCount} />
              ) : (
                <div style={{ fontSize: '8px', color: '#e11d2e', background: 'rgba(225, 29, 46, 0.08)', border: '1px solid rgba(225, 29, 46, 0.2)', borderRadius: '2px', padding: '1px 6px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>● index live</div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Magnetic glass navigation dock, floating above the status bar */}
      {selectedDrive && (
        <div className="gallery-chrome" style={{ position: 'fixed', bottom: '55px', left: '50%', transform: 'translateX(-50%)', zIndex: 1999 }}>
          <MagneticDock items={dockItems} />
        </div>
      )}

      {/* Floating AI search action button (offset bottom: 55px to float above status bar) */}
      {selectedDrive && isGalleryPage && (
        <button
          onClick={() => setShowAiOverlay(true)}
          className="gallery-chrome"
          style={{
            position: 'fixed',
            bottom: '55px',
            right: '24px',
            width: '56px',
            height: '56px',
            borderRadius: '50%',
            background: 'var(--app-bg, #0a0a0c)',
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
            <circle cx="12" cy="12" r="5" stroke="var(--app-fg, #f2f2f0)" strokeWidth="1.5" />
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
                  color: 'var(--app-fg-dim, #8a8a8f)',
                  fontSize: '18px',
                  cursor: 'pointer',
                  transition: 'transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1), color 0.15s',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0
                }}
                onMouseEnter={e => e.currentTarget.style.color = '#e11d2e'}
                onMouseLeave={e => e.currentTarget.style.color = 'var(--app-fg-dim, #8a8a8f)'}
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
          // Bounded neighbour window: the previous, current and next resident
          // rows. Enough for the viewer to preload one either side and to know
          // whether the arrows apply, without holding the whole library.
          list={
            lightbox.list
              ? lightbox.list
              : ([
                  library.getRow(lightbox.index - 1),
                  lightbox.file,
                  library.getRow(lightbox.index + 1)
                ].filter(Boolean) as ScannedFile[])
          }
          isFav={favourites.has(lightbox.file.path)}
          onFav={handleFav}
          onReveal={handleReveal}
          onClose={() => setLightbox(null)}
          onNext={() => void navigateLightbox(1)}
          onPrev={() => void navigateLightbox(-1)}
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
                <ImageIcon size={12} color="var(--app-fg-dim, #8a8a8f)" /> Open in Viewer
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
                <FolderOpen size={12} color="var(--app-fg-dim, #8a8a8f)" /> Show in Folder
              </div>
              <div
                onClick={() => navigator.clipboard.writeText(contextMenu.file.path)}
                style={{ padding: '8px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <Copy size={12} color="var(--app-fg-dim, #8a8a8f)" /> Copy Path
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
                <RotateCcw size={12} color="var(--app-fg-dim, #8a8a8f)" /> Restore File
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
        <div className="cred-glass" style={{ position: 'fixed', bottom: '80px', right: '24px', padding: '12px 20px', borderRadius: '4px', zIndex: 10000, display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--app-fg, #f2f2f0)', border: '1px solid #e11d2e', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1.5px', fontWeight: 700 }}>
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
            <div style={{ fontSize: '10px', color: 'var(--app-fg-dim, #8a8a8f)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textTransform: 'uppercase' }}>
              {ioProgress.currentFile}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', fontWeight: 700 }}>
              <span style={{ color: 'var(--app-fg-dim, #8a8a8f)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Progress:</span>
              <span style={{ color: 'var(--app-fg, #f2f2f0)' }}>{ioProgress.completed} / {ioProgress.total}</span>
            </div>
            <div style={{ width: '100%', height: '4px', background: 'var(--app-surface, var(--app-surface, #111114))', overflow: 'hidden' }}>
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
            <div style={{ fontSize: '11px', color: 'var(--app-fg-dim, #8a8a8f)', lineHeight: 1.5 }}>
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
            <div style={{ fontSize: '11px', color: 'var(--app-fg-dim, #8a8a8f)', lineHeight: 1.5 }}>
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
            <div style={{ fontSize: '11px', color: 'var(--app-fg-dim, #8a8a8f)', lineHeight: 1.5 }}>
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
                  color: 'var(--app-fg, #f2f2f0)',
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
            <div style={{ fontSize: '11px', color: 'var(--app-fg-dim, #8a8a8f)', lineHeight: 1.5 }}>
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
                  color: 'var(--app-fg, #f2f2f0)',
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