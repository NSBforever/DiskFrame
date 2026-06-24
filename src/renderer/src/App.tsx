import { useState, useEffect, useRef, useCallback } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

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

const photoExts = ['.jpg', '.jpeg', '.png', '.webp']
const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.wmv']
const docExts = ['.pdf', '.docx', '.doc', '.txt', '.xlsx', '.pptx', '.csv']

function toUrl(p: string): string {
  return 'media:///' + p.replace(/\\/g, '/')
}

function thumbUrl(file: ScannedFile): string {
  const src = file.thumb || file.path
  return 'media:///' + src.replace(/\\/g, '/')
}

function FileTile({
  file, onOpen, onFav, isFav, isSelected, onSelect, tileSize
}: {
  file: ScannedFile
  onOpen: (f: ScannedFile) => void
  onFav: (f: ScannedFile) => void
  isFav: boolean
  isSelected: boolean
  onSelect: (f: ScannedFile) => void
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
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        borderRadius: tileSize < 80 ? '8px' : '12px', aspectRatio: '1', cursor: 'pointer',
        overflow: 'hidden', background: '#141420', position: 'relative',
        border: `1px solid ${isSelected ? '#6c6cff' : hovered ? '#4a4a7a' : '#1e1e2a'}`,
        outline: isSelected ? '2px solid #6c6cff' : 'none', outlineOffset: '2px',
        transform: hovered ? 'scale(1.03) translateY(-3px)' : 'scale(1) translateY(0)',
        boxShadow: hovered ? '0 12px 24px rgba(108,108,255,0.15), 0 6px 12px rgba(0,0,0,0.4)' : '0 2px 8px rgba(0,0,0,0.1)',
        transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)', zIndex: hovered ? 2 : 1
      }}
    >
      {isPhoto && !error ? (
        <>
          {!loaded && (
            <div style={{ position: 'absolute', inset: 0, background: '#141420', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ width: '16px', height: '16px', border: '1.5px solid #2a2a3a', borderTop: '1.5px solid #6c6cff', borderRadius: '50%', animation: 'tileSpin 0.8s linear infinite' }} />
            </div>
          )}
          <img key={imgKey} src={thumbUrl(file)} loading="lazy" decoding="async"
            onLoad={() => setLoaded(true)} onError={() => { setError(true); setLoaded(true) }}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: loaded ? 'block' : 'none', transform: hovered ? 'scale(1.06)' : 'scale(1)', transition: 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)', willChange: 'transform' }}
          />
        </>
      ) : isVideo ? (
        <>
          {hasThumb && !error ? (
            <>
              {!loaded && (
                <div style={{ position: 'absolute', inset: 0, background: '#1a1020', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ width: '16px', height: '16px', border: '1.5px solid #2a2a3a', borderTop: '1.5px solid #a060ff', borderRadius: '50%', animation: 'tileSpin 0.8s linear infinite' }} />
                </div>
              )}
              <img key={imgKey} src={thumbUrl(file)} loading="lazy" decoding="async"
                onLoad={() => setLoaded(true)} onError={() => { setError(true); setLoaded(true) }}
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: loaded ? 'block' : 'none', transform: hovered ? 'scale(1.06)' : 'scale(1)', transition: 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)', willChange: 'transform' }}
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
          )}
        </>
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
      )
      }

      {
        tileSize >= 70 && (
          <div style={{
            position: 'absolute', bottom: 0, left: 0, right: 0, padding: '20px 6px 5px',
            background: 'linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.4) 50%, transparent 100%)',
            display: 'flex', alignItems: 'flex-end',
            opacity: hovered ? 1 : 0, transform: hovered ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)', pointerEvents: 'none'
          }}>
            <div style={{ fontSize: '9px', fontWeight: 500, color: '#e8e8f4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%' }}>{file.name}</div>
          </div>
        )
      }

      <div onClick={(e) => { e.stopPropagation(); onSelect(file) }}
        style={{ position: 'absolute', top: '4px', left: '4px', width: '16px', height: '16px', borderRadius: '4px', background: isSelected ? '#6c6cff' : 'rgba(0,0,0,0.6)', border: `1.5px solid ${isSelected ? '#6c6cff' : 'rgba(255,255,255,0.3)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '9px', cursor: 'pointer', color: '#fff', opacity: hovered || isSelected ? 1 : 0, transition: 'opacity 0.15s' }}
      >{isSelected ? '✓' : ''}</div>

      {
        tileSize >= 70 && (
          <div onClick={(e) => { e.stopPropagation(); onFav(file) }}
            style={{ position: 'absolute', top: '4px', right: '4px', width: '20px', height: '20px', borderRadius: '50%', background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', cursor: 'pointer', opacity: hovered || isFav ? 1 : 0, transition: 'opacity 0.15s' }}
          >{isFav ? '❤️' : '🤍'}</div>
        )
      }
    </div >
  )
}

// ─── PREMIUM LIGHTBOX ────────────────────────────────────────────────────────
function LightBox({
  file, onClose, onFav, isFav, onNext, onPrev, onReveal
}: {
  file: ScannedFile
  onClose: () => void
  onFav: (f: ScannedFile) => void
  isFav: boolean
  onNext: () => void
  onPrev: () => void
  onReveal: (f: ScannedFile) => void
}): React.JSX.Element {
  const isPhoto = photoExts.includes(file.ext.toLowerCase())
  const isVideo = videoExts.includes(file.ext.toLowerCase())
  const isPdf = file.ext === '.pdf'
  const [zoom, setZoom] = useState(1)
  const [imgError, setImgError] = useState(false)

  // Pinch-to-zoom state
  const pinchStartDistRef = useRef<number | null>(null)
  const pinchStartZoomRef = useRef(1)

  // Pinch handlers
  const handleTouchStart = useCallback((e: React.TouchEvent): void => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      pinchStartDistRef.current = Math.sqrt(dx * dx + dy * dy)
      pinchStartZoomRef.current = zoom
    }
  }, [zoom])

  const handleTouchMove = useCallback((e: React.TouchEvent): void => {
    if (e.touches.length === 2 && pinchStartDistRef.current !== null) {
      e.preventDefault()
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const dist = Math.sqrt(dx * dx + dy * dy)
      const scale = dist / pinchStartDistRef.current
      setZoom(Math.max(0.5, Math.min(4, pinchStartZoomRef.current * scale)))
    }
  }, [])

  const handleTouchEnd = useCallback((): void => {
    pinchStartDistRef.current = null
  }, [])

  useEffect(() => {
    setZoom(1); setImgError(false)
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') onNext()
      if (e.key === 'ArrowLeft') onPrev()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path])

  useEffect(() => {
    if (isPdf) { window.api.openFile(file.path); onClose() }
  }, [file.path, isPdf, onClose])

  const mediaSrc = 'media:///' + file.path.replace(/\\/g, '/')

  // Premium icon button helper
  const IconBtn = ({ onClick, title, children, active }: { onClick: (e: React.MouseEvent) => void; title?: string; children: React.ReactNode; active?: boolean }) => (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: '34px', height: '34px', borderRadius: '10px', border: 'none', cursor: 'pointer',
        background: active ? 'rgba(108,108,255,0.25)' : 'rgba(255,255,255,0.06)',
        color: active ? '#a0a0ff' : '#d0d0e0', fontSize: '15px',
        backdropFilter: 'blur(8px)',
        transition: 'background 0.15s, transform 0.1s',
        flexShrink: 0,
      }}
      onMouseEnter={e => (e.currentTarget.style.background = active ? 'rgba(108,108,255,0.35)' : 'rgba(255,255,255,0.12)')}
      onMouseLeave={e => (e.currentTarget.style.background = active ? 'rgba(108,108,255,0.25)' : 'rgba(255,255,255,0.06)')}
    >{children}</button>
  )

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.97)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      {/* Prev/Next */}
      <div onClick={(e) => { e.stopPropagation(); onPrev() }}
        style={{ position: 'absolute', left: '16px', top: '50%', transform: 'translateY(-50%)', width: '44px', height: '44px', borderRadius: '50%', background: 'rgba(255,255,255,0.08)', border: '0.5px solid rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: '22px', color: '#fff', zIndex: 10, backdropFilter: 'blur(12px)', transition: 'background 0.15s' }}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.16)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
      >‹</div>
      <div onClick={(e) => { e.stopPropagation(); onNext() }}
        style={{ position: 'absolute', right: '16px', top: '50%', transform: 'translateY(-50%)', width: '44px', height: '44px', borderRadius: '50%', background: 'rgba(255,255,255,0.08)', border: '0.5px solid rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: '22px', color: '#fff', zIndex: 10, backdropFilter: 'blur(12px)', transition: 'background 0.15s' }}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.16)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
      >›</div>

      {/* ── PREMIUM TOP BAR ── */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          position: 'absolute', top: '12px', left: '50%', transform: 'translateX(-50%)',
          display: 'flex', alignItems: 'center', gap: '6px',
          background: 'rgba(18,18,28,0.72)', backdropFilter: 'blur(20px) saturate(1.4)',
          border: '0.5px solid rgba(255,255,255,0.1)', borderRadius: '16px',
          padding: '6px 10px', zIndex: 20,
          boxShadow: '0 8px 32px rgba(0,0,0,0.5), 0 1px 0 rgba(255,255,255,0.05) inset',
          maxWidth: 'calc(100vw - 160px)', minWidth: '320px',
        }}
      >
        {/* Filename */}
        <div style={{ fontSize: '12px', fontWeight: 500, color: '#b0b0c8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '240px', padding: '0 4px' }}
          title={file.name}
        >{file.name}</div>

        <div style={{ width: '0.5px', height: '20px', background: 'rgba(255,255,255,0.1)', margin: '0 2px', flexShrink: 0 }} />

        {/* Zoom controls — only for photos */}
        {isPhoto && !imgError && (
          <>
            <IconBtn onClick={(e) => { e.stopPropagation(); setZoom(z => Math.max(0.5, z - 0.5)) }} title="Zoom out">－</IconBtn>
            <div style={{ fontSize: '11px', color: '#7070a0', minWidth: '36px', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{Math.round(zoom * 100)}%</div>
            <IconBtn onClick={(e) => { e.stopPropagation(); setZoom(z => Math.min(4, z + 0.5)) }} title="Zoom in">＋</IconBtn>
            <IconBtn onClick={(e) => { e.stopPropagation(); setZoom(1) }} title="Reset zoom" active={zoom !== 1}>
              <span style={{ fontSize: '10px', fontWeight: 600 }}>1:1</span>
            </IconBtn>
            <div style={{ width: '0.5px', height: '20px', background: 'rgba(255,255,255,0.1)', margin: '0 2px', flexShrink: 0 }} />
          </>
        )}

        {/* Fav */}
        <IconBtn onClick={(e) => { e.stopPropagation(); onFav(file) }} title={isFav ? 'Unfavourite' : 'Favourite'} active={isFav}>
          {isFav ? '❤️' : '🤍'}
        </IconBtn>

        {/* Show in folder */}
        <button
          onClick={(e) => { e.stopPropagation(); onReveal(file) }}
          style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '0 10px', height: '34px', borderRadius: '10px', border: 'none', cursor: 'pointer', background: 'rgba(255,255,255,0.06)', color: '#b0b0c8', fontSize: '11px', fontWeight: 500, backdropFilter: 'blur(8px)', transition: 'background 0.15s', flexShrink: 0, whiteSpace: 'nowrap' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.12)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
        >
          <span style={{ fontSize: '13px' }}>📁</span> Show in folder
        </button>

        <div style={{ width: '0.5px', height: '20px', background: 'rgba(255,255,255,0.1)', margin: '0 2px', flexShrink: 0 }} />

        {/* Close */}
        <IconBtn onClick={(e) => { e.stopPropagation(); onClose() }} title="Close (Esc)">
          <span style={{ fontSize: '13px', fontWeight: 300 }}>✕</span>
        </IconBtn>
      </div>

      {/* Media */}
      <div
        onClick={(e) => e.stopPropagation()}
        onTouchStart={isPhoto ? handleTouchStart : undefined}
        onTouchMove={isPhoto ? handleTouchMove : undefined}
        onTouchEnd={isPhoto ? handleTouchEnd : undefined}
        style={{ maxWidth: '92vw', maxHeight: '88vh', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto' }}
      >
        {isPhoto ? (
          imgError ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
              <div style={{ fontSize: '48px' }}>🖼️</div>
              <div style={{ fontSize: '13px', color: '#6060a0' }}>Cannot preview this image</div>
              <div onClick={(e) => { e.stopPropagation(); onReveal(file) }} style={{ padding: '8px 20px', borderRadius: '8px', background: '#252535', cursor: 'pointer', fontSize: '12px', color: '#c0c0e0', border: '0.5px solid #3a3a5a' }}>📁 Open file location</div>
            </div>
          ) : (
            <img
              key={file.path}
              src={mediaSrc}
              onError={() => {
                setImgError(true)
                console.log('Error loading image, src:', mediaSrc)
              }}
              style={{ transform: `scale(${zoom})`, transformOrigin: 'center', maxWidth: '90vw', maxHeight: '86vh', objectFit: 'contain', display: 'block', transition: 'transform 0.2s', touchAction: 'none' }}
            />
          )
        ) : isVideo ? (
          file.ext.toLowerCase() === '.mp4' ? (
            <video
              key={file.path}
              src={toUrl(file.path)}
              controls
              autoPlay
              style={{ maxWidth: '90vw', maxHeight: '82vh', display: 'block', background: '#000' }}
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', padding: '40px', background: '#141420', borderRadius: '14px', border: '0.5px solid #2a2a3a' }}>
              <div style={{ fontSize: '72px' }}>🎬</div>
              <div style={{ fontSize: '15px', fontWeight: 600, color: '#e8e8ea', textAlign: 'center' }}>{file.name}</div>
              <div style={{ fontSize: '12px', color: '#7070a0', marginBottom: '8px' }}>This video format cannot be played directly in browser</div>
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
                  boxShadow: '0 8px 16px rgba(108,108,255,0.3)',
                  transition: 'background 0.2s, transform 0.1s'
                }}
                onMouseEnter={e => { e.currentTarget.style.background = '#8080ff'; e.currentTarget.style.transform = 'scale(1.02)' }}
                onMouseLeave={e => { e.currentTarget.style.background = '#6c6cff'; e.currentTarget.style.transform = 'scale(1)' }}
              >
                <span style={{ fontSize: '16px' }}>▶</span> Open in Player
              </button>
            </div>
          )
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', padding: '40px' }}>
            <div style={{ fontSize: '72px' }}>📄</div>
            <div style={{ fontSize: '14px', color: '#8080a0', textAlign: 'center' }}>{file.name}</div>
            <div onClick={(e) => { e.stopPropagation(); onReveal(file) }} style={{ padding: '8px 20px', borderRadius: '8px', background: '#252535', cursor: 'pointer', fontSize: '12px', color: '#c0c0e0', border: '0.5px solid #3a3a5a' }}>📁 Open file location</div>
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '12px 16px', background: 'linear-gradient(to top, rgba(0,0,0,0.9), transparent)', display: 'flex', gap: '16px', fontSize: '11px', color: '#6060a0' }}>
        <span>{file.date ? new Date(file.date).toLocaleDateString() : ''}</span>
        <span>{(file.size / 1024 / 1024).toFixed(1)} MB</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.path}</span>
        {file.lat && file.lng && <span>📍 {file.lat.toFixed(3)}, {file.lng.toFixed(3)}</span>}
      </div>
    </div>
  )
}

// ─── YEARS VIEW (fixed thumbnails) ───────────────────────────────────────────
function YearsView({ groupedFiles, onYearClick }: { groupedFiles: Record<string, ScannedFile[]>; onYearClick: (year: string) => void }): React.JSX.Element {
  const yearMap: Record<string, ScannedFile[]> = {}
  for (const [key, files] of Object.entries(groupedFiles)) {
    const year = key.split('-')[0]
    if (!yearMap[year]) yearMap[year] = []
    yearMap[year].push(...files)
  }
  const years = Object.keys(yearMap).sort((a, b) => b.localeCompare(a))

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '16px', padding: '8px 0' }}>
      {years.map(year => {
        const files = yearMap[year]
        // FIX: use any file with a thumb OR any photo file — don't require thumb
        const previewFiles = [
          ...files.filter(f => f.thumb),
          ...files.filter(f => photoExts.includes(f.ext) && !f.thumb)
        ].slice(0, 4)

        return (
          <div
            key={year}
            onClick={() => onYearClick(year)}
            style={{ background: '#141420', borderRadius: '14px', border: '0.5px solid #2a2a3a', overflow: 'hidden', cursor: 'pointer', transition: 'transform 0.2s, border-color 0.2s, box-shadow 0.2s' }}
            onMouseEnter={e => { const el = e.currentTarget as HTMLDivElement; el.style.borderColor = '#6c6cff'; el.style.transform = 'scale(1.02)'; el.style.boxShadow = '0 8px 24px rgba(108,108,255,0.15)' }}
            onMouseLeave={e => { const el = e.currentTarget as HTMLDivElement; el.style.borderColor = '#2a2a3a'; el.style.transform = 'scale(1)'; el.style.boxShadow = 'none' }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', height: '140px' }}>
              {[0, 1, 2, 3].map(i => {
                const f = previewFiles[i]
                const src = f ? ('media:///' + (f.thumb || f.path).replace(/\\/g, '/')) : null
                return (
                  <div key={i} style={{ background: '#1a1a28', overflow: 'hidden', borderRight: i % 2 === 0 ? '1px solid #0f0f10' : undefined, borderBottom: i < 2 ? '1px solid #0f0f10' : undefined, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {src ? (
                      <YearThumb src={src} />
                    ) : (
                      <div style={{ fontSize: '20px', opacity: 0.2 }}>📷</div>
                    )}
                  </div>
                )
              })}
            </div>
            <div style={{ padding: '10px 14px 12px' }}>
              <div style={{ fontSize: '22px', fontWeight: 700, color: '#e0e0f4', letterSpacing: '-0.5px' }}>{year}</div>
              <div style={{ fontSize: '11px', color: '#5050a0', marginTop: '2px' }}>{files.length} files</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// Separate component so each thumb has its own error state
function YearThumb({ src }: { src: string }): React.JSX.Element {
  const [err, setErr] = useState(false)
  if (err) return <div style={{ fontSize: '20px', opacity: 0.2 }}>📷</div>
  return <img src={src} onError={() => setErr(true)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
}

// ─── MAP VIEW ────────────────────────────────────────────────────────────────
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
      marker.on('click', () => onOpen(first, clusterFiles))
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
      <div style={{ marginBottom: '10px', fontSize: '12px', color: '#7070a0', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span>📍 {geoFiles.length} files with GPS location</span>
        {geoFiles.length === 0 && <span style={{ color: '#3a3a48' }}>— scan photos with location data to see them here</span>}
      </div>
      {geoFiles.length === 0 ? (
        <div style={{ flex: 1, background: '#141420', borderRadius: '12px', border: '0.5px solid #1e1e2a', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
          <div style={{ fontSize: '48px' }}>🗺️</div>
          <div style={{ fontSize: '14px', color: '#5050a0' }}>No GPS data found</div>
          <div style={{ fontSize: '11px', color: '#3a3a48' }}>Photos with location info will appear here</div>
        </div>
      ) : (
        <div ref={mapRef} style={{ flex: 1, borderRadius: '12px', overflow: 'hidden', minHeight: '400px' }} />
      )}
    </div>
  )
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
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

  const scrollTopRef = useRef(0)
  const [scrollVersion, setScrollVersion] = useState(0)
  const rafRef = useRef<number | null>(null)

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
    window.api.getDrives()
    window.api.onDrivesUpdated((d) => setDrives(d as DriveInfo[]))
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
  const handleSelect = useCallback((file: ScannedFile): void => {
    setSelected(prev => { const next = new Set(prev); if (next.has(file.path)) next.delete(file.path); else next.add(file.path); return next })
  }, [])
  const handleReveal = useCallback((file: ScannedFile): void => { window.electron.ipcRenderer.send('reveal-file', file.path) }, [])
  const openLightbox = useCallback((file: ScannedFile, list: ScannedFile[]): void => { setLightbox({ file, list }) }, [])

  const groupedFiles = selectedDrive && driveFiles[selectedDrive] ? driveFiles[selectedDrive] : {}
  const months = Object.keys(groupedFiles).sort((a, b) => b.localeCompare(a))

  const getFiltered = (files: ScannedFile[]): ScannedFile[] => {
    if (activeNav === 'photos') return files.filter(f => photoExts.includes(f.ext.toLowerCase()))
    if (activeNav === 'videos') return files.filter(f => videoExts.includes(f.ext.toLowerCase()))
    if (activeNav === 'docs') return files.filter(f => docExts.includes(f.ext.toLowerCase()))
    if (activeNav === 'screenshots') {
      return files.filter(f => {
        const lp = f.path.toLowerCase()
        return lp.includes('screenshot') || lp.includes('screen shot')
      })
    }
    if (activeNav === 'places') {
      return files.filter(f => f.lat !== null)
    }
    if (activeNav === 'archive' || activeNav === 'trash') {
      return []
    }
    return files
  }

  const allFiles = Object.values(groupedFiles).flat()
  const allFavFiles = allFiles.filter(f => favourites.has(f.path))
  const totalFiles = allFiles.length
  const getVisible = (key: string): number => visibleCount[key] ?? 40

  return (
    <div style={{ display: 'flex', width: '100vw', height: '100vh', background: '#0f0f10', color: '#e8e8ea', fontFamily: 'system-ui, sans-serif', fontSize: '13px', overflow: 'hidden', position: 'fixed', inset: 0 }}>
      <style>{`
        @keyframes tileSpin { to { transform: rotate(360deg); } }
        @keyframes shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(250%); } }
        @keyframes slideOutLeft { from { opacity:1; transform:translateX(0); } to { opacity:0; transform:translateX(-40px); } }
        @keyframes slideInRight { from { opacity:0; transform:translateX(40px); } to { opacity:1; transform:translateX(0); } }
        @keyframes slideOutRight { from { opacity:1; transform:translateX(0); } to { opacity:0; transform:translateX(40px); } }
        @keyframes slideInLeft { from { opacity:0; transform:translateX(-40px); } to { opacity:1; transform:translateX(0); } }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #2a2a3a; border-radius: 2px; }
        .leaflet-container { background: #141420 !important; }
        .leaflet-popup-content-wrapper { background: #1a1a2a !important; border: 0.5px solid #2a2a3a !important; color: #e0e0f0 !important; border-radius: 10px !important; box-shadow: 0 4px 20px rgba(0,0,0,0.5) !important; }
        .leaflet-popup-tip { background: #1a1a2a !important; }
        .leaflet-popup-close-button { color: #7070a0 !important; }
        input[type=range] { height: 4px; }
        button:focus { outline: none; }
        .sidebar-nav-item {
          display: flex;
          align-items: center;
          padding: 7px 12px;
          margin: 2px 8px;
          border-radius: 24px;
          cursor: pointer;
          color: #9090a0;
          background: transparent;
          transition: background 0.15s, color 0.15s;
        }
        .sidebar-nav-item:hover {
          background: rgba(255, 255, 255, 0.05);
          color: #d0d0e0;
        }
        .sidebar-nav-item.active {
          background: rgba(108, 108, 255, 0.15) !important;
          color: #a0a0ff !important;
        }
      `}</style>

      {/* Sidebar */}
      <div style={{ width: '220px', minWidth: '220px', background: '#161618', borderRight: '0.5px solid #2a2a2e', display: 'flex', flexDirection: 'column', height: '100vh', overflowY: 'auto' }}>
        <div style={{ padding: '18px 16px 12px', borderBottom: '0.5px solid #2a2a2e' }}>
          <div style={{ fontSize: '16px', fontWeight: 600, color: '#f0f0f2', letterSpacing: '-0.3px' }}>DiskFrame</div>
          <div style={{ fontSize: '11px', color: '#5a5a62', marginTop: '2px' }}>Smart file organiser</div>
        </div>

        {drives.map(drive => {
          const pct = drive.total > 0 ? Math.round((drive.used / drive.total) * 100) : 0
          const sel = selectedDrive === drive.name
          return (
            <div key={drive.name} onClick={() => handleDriveClick(drive.name)} style={{ margin: '8px 10px', background: sel ? '#1e1e32' : '#1a1a1e', borderRadius: '10px', padding: '10px 12px', border: `0.5px solid ${sel ? '#3a3a6a' : '#242428'}`, cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 500, color: '#c8c8d0' }}>
                <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#4cd97b' }} />
                {drive.name}
              </div>
              <div style={{ fontSize: '10px', color: '#5a5a62', marginTop: '3px' }}>{drive.total} GB · {drive.free} GB free</div>
              <div style={{ height: '2px', background: '#222228', borderRadius: '2px', marginTop: '7px' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: '#6c6cff', borderRadius: '2px' }} />
              </div>
              {sel && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '5px' }}>
                  <div style={{ fontSize: '10px', color: '#6c6cff' }}>{scanning ? `Scanning... ${scanCount}` : `${scanCount} files`}</div>
                  {!scanning && scanCount > 0 && (
                    <div onClick={e => { e.stopPropagation(); handleRescan(drive.name) }} style={{ fontSize: '10px', color: '#4cd97b', cursor: 'pointer', padding: '1px 5px', borderRadius: '3px', background: 'rgba(76,217,123,0.1)' }}>↺ Rescan</div>
                  )}
                </div>
              )}
            </div>
          )
        })}

        <div style={{ height: '0.5px', background: '#2a2a2e', margin: '14px 16px' }} />

        <div style={{ padding: '4px 0' }}>
          <div style={{ fontSize: '10px', color: '#5a5a6a', textTransform: 'uppercase', letterSpacing: '0.8px', padding: '0 20px', marginBottom: '8px', fontWeight: 600 }}>Collections</div>
          {[
            { id: 'all', label: 'All files', icon: '🗂' },
            { id: 'photos', label: 'Photos', icon: '🖼' },
            { id: 'videos', label: 'Videos', icon: '🎬' },
            { id: 'docs', label: 'Documents', icon: '📄' },
            { id: 'screenshots', label: 'Screenshots', icon: '📸' },
            { id: 'places', label: 'Places', icon: '📍' },
            { id: 'favourites', label: 'Favourites', icon: '⭐' },
            { id: 'archive', label: 'Archive', icon: '🗄' },
            { id: 'trash', label: 'Trash', icon: '🗑' }
          ].map(item => (
            <div
              key={item.id}
              onClick={() => setActiveNav(item.id)}
              className={`sidebar-nav-item ${activeNav === item.id ? 'active' : ''}`}
            >
              <span style={{ fontSize: '18px', marginRight: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{item.icon}</span>
              <span style={{ flex: 1, fontSize: '13px' }}>{item.label}</span>
              {item.id === 'favourites' && allFavFiles.length > 0 && (
                <span style={{ fontSize: '10px', color: '#5050a0', background: '#1a1a2e', borderRadius: '4px', padding: '1px 5px' }}>{allFavFiles.length}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', minWidth: 0 }}>
        {/* Topbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 18px', borderBottom: '0.5px solid #1e1e24', background: '#0f0f10', flexShrink: 0 }}>
          <div style={{ flex: 1, fontSize: '13px', color: '#5050a0' }}>
            {selectedDrive ? <><span style={{ color: '#d0d0e8' }}>{selectedDrive}</span> › <span style={{ color: '#7070c0' }}>{activeNav}</span></> : 'Select a drive'}
          </div>
          {selected.size > 0 && (
            <div style={{ fontSize: '11px', color: '#e8e8f4', background: '#252535', border: '0.5px solid #3a3a5a', borderRadius: '6px', padding: '4px 12px' }}>
              {selected.size} selected
              <span onClick={() => setSelected(new Set())} style={{ marginLeft: '8px', cursor: 'pointer', color: '#7070a0' }}>✕</span>
            </div>
          )}
          {activeView === 'Grid' && <div style={{ fontSize: '10px', color: '#3a3a48' }}>Ctrl+Scroll to zoom</div>}
          <div style={{ display: 'flex', gap: '1px', background: '#161618', borderRadius: '7px', padding: '2px', border: '0.5px solid #2a2a2e' }}>
            {['Grid', 'Timeline', 'Years', 'Map'].map(v => (
              <div key={v} onClick={() => setActiveView(v)} style={{ padding: '4px 10px', borderRadius: '5px', cursor: 'pointer', fontSize: '11px', background: activeView === v ? '#252535' : 'transparent', color: activeView === v ? '#c0c0e8' : '#5a5a70' }}>{v}</div>
            ))}
          </div>
        </div>

        <div
          style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '18px 20px' }}
          onWheel={handleWheel}
          onScroll={e => {
            scrollTopRef.current = (e.currentTarget as HTMLDivElement).scrollTop
            if (rafRef.current) return
            rafRef.current = requestAnimationFrame(() => { rafRef.current = null; setScrollVersion(n => n + 1) })
          }}
        >
          {!scanning && (activeNav === 'archive' || activeNav === 'trash') && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '12px', minHeight: '300px' }}>
              <div style={{ fontSize: '64px', filter: 'drop-shadow(0 10px 20px rgba(0,0,0,0.3))' }}>{activeNav === 'archive' ? '🗄️' : '🗑️'}</div>
              <div style={{ fontSize: '18px', fontWeight: 600, color: '#f0f0f2', letterSpacing: '-0.3px', marginTop: '8px' }}>{activeNav === 'archive' ? 'Archive' : 'Trash'}</div>
              <div style={{ fontSize: '13px', color: '#5a5a72', background: 'rgba(255,255,255,0.03)', padding: '6px 16px', borderRadius: '20px', border: '0.5px solid rgba(255,255,255,0.05)' }}>Coming soon</div>
            </div>
          )}

          {!selectedDrive && activeNav !== 'archive' && activeNav !== 'trash' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '10px' }}>
              <div style={{ fontSize: '48px' }}>💾</div>
              <div style={{ fontSize: '14px', color: '#5050a0' }}>Click a drive to scan</div>
              <div style={{ fontSize: '11px', color: '#3a3a48' }}>DiskFrame reads EXIF and organises by date</div>
            </div>
          )}

          {scanning && activeNav !== 'archive' && activeNav !== 'trash' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '12px' }}>
              <div style={{ fontSize: '14px', color: '#6c6cff' }}>Scanning {selectedDrive}...</div>
              <div style={{ fontSize: '12px', color: '#5a5a72' }}>{scanCount} files found</div>
              <div style={{ width: '220px', height: '3px', background: '#1e1e2a', borderRadius: '2px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: '45%', background: 'linear-gradient(90deg, transparent, #6c6cff, transparent)', borderRadius: '2px', animation: 'shimmer 1.4s ease-in-out infinite' }} />
              </div>
            </div>
          )}

          {!scanning && activeNav === 'favourites' && (
            <div>
              <div style={{ fontSize: '15px', fontWeight: 600, color: '#e0e0f0', marginBottom: '16px' }}>❤️ Favourites · {allFavFiles.length} files</div>
              {allFavFiles.length === 0 ? (
                <div style={{ color: '#3a3a48', fontSize: '13px' }}>No favourites yet — hover a tile and tap 🤍 to add.</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: '5px' }}>
                  {allFavFiles.map(file => (
                    <FileTile key={file.path} file={file} onOpen={f => openLightbox(f, allFavFiles)} onFav={handleFav} isFav={true} isSelected={selected.has(file.path)} onSelect={handleSelect} tileSize={100} />
                  ))}
                </div>
              )}
            </div>
          )}

          {!scanning && activeView === 'Map' && activeNav !== 'archive' && activeNav !== 'trash' && (
            <div style={{ height: 'calc(100vh - 120px)' }}>
              <MapView files={allFiles} onOpen={openLightbox} />
            </div>
          )}

          {!scanning && activeView === 'Years' && activeNav !== 'favourites' && activeNav !== 'archive' && activeNav !== 'trash' && (
            <div style={{ animation: transitioning ? 'slideOutLeft 0.28s forwards' : 'slideInRight 0.28s forwards' }}>
              <div style={{ fontSize: '13px', color: '#5050a0', marginBottom: '16px' }}>
                <span style={{ color: '#d0d0e8', fontWeight: 600 }}>All Years</span>
                {yearFilter && <span onClick={() => setYearFilter(null)} style={{ marginLeft: '10px', cursor: 'pointer', color: '#6c6cff' }}>× {yearFilter}</span>}
              </div>
              <YearsView groupedFiles={groupedFiles} onYearClick={year => {
                setYearFilter(year); setActiveView('Timeline')
                setTimeout(() => {
                  const key = months.find(m => m.startsWith(year))
                  if (key && monthRefs.current[key]) monthRefs.current[key]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }, 100)
              }} />
            </div>
          )}

          {!scanning && activeNav !== 'favourites' && activeNav !== 'archive' && activeNav !== 'trash' && (activeView === 'Grid' || activeView === 'Timeline') && (
            <div style={{
              animation: transitioning && activeView === 'Grid' ? 'slideOutLeft 0.28s forwards'
                : transitioning && activeView === 'Timeline' ? 'slideOutRight 0.28s forwards'
                  : activeView === 'Timeline' ? 'slideInRight 0.28s forwards'
                    : 'slideInLeft 0.28s forwards'
            }}>
              {activeView === 'Timeline' && (
                <div style={{ paddingLeft: '24px', borderLeft: '1px solid #1e1e2a' }}>
                  {months.map(monthKey => {
                    const files = getFiltered(groupedFiles[monthKey] || [])
                    if (files.length === 0) return null
                    const [year, month] = monthKey.split('-')
                    return (
                      <div key={monthKey} ref={el => { monthRefs.current[monthKey] = el }} style={{ marginBottom: '28px', position: 'relative' }}>
                        <div style={{ position: 'absolute', left: '-28px', top: '4px', width: '8px', height: '8px', borderRadius: '50%', background: '#6c6cff', border: '2px solid #0f0f10' }} />
                        <div style={{ fontSize: '13px', fontWeight: 600, color: '#c0c0e0', marginBottom: '8px' }}>
                          {month} {year} <span style={{ fontWeight: 400, fontSize: '11px', color: '#44444e' }}>· {files.length} files</span>
                        </div>
                        <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                          {files.slice(0, 12).map(file => (
                            <div key={file.path} onClick={() => openLightbox(file, files)} style={{ width: '80px', height: '80px', borderRadius: '6px', overflow: 'hidden', cursor: 'pointer', background: '#141420', position: 'relative' }}>
                              {(photoExts.includes(file.ext) || (videoExts.includes(file.ext) && file.thumb)) ? (
                                <>
                                  <img src={thumbUrl(file)} loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                  {videoExts.includes(file.ext) && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.3)' }}><div style={{ fontSize: '18px' }}>▶</div></div>}
                                </>
                              ) : (
                                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px' }}>{videoExts.includes(file.ext) ? '🎬' : '📄'}</div>
                              )}
                            </div>
                          ))}
                          {files.length > 12 && (
                            <div style={{ width: '80px', height: '80px', borderRadius: '6px', background: '#1a1a2a', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', color: '#5050a0', cursor: 'pointer' }}>+{files.length - 12} more</div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {activeView === 'Grid' && (() => {
                const tilesPerRow = Math.max(1, Math.floor((window.innerWidth - 260) / (tileSize + 5)))
                const scrollTop = scrollTopRef.current
                const winH = window.innerHeight
                let offsetY = 0
                void scrollVersion
                return months.map(monthKey => {
                  const files = getFiltered(groupedFiles[monthKey] || [])
                  if (files.length === 0) return null
                  const [year, month] = monthKey.split('-')
                  const visible = getVisible(monthKey)
                  const rowCount = Math.ceil(Math.min(visible, files.length) / tilesPerRow)
                  const estH = rowCount * (tileSize + 5) + 50
                  const myOffset = offsetY
                  offsetY += estH + 28
                  const inView = myOffset < scrollTop + winH + 1000 && myOffset + estH > scrollTop - 1000
                  const ref = (el: HTMLDivElement | null): void => { monthRefs.current[monthKey] = el }

                  if (!inView) {
                    return <div key={monthKey + '_ph'} ref={ref} style={{ height: estH + 28 }} />
                  }

                  return (
                    <div key={monthKey + '_grid_' + files.filter(f => f.thumb).length} ref={ref} style={{ marginBottom: '28px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                        <div style={{ fontSize: '15px', fontWeight: 600, color: '#d0d0e8' }}>{month} {year}</div>
                        <div style={{ fontSize: '11px', color: '#3a3a48' }}>· {files.length} files</div>
                        <div style={{ flex: 1, height: '0.5px', background: '#1a1a22' }} />
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${tileSize}px, 1fr))`, gap: '5px', transition: 'grid-template-columns 0.12s cubic-bezier(0.25, 0.46, 0.45, 0.94)' }}>
                        {files.slice(0, visible).map(file => (
                          <FileTile key={file.path} file={file} onOpen={f => openLightbox(f, files)} onFav={handleFav} isFav={favourites.has(file.path)} isSelected={selected.has(file.path)} onSelect={handleSelect} tileSize={tileSize} />
                        ))}
                      </div>
                      {files.length > visible && (
                        <div onClick={() => setVisibleCount(prev => ({ ...prev, [monthKey]: visible + 40 }))} style={{ marginTop: '10px', padding: '8px', borderRadius: '8px', background: '#1a1a2a', border: '0.5px solid #2a2a3a', cursor: 'pointer', fontSize: '12px', color: '#6060a0', textAlign: 'center' }}>
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
        <div style={{ borderTop: '0.5px solid #1a1a22', padding: '6px 18px', display: 'flex', alignItems: 'center', gap: '14px', background: '#0c0c0e', flexShrink: 0 }}>
          <div style={{ fontSize: '11px', color: '#3a3a48' }}><span style={{ color: '#6060a0' }}>{drives.length}</span> drives</div>
          <div style={{ fontSize: '11px', color: '#3a3a48' }}><span style={{ color: '#6060a0' }}>{totalFiles}</span> files</div>
          <div style={{ fontSize: '11px', color: '#3a3a48' }}><span style={{ color: '#6060a0' }}>{months.length}</span> months</div>
          <div style={{ fontSize: '11px', color: '#3a3a48' }}><span style={{ color: '#e060a0' }}>❤️ {allFavFiles.length}</span> favourites</div>
          {selected.size > 0 && <div style={{ fontSize: '11px', color: '#6c6cff' }}>✓ {selected.size} selected</div>}
          {activeView === 'Grid' && <div style={{ fontSize: '11px', color: '#3a3a48' }}>tile: <span style={{ color: '#6060a0' }}>{tileSize}px</span></div>}
          <div style={{ marginLeft: 'auto', fontSize: '10px', color: '#4cd97b', background: 'rgba(76,217,123,0.08)', border: '0.5px solid rgba(76,217,123,0.2)', borderRadius: '4px', padding: '2px 7px' }}>● live</div>
        </div>
      </div>

      {lightbox && (
        <LightBox
          file={lightbox.file}
          isFav={favourites.has(lightbox.file.path)}
          onFav={handleFav}
          onReveal={handleReveal}
          onClose={() => setLightbox(null)}
          onNext={() => { const idx = lightbox.list.indexOf(lightbox.file); if (idx < lightbox.list.length - 1) setLightbox({ file: lightbox.list[idx + 1], list: lightbox.list }) }}
          onPrev={() => { const idx = lightbox.list.indexOf(lightbox.file); if (idx > 0) setLightbox({ file: lightbox.list[idx - 1], list: lightbox.list }) }}
        />
      )}
    </div>
  )
}