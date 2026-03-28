import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  memo,
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

// ─────────────────────────────────────────────
// Inject global body styles once (fixes full-screen in Electron)
// ─────────────────────────────────────────────
if (typeof document !== 'undefined') {
  const style = document.createElement('style')
  style.textContent = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body, #root { width: 100%; height: 100%; overflow: hidden; }
  `
  document.head.appendChild(style)
}

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────
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
}

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const PHOTO_EXTS = [
  '.jpg', '.jpeg', '.png', '.heic', '.raw', '.cr2', '.nef',
  '.webp', '.bmp', '.tiff', '.tif', '.gif', '.avif',
]
const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.m4v', '.flv']
const DOC_EXTS = [
  '.pdf', '.docx', '.doc', '.txt', '.xlsx', '.xls',
  '.pptx', '.ppt', '.csv', '.m', '.py', '.js', '.ts',
]

const GAP = 6
const TILE = 130

// ─────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────
const toFileUrl = (p: string): string =>
  'localfile:///' + p.replace(/\\/g, '/')

const formatDate = (d: string): string =>
  new Date(d).toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })

const formatTime = (d: string): string =>
  new Date(d).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true,
  })

const formatSize = (b: number): string =>
  b > 1_048_576
    ? (b / 1_048_576).toFixed(1) + ' MB'
    : b > 1024
      ? (b / 1024).toFixed(0) + ' KB'
      : b + ' B'

const getDriveIcon = (n: string): string =>
  n === 'C:' ? '💻' : n === 'D:' ? '🖴' : '🔌'

const getDriveLabel = (n: string): string =>
  n === 'C:' ? 'System Drive' : n === 'D:' ? 'Local Disk' : 'USB Drive'

// ─────────────────────────────────────────────
// HEIC conversion using heic2any (renderer-side)
// Lazily imported only when needed — zero cost for non-HEIC files
// ─────────────────────────────────────────────
const heicCache = new Map<string, string>() // path → blob URL

async function convertHeicToBlobUrl(filePath: string): Promise<string> {
  if (heicCache.has(filePath)) return heicCache.get(filePath)!

  // Dynamically import heic2any only on first HEIC encounter
  const heic2any = (await import('heic2any')).default

  // Read file via fetch on the localfile:// protocol
  const fileUrl = toFileUrl(filePath)
  const resp = await fetch(fileUrl)
  const blob = await resp.blob()

  const converted = await heic2any({ blob, toType: 'image/jpeg', quality: 0.82 })
  const resultBlob = Array.isArray(converted) ? converted[0] : converted
  const blobUrl = URL.createObjectURL(resultBlob)
  heicCache.set(filePath, blobUrl)
  return blobUrl
}

// ─────────────────────────────────────────────
// FileTile  — RAM-optimised, video-fixed, HEIC-fixed
// ─────────────────────────────────────────────
interface FileTileProps {
  file: ScannedFile
  isSelected: boolean
  onSelect: (path: string, e: React.MouseEvent) => void
  onOpen: (file: ScannedFile) => void
}

const FileTile = memo(
  ({ file, isSelected, onSelect, onOpen }: FileTileProps): React.JSX.Element => {
    const [hovered, setHovered] = useState(false)
    const [imgSrc, setImgSrc] = useState<string | null>(null)
    const [imgFailed, setImgFailed] = useState(false)
    const [vidReady, setVidReady] = useState(false)
    const vidRef = useRef<HTMLVideoElement>(null)

    const isPhoto = PHOTO_EXTS.includes(file.ext)
    const isVideo = VIDEO_EXTS.includes(file.ext)
    const isHeic = file.ext === '.heic'

    // For normal images: set src immediately; for HEIC: convert lazily on hover
    useEffect(() => {
      if (!isPhoto) return
      if (isHeic) return // handled below on hover
      setImgSrc(toFileUrl(file.path))
    }, [file.path, isPhoto, isHeic])

    // HEIC: start conversion on hover (first time)
    useEffect(() => {
      if (!isHeic || !hovered || imgSrc) return
      let cancelled = false
      convertHeicToBlobUrl(file.path)
        .then((url) => { if (!cancelled) setImgSrc(url) })
        .catch(() => { if (!cancelled) setImgFailed(true) })
      return () => { cancelled = true }
    }, [isHeic, hovered, file.path, imgSrc])

    // Video: load metadata on hover, seek to 1.5s for thumbnail
    useEffect(() => {
      if (!isVideo || !hovered || !vidRef.current) return
      const vid = vidRef.current
      if (vid.readyState >= 1) {
        vid.currentTime = 1.5
        setVidReady(true)
        return
      }
      vid.preload = 'metadata'
      vid.load()
      const onMeta = (): void => {
        vid.currentTime = 1.5
        setVidReady(true)
      }
      vid.addEventListener('loadedmetadata', onMeta, { once: true })
      return () => vid.removeEventListener('loadedmetadata', onMeta)
    }, [isVideo, hovered])

    return (
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => onOpen(file)}
        style={{
          borderRadius: 8,
          aspectRatio: '1',
          cursor: 'pointer',
          overflow: 'hidden',
          background: '#1a1a2a',
          position: 'relative',
          border: isSelected ? '2px solid #6c6cff' : '2px solid transparent',
          transform: hovered ? 'scale(1.03)' : 'scale(1)',
          transition: 'transform 0.15s ease, border-color 0.1s ease, box-shadow 0.15s ease',
          boxShadow: hovered ? '0 8px 24px rgba(0,0,0,0.5)' : 'none',
          willChange: 'transform',
          flexShrink: 0,
        }}
      >
        {/* Select circle */}
        <div
          onClick={(e) => { e.stopPropagation(); onSelect(file.path, e) }}
          style={{
            position: 'absolute', top: 6, right: 6, zIndex: 10,
            width: 20, height: 20, borderRadius: '50%',
            background: isSelected ? '#6c6cff' : 'rgba(0,0,0,0.5)',
            border: `1.5px solid ${isSelected ? '#8080ff' : 'rgba(255,255,255,0.3)'}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: isSelected || hovered ? 1 : 0,
            transition: 'opacity 0.15s ease',
          }}
        >
          {isSelected && (
            <span style={{ fontSize: 11, color: '#fff', fontWeight: 700, lineHeight: 1 }}>✓</span>
          )}
        </div>

        {/* Badge */}
        {isVideo && (
          <div style={{
            position: 'absolute', bottom: 5, left: 5, zIndex: 10,
            background: 'rgba(0,0,0,0.7)', borderRadius: 4, padding: '2px 5px',
            fontSize: 9, color: '#fff',
          }}>
            ▶ {file.ext.slice(1).toUpperCase()}
          </div>
        )}
        {isHeic && (
          <div style={{
            position: 'absolute', bottom: 5, right: 5, zIndex: 10,
            background: 'rgba(0,0,0,0.7)', borderRadius: 4, padding: '2px 5px',
            fontSize: 9, color: '#aaffaa',
          }}>
            HEIC
          </div>
        )}

        {/* Content */}
        {isPhoto ? (
          imgFailed || (!imgSrc && !isHeic) ? (
            <PlaceholderBox ext={file.ext} size={file.size} isHeic={isHeic} />
          ) : imgSrc ? (
            <img
              src={imgSrc}
              loading="lazy"
              decoding="async"
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              onError={() => setImgFailed(true)}
            />
          ) : (
            // HEIC not yet converted — show placeholder until hovered & converted
            <PlaceholderBox ext={file.ext} size={file.size} isHeic />
          )
        ) : isVideo ? (
          <>
            {/* Always render video element but only load on hover */}
            <video
              ref={vidRef}
              src={toFileUrl(file.path)}
              preload="none"
              muted
              playsInline
              style={{
                width: '100%', height: '100%', objectFit: 'cover', display: 'block',
                opacity: vidReady ? 1 : 0, transition: 'opacity 0.2s',
              }}
            />
            {!vidReady && (
              <div style={{
                position: 'absolute', inset: 0, display: 'flex',
                flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
              }}>
                <span style={{ fontSize: 28 }}>🎬</span>
                <span style={{ fontSize: 10, color: '#44444e' }}>{file.ext.toUpperCase()}</span>
              </div>
            )}
          </>
        ) : (
          <div style={{
            width: '100%', height: '100%', display: 'flex',
            flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
          }}>
            <span style={{ fontSize: 24 }}>📄</span>
            <span style={{ fontSize: 10, color: '#5a5a72' }}>{file.ext}</span>
          </div>
        )}
      </div>
    )
  },
  (prev, next) => prev.isSelected === next.isSelected && prev.file.path === next.file.path,
)
FileTile.displayName = 'FileTile'

// Small helper to avoid duplicate placeholder JSX
const PlaceholderBox = ({
  ext, size, isHeic,
}: { ext: string; size: number; isHeic: boolean }): React.JSX.Element => (
  <div style={{
    width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: 4,
    background: isHeic ? 'linear-gradient(135deg,#1a2a1a,#2a3a2a)' : '#1a1a2a',
  }}>
    <span style={{ fontSize: 28 }}>{isHeic ? '🍎' : '🖼️'}</span>
    <span style={{ fontSize: 9, color: '#6a9a6a' }}>{ext.slice(1).toUpperCase()}</span>
    <span style={{ fontSize: 8, color: '#4a6a4a' }}>{(size / 1_048_576).toFixed(1)}MB</span>
  </div>
)

// ─────────────────────────────────────────────
// VirtualGrid  — responsive cols via ResizeObserver
// NOTE: NOT wrapped in memo() because useVirtualizer must be called
// unconditionally at top level and memo() + hooks is fine, but
// the ESLint rule fires on the inner component. Extract to named fn instead.
// ─────────────────────────────────────────────
interface VirtualGridProps {
  files: ScannedFile[]
  selectedFiles: Set<string>
  onSelect: (path: string, e: React.MouseEvent) => void
  onOpen: (file: ScannedFile) => void
}

function VirtualGrid({ files, selectedFiles, onSelect, onOpen }: VirtualGridProps): React.JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null)
  const [cols, setCols] = useState(5)

  // Responsive columns based on container width
  useEffect(() => {
    if (!parentRef.current) return
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width
      const newCols = Math.max(2, Math.floor((w + GAP) / (TILE + GAP)))
      setCols(newCols)
    })
    ro.observe(parentRef.current)
    return () => ro.disconnect()
  }, [])

  const rowCount = Math.ceil(files.length / cols)
  const rowHeight = TILE + GAP

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 4,
  })

  return (
    <div
      ref={parentRef}
      style={{
        height: Math.min(rowCount * rowHeight, 560),
        overflowY: 'auto',
        position: 'relative',
        width: '100%',
      }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((vRow) => {
          const rowFiles = files.slice(vRow.index * cols, (vRow.index + 1) * cols)
          return (
            <div
              key={vRow.index}
              style={{
                position: 'absolute',
                top: vRow.start,
                width: '100%',
                display: 'grid',
                gridTemplateColumns: `repeat(${cols}, ${TILE}px)`,
                gap: GAP,
              }}
            >
              {rowFiles.map((file) => (
                <FileTile
                  key={file.path}
                  file={file}
                  isSelected={selectedFiles.has(file.path)}
                  onSelect={onSelect}
                  onOpen={onOpen}
                />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────
// Full-Screen Viewer — HEIC converted, video plays, keyboard nav
// ─────────────────────────────────────────────
interface ViewerProps {
  file: ScannedFile
  allFiles: ScannedFile[]
  selectedFiles: Set<string>
  onClose: () => void
  onSelect: (path: string, e: React.MouseEvent) => void
}

const Viewer = memo(
  ({ file, allFiles, selectedFiles, onClose, onSelect }: ViewerProps): React.JSX.Element => {
    const [currentIdx, setCurrentIdx] = useState<number>(() =>
      allFiles.findIndex((f) => f.path === file.path),
    )
    const [heicSrc, setHeicSrc] = useState<string | null>(null)
    const [heicLoading, setHeicLoading] = useState(false)
    const [imgError, setImgError] = useState(false)

    const currentFile = allFiles[currentIdx] ?? file

    useEffect(() => { setImgError(false) }, [currentIdx])

    const goNext = useCallback((): void => {
      setCurrentIdx((i) => Math.min(i + 1, allFiles.length - 1))
    }, [allFiles.length])

    const goPrev = useCallback((): void => {
      setCurrentIdx((i) => Math.max(i - 1, 0))
    }, [])

    // HEIC conversion in viewer — uses same cache as tiles
    useEffect(() => {
      if (!currentFile || currentFile.ext !== '.heic') {
        setHeicSrc(null)
        return
      }
      setHeicLoading(true)
      setHeicSrc(null)
      let cancelled = false
      convertHeicToBlobUrl(currentFile.path)
        .then((url) => {
          if (!cancelled) { setHeicSrc(url); setHeicLoading(false) }
        })
        .catch(() => {
          if (!cancelled) setHeicLoading(false)
        })
      return () => { cancelled = true }
    }, [currentFile?.path, currentFile?.ext])

    useEffect(() => {
      const handler = (e: KeyboardEvent): void => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); goNext() }
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); goPrev() }
        else if (e.key === 'Escape') onClose()
      }
      window.addEventListener('keydown', handler)
      return () => window.removeEventListener('keydown', handler)
    }, [goNext, goPrev, onClose])

    if (!currentFile) return <></>

    const isPhoto = PHOTO_EXTS.includes(currentFile.ext)
    const isVideo = VIDEO_EXTS.includes(currentFile.ext)
    const isHeic = currentFile.ext === '.heic'
    const isSel = selectedFiles.has(currentFile.path)
    const photoSrc = toFileUrl(currentFile.path)

    const S = {
      label: { fontSize: 10, color: '#5a5a72', textTransform: 'uppercase' as const, letterSpacing: '0.6px', marginBottom: 3 },
      value: { fontSize: 13, color: '#d0d0e0' },
    }

    const navBtnStyle: React.CSSProperties = {
      position: 'fixed', top: '50%', transform: 'translateY(-50%)',
      zIndex: 210, background: 'rgba(255,255,255,0.10)',
      border: '1px solid rgba(255,255,255,0.15)', borderRadius: '50%',
      width: 52, height: 52, color: '#fff', fontSize: 26, cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backdropFilter: 'blur(8px)', transition: 'background 0.15s',
    }

    return (
      <div
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.97)',
          zIndex: 200, display: 'flex', flexDirection: 'row', overflow: 'hidden',
        }}
        onClick={onClose}
      >
        {/* Left arrow */}
        {currentIdx > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); goPrev() }}
            style={{ ...navBtnStyle, left: 16 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.22)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.10)' }}
          >‹</button>
        )}

        {/* Right arrow */}
        {currentIdx < allFiles.length - 1 && (
          <button
            onClick={(e) => { e.stopPropagation(); goNext() }}
            style={{ ...navBtnStyle, right: 340 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.22)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.10)' }}
          >›</button>
        )}

        {/* Close */}
        <button
          onClick={(e) => { e.stopPropagation(); onClose() }}
          style={{
            position: 'fixed', top: 16, right: 16, zIndex: 210,
            background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: '50%', width: 44, height: 44, color: '#fff', fontSize: 18,
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            backdropFilter: 'blur(8px)',
          }}
        >✕</button>

        {/* Media area */}
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: '100%', overflow: 'hidden', minWidth: 0,
          }}
        >
          {isHeic ? (
            heicLoading ? (
              <div style={{ color: '#6c6cff', fontSize: 14 }}>Converting HEIC…</div>
            ) : heicSrc ? (
              <img
                src={heicSrc}
                style={{
                  maxWidth: 'calc(100vw - 340px)', maxHeight: '100vh',
                  objectFit: 'contain', borderRadius: 4, boxShadow: '0 24px 80px rgba(0,0,0,0.8)',
                }}
              />
            ) : (
              <div style={{ padding: '48px 64px', background: '#1a2a1a', borderRadius: 20, textAlign: 'center' }}>
                <div style={{ fontSize: 64, marginBottom: 12 }}>🍎</div>
                <div style={{ fontSize: 14, color: '#6a9a6a', marginBottom: 4 }}>HEIC file</div>
                <div style={{ fontSize: 12, color: '#4a6a4a' }}>Could not convert. Open in Photos app.</div>
              </div>
            )
          ) : isPhoto ? (
            imgError ? (
              <div style={{ padding: '48px 64px', background: '#1a1a2a', borderRadius: 20, textAlign: 'center' }}>
                <div style={{ fontSize: 64, marginBottom: 12 }}>🖼️</div>
                <div style={{ fontSize: 14, color: '#8080a0' }}>{currentFile.ext.toUpperCase()} — preview unavailable</div>
              </div>
            ) : (
              <img
                key={currentFile.path}
                src={photoSrc}
                style={{
                  maxWidth: 'calc(100vw - 340px)', maxHeight: '100vh',
                  objectFit: 'contain', borderRadius: 4, boxShadow: '0 24px 80px rgba(0,0,0,0.8)',
                }}
                onError={() => setImgError(true)}
              />
            )
          ) : isVideo ? (
            // FIX: autoPlay + controls + no preload=none — video actually plays now
            <video
              key={currentFile.path}
              src={toFileUrl(currentFile.path)}
              controls
              autoPlay
              preload="auto"
              style={{
                maxWidth: 'calc(100vw - 340px)', maxHeight: '100vh',
                borderRadius: 4, boxShadow: '0 24px 80px rgba(0,0,0,0.8)',
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <div style={{ padding: '48px 64px', background: '#1a1a2a', borderRadius: 20, textAlign: 'center' }}>
              <div style={{ fontSize: 64, marginBottom: 12 }}>📄</div>
              <div style={{ fontSize: 14, color: '#8080a0' }}>{currentFile.ext.toUpperCase()} file</div>
            </div>
          )}
        </div>

        {/* Info sidebar */}
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            width: 320, minWidth: 320, height: '100%',
            background: 'rgba(14,14,20,0.98)', borderLeft: '0.5px solid rgba(255,255,255,0.07)',
            display: 'flex', flexDirection: 'column', overflowY: 'auto',
            padding: '24px 20px', gap: 20,
          }}
        >
          <div style={{ fontSize: 11, color: '#44444e', marginTop: 32 }}>
            {currentIdx + 1} / {allFiles.length}
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#f0f0f2', wordBreak: 'break-word', lineHeight: 1.4 }}>
            {currentFile.name}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {([
              ['Date', formatDate(currentFile.date)],
              ['Time', formatTime(currentFile.date)],
              ['Size', formatSize(currentFile.size)],
              ['Format', currentFile.ext.slice(1).toUpperCase()],
            ] as [string, string][]).map(([label, value]) => (
              <div key={label}>
                <div style={S.label}>{label}</div>
                <div style={S.value}>{value}</div>
              </div>
            ))}
            <div style={{ gridColumn: '1/-1' }}>
              <div style={S.label}>Path</div>
              <div style={{ fontSize: 11, color: '#5050a0', wordBreak: 'break-all', lineHeight: 1.5 }}>
                {currentFile.path}
              </div>
            </div>
            {currentFile.lat && currentFile.lng && (
              <div style={{ gridColumn: '1/-1' }}>
                <div style={S.label}>Location</div>
                <div style={{ fontSize: 13, color: '#4cd97b' }}>
                  📍 {currentFile.lat.toFixed(4)}, {currentFile.lng.toFixed(4)}
                </div>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 'auto' }}>
            <button
              onClick={() => onSelect(currentFile.path, { stopPropagation: () => {} } as React.MouseEvent)}
              style={{
                padding: 10, borderRadius: 10, background: isSel ? '#2a2a4a' : '#1e1e2e',
                border: `0.5px solid ${isSel ? '#6c6cff' : '#3a3a5a'}`,
                textAlign: 'center', cursor: 'pointer', fontSize: 12,
                color: isSel ? '#a0a0ff' : '#8080c0', width: '100%',
              }}
            >
              {isSel ? '✓ Selected' : '○ Select'}
            </button>
            <button style={{
              padding: 10, borderRadius: 10, background: '#1e1e2e',
              border: '0.5px solid #3a3a5a', textAlign: 'center', cursor: 'pointer',
              fontSize: 12, color: '#8080c0', width: '100%',
            }}>Share</button>
          </div>
          <div style={{ fontSize: 10, color: '#333340', textAlign: 'center', paddingBottom: 8 }}>
            ← → arrow keys to navigate · Esc to close
          </div>
        </div>
      </div>
    )
  },
)
Viewer.displayName = 'Viewer'

// ─────────────────────────────────────────────
// Main App
// ─────────────────────────────────────────────
export default function App(): React.JSX.Element {
  const [activeNav, setActiveNav] = useState('all')
  const [drives, setDrives] = useState<DriveInfo[]>([])
  const [selectedDrive, setSelectedDrive] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanCount, setScanCount] = useState(0)
  const [groupedFiles, setGroupedFiles] = useState<Record<string, ScannedFile[]>>({})
  const [cachedDrives, setCachedDrives] = useState<Set<string>>(new Set())
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [viewerFile, setViewerFile] = useState<ScannedFile | null>(null)
  const [duplicates, setDuplicates] = useState<ScannedFile[][]>([])
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const initialized = useRef(false)

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    window.api.getDrives()
    window.api.onDrivesUpdated((u) => setDrives(u as DriveInfo[]))
    window.api.onScanProgress((d) => setScanCount((d as { count: number }).count))
    window.api.onScanComplete((d) => {
      const data = d as { count: number; drive: string }
      setScanning(false)
      setScanCount(data.count)
      setCachedDrives((prev) => new Set([...prev, data.drive]))
      window.api.getFiles(data.drive)
    })
    window.api.onFilesUpdated((g) => {
      const grouped = g as Record<string, ScannedFile[]>
      setGroupedFiles(grouped)
      const seen = new Map<string, ScannedFile[]>()
      for (const files of Object.values(grouped)) {
        for (const f of files) {
          const key = `${f.name}__${f.size}`
          if (!seen.has(key)) seen.set(key, [])
          seen.get(key)!.push(f)
        }
      }
      setDuplicates([...seen.values()].filter((arr) => arr.length > 1))
    })
  }, [])

  const handleDriveClick = useCallback((name: string): void => {
    setSelectedDrive(name)
    setGroupedFiles({})
    setSelectedFiles(new Set())
    setDuplicates([])
    if (cachedDrives.has(name)) {
      setScanning(false)
      window.api.getFiles(name)
    } else {
      setScanning(true)
      setScanCount(0)
      window.api.scanDrive(name)
    }
  }, [cachedDrives])

  const handleRescan = useCallback((name: string, e: React.MouseEvent): void => {
    e.stopPropagation()
    setCachedDrives((prev) => {
      const n = new Set(prev)
      n.delete(name)
      return n
    })
    setSelectedDrive(name)
    setScanning(true)
    setScanCount(0)
    setGroupedFiles({})
    setDuplicates([])
    window.api.rescanDrive(name)
  }, [])

  const toggleSelect = useCallback((path: string, e: React.MouseEvent): void => {
    e.stopPropagation()
    setSelectedFiles((prev) => {
      const n = new Set(prev)
      n.has(path) ? n.delete(path) : n.add(path)
      return n
    })
  }, [])

  const openViewer = useCallback((file: ScannedFile): void => setViewerFile(file), [])

  const getFilteredFiles = useCallback((files: ScannedFile[]): ScannedFile[] => {
    if (!files) return []
    if (activeNav === 'photos') return files.filter((f) => PHOTO_EXTS.includes(f.ext))
    if (activeNav === 'videos') return files.filter((f) => VIDEO_EXTS.includes(f.ext))
    if (activeNav === 'docs') return files.filter((f) => DOC_EXTS.includes(f.ext))
    return files
  }, [activeNav])

  const months = useMemo(
    () => Object.keys(groupedFiles).sort((a, b) => b.localeCompare(a)),
    [groupedFiles],
  )

  const totalFiles = useMemo(() => {
    let count = 0
    for (const files of Object.values(groupedFiles)) count += files.length
    return count
  }, [groupedFiles])

  // Flat list for viewer navigation — only rebuilt when deps actually change
  const allVisibleFiles = useMemo((): ScannedFile[] => {
    if (activeNav === 'dupes') return duplicates.flat()
    const result: ScannedFile[] = []
    for (const monthKey of months) {
      const files = groupedFiles[monthKey]
      if (files) for (const f of getFilteredFiles(files)) result.push(f)
    }
    return result
  }, [months, groupedFiles, getFilteredFiles, activeNav, duplicates])

  const noResults =
    !scanning &&
    selectedDrive &&
    months.length > 0 &&
    months.every((k) => getFilteredFiles(groupedFiles[k]).length === 0)

  const navItems = [
    { id: 'all', label: 'All files', emoji: '🗂️' },
    { id: 'photos', label: 'Photos', emoji: '🖼️' },
    { id: 'videos', label: 'Videos', emoji: '🎬' },
    { id: 'docs', label: 'Documents', emoji: '📄' },
    ...(duplicates.length > 0 ? [{ id: 'dupes', label: 'Duplicates', emoji: '⚠️' }] : []),
  ]

  return (
    // Root: fill the full Electron window content area (below OS titlebar)
    <div style={{
      display: 'flex', width: '100%', height: '100%',
      background: '#0f0f10', color: '#e8e8ea',
      fontFamily: 'system-ui,-apple-system,sans-serif',
      fontSize: 13, overflow: 'hidden',
    }}>
      {/* ── Sidebar ── */}
      <div style={{
        width: sidebarOpen ? 230 : 0,
        minWidth: sidebarOpen ? 230 : 0,
        height: '100%',
        background: '#161618',
        borderRight: '0.5px solid #2a2a2e',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        overflowX: 'hidden',
        flexShrink: 0,
        transition: 'width 0.2s ease, min-width 0.2s ease',
      }}>
        {/* Logo */}
        <div style={{ padding: '18px 16px 12px', borderBottom: '0.5px solid #2a2a2e', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 600, color: '#f0f0f2', letterSpacing: '-0.3px' }}>DiskFrame</div>
              <div style={{ fontSize: 11, color: '#5a5a62', marginTop: 2 }}>Smart file organiser</div>
            </div>
          </div>
        </div>

        {/* Drives */}
        <div style={{ padding: '10px 0 4px', flexShrink: 0 }}>
          <div style={{
            fontSize: 10, color: '#44444e', textTransform: 'uppercase',
            letterSpacing: '0.8px', padding: '0 14px', marginBottom: 6,
          }}>Drives</div>
          {drives.length === 0 ? (
            <div style={{ margin: '8px 14px', fontSize: 11, color: '#5a5a62' }}>Detecting...</div>
          ) : (
            drives.map((drive, i) => {
              const pct = drive.total > 0 ? Math.round((drive.used / drive.total) * 100) : 0
              const isSel = selectedDrive === drive.name
              const isCached = cachedDrives.has(drive.name)
              return (
                <div
                  key={i}
                  onClick={() => handleDriveClick(drive.name)}
                  style={{
                    margin: '4px 10px', borderRadius: 10, padding: '10px 12px',
                    background: isSel ? '#22223a' : '#1e1e22',
                    border: `0.5px solid ${isSel ? '#4040a0' : '#2e2e36'}`,
                    cursor: 'pointer', transition: 'background 0.15s',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 16 }}>{getDriveIcon(drive.name)}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#d0d0e0' }}>{getDriveLabel(drive.name)}</div>
                      <div style={{ fontSize: 10, color: '#5a5a72' }}>{drive.name} · {drive.free} GB free</div>
                    </div>
                    {isCached && (
                      <span
                        onClick={(e) => handleRescan(drive.name, e)}
                        title="Rescan"
                        style={{ fontSize: 14, color: '#5a5a80', cursor: 'pointer' }}
                      >↺</span>
                    )}
                  </div>
                  <div style={{ height: 3, background: '#2a2a2e', borderRadius: 2, marginTop: 8 }}>
                    <div style={{
                      height: '100%', width: `${pct}%`,
                      background: isCached ? '#4cd97b' : '#6c6cff',
                      borderRadius: 2, transition: 'width 0.3s',
                    }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                    <span style={{ fontSize: 10, color: '#44444e' }}>{drive.used} GB used</span>
                    <span style={{ fontSize: 10, color: '#44444e' }}>{drive.total} GB</span>
                  </div>
                  {isSel && (
                    <div style={{ fontSize: 10, color: isCached ? '#4cd97b' : '#6c6cff', marginTop: 4, fontWeight: 500 }}>
                      {scanning ? `⏳ Scanning... ${scanCount}` : `✓ ${scanCount} files${isCached ? ' · cached' : ''}`}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* Nav */}
        <div style={{ padding: '8px 10px 4px', borderTop: '0.5px solid #1e1e22', flexShrink: 0 }}>
          <div style={{
            fontSize: 10, color: '#44444e', textTransform: 'uppercase',
            letterSpacing: '0.8px', padding: '0 4px', marginBottom: 6,
          }}>Browse</div>
          {navItems.map((item) => (
            <div
              key={item.id}
              onClick={() => setActiveNav(item.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px',
                borderRadius: 7, cursor: 'pointer',
                color: activeNav === item.id ? '#e8e8f4' : '#9090a0',
                background: activeNav === item.id ? '#252530' : 'transparent',
                marginBottom: 2, transition: 'background 0.1s',
              }}
            >
              <span>{item.emoji}</span>
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.id === 'dupes' && (
                <span style={{
                  fontSize: 10, background: '#3a1a1a', color: '#ff8080',
                  borderRadius: 4, padding: '1px 5px',
                }}>{duplicates.length}</span>
              )}
            </div>
          ))}
        </div>

        {selectedFiles.size > 0 && (
          <div style={{
            margin: '8px 10px', padding: '10px 12px',
            background: '#2a1a1a', borderRadius: 10,
            border: '0.5px solid #4a2a2a', flexShrink: 0,
          }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#ff8080', marginBottom: 6 }}>
              {selectedFiles.size} selected
            </div>
            <div
              onClick={() => setSelectedFiles(new Set())}
              style={{ fontSize: 11, color: '#9090a0', cursor: 'pointer' }}
            >✕ Clear</div>
          </div>
        )}
      </div>

      {/* ── Main content ── */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        height: '100%', overflow: 'hidden', minWidth: 0,
      }}>
        {/* Top bar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px',
          borderBottom: '0.5px solid #2a2a2e', background: '#0f0f10', flexShrink: 0,
        }}>
          {/* Sidebar toggle */}
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
            style={{
              background: 'none', border: 'none', color: '#6060a0',
              fontSize: 18, cursor: 'pointer', padding: '2px 6px', flexShrink: 0,
            }}
          >☰</button>

          <div style={{
            flex: 1, fontSize: 13, color: '#6060a0',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {selectedDrive ? (
              <>
                <span style={{ color: '#e8e8f4' }}>{getDriveIcon(selectedDrive)} {getDriveLabel(selectedDrive)}</span>
                {' › '}
                <span style={{ color: '#8080c0' }}>{activeNav}</span>
              </>
            ) : 'Select a drive to scan'}
          </div>

          <div style={{
            display: 'flex', gap: 2, background: '#1a1a1e',
            borderRadius: 7, padding: 2, flexShrink: 0,
          }}>
            {['Grid', 'Timeline', 'Map'].map((v) => (
              <div key={v} style={{
                padding: '4px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 11,
                background: v === 'Grid' ? '#252530' : 'transparent',
                color: v === 'Grid' ? '#c0c0e0' : '#5a5a70',
              }}>{v}</div>
            ))}
          </div>
          <div style={{
            fontSize: 11, color: '#5a5a70', background: '#1a1a1e',
            border: '0.5px solid #2a2a2e', borderRadius: 6, padding: '4px 10px', flexShrink: 0,
          }}>Sort: Date ↓</div>
        </div>

        {/* Scroll area */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', minHeight: 0 }}>

          {/* Empty state */}
          {!selectedDrive && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>💾</div>
              <div style={{ fontSize: 15, fontWeight: 500, color: '#6060a0', marginBottom: 6 }}>Click a drive to scan it</div>
              <div style={{ fontSize: 12, color: '#44444e' }}>DiskFrame reads EXIF data and organises by date</div>
            </div>
          )}

          {/* Scanning */}
          {scanning && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
              <div style={{ fontSize: 15, fontWeight: 500, color: '#6c6cff', marginBottom: 8 }}>Scanning {selectedDrive}...</div>
              <div style={{ fontSize: 12, color: '#5a5a72', marginBottom: 16 }}>{scanCount} files found</div>
              <div style={{ width: 240, height: 3, background: '#2a2a2e', borderRadius: 2 }}>
                <div style={{ height: '100%', width: '60%', background: '#6c6cff', borderRadius: 2 }} />
              </div>
            </div>
          )}

          {/* Duplicates */}
          {!scanning && activeNav === 'dupes' && (
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#ff8080', marginBottom: 16 }}>
                ⚠️ {duplicates.length} duplicate groups found
              </div>
              {duplicates.map((group, gi) => (
                <div key={gi} style={{
                  marginBottom: 16, background: '#1a1a22', borderRadius: 12,
                  overflow: 'hidden', border: '0.5px solid #2e2e3e',
                }}>
                  <div style={{
                    padding: '10px 14px', background: '#1e1e2e',
                    borderBottom: '0.5px solid #2a2a3a', fontSize: 11, color: '#8080a0',
                  }}>
                    {group[0].name} · {formatSize(group[0].size)} · {group.length} copies
                  </div>
                  {group.map((file, fi) => (
                    <div
                      key={fi}
                      onClick={() => setViewerFile(file)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        padding: '8px 14px', cursor: 'pointer',
                        borderBottom: fi < group.length - 1 ? '0.5px solid #1e1e2e' : 'none',
                      }}
                    >
                      <div
                        onClick={(e) => toggleSelect(file.path, e)}
                        style={{
                          width: 18, height: 18, borderRadius: '50%',
                          border: `1.5px solid ${selectedFiles.has(file.path) ? '#6c6cff' : '#44444e'}`,
                          background: selectedFiles.has(file.path) ? '#6c6cff' : 'transparent',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                        }}
                      >
                        {selectedFiles.has(file.path) && <span style={{ fontSize: 10, color: '#fff' }}>✓</span>}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 11, color: '#c0c0d0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {file.path}
                        </div>
                        <div style={{ fontSize: 10, color: '#5a5a72', marginTop: 2 }}>{formatDate(file.date)}</div>
                      </div>
                      {fi === 0 && (
                        <span style={{
                          fontSize: 10, color: '#4cd97b', background: 'rgba(76,217,123,0.1)',
                          borderRadius: 4, padding: '2px 6px', flexShrink: 0,
                        }}>original</span>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* No results */}
          {noResults && activeNav !== 'dupes' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60%' }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>🔍</div>
              <div style={{ fontSize: 13, color: '#5a5a72' }}>No {activeNav} found</div>
            </div>
          )}

          {/* Month sections */}
          {!scanning && selectedDrive && activeNav !== 'dupes' &&
            months.map((monthKey) => {
              const files = groupedFiles[monthKey]
              const filtered = getFilteredFiles(files)
              if (filtered.length === 0) return null
              const [year, month] = monthKey.split('-')
              return (
                <div key={monthKey} style={{ marginBottom: 32 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                    <div style={{ fontSize: 16, fontWeight: 600, color: '#e0e0f0' }}>{month} {year}</div>
                    <div style={{ fontSize: 11, color: '#44444e' }}>· {filtered.length} files</div>
                    <div style={{ flex: 1, height: '0.5px', background: '#1e1e24' }} />
                  </div>

                  {activeNav === 'docs' ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {filtered.map((file, i) => {
                        const isSel = selectedFiles.has(file.path)
                        return (
                          <div
                            key={i}
                            onClick={() => setViewerFile(file)}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px',
                              borderRadius: 8, background: isSel ? '#22223a' : '#1a1a22',
                              border: `0.5px solid ${isSel ? '#4040a0' : '#2a2a32'}`,
                              cursor: 'pointer', transition: 'background 0.1s',
                            }}
                          >
                            <div
                              onClick={(e) => toggleSelect(file.path, e)}
                              style={{
                                width: 18, height: 18, borderRadius: '50%',
                                border: `1.5px solid ${isSel ? '#6c6cff' : '#44444e'}`,
                                background: isSel ? '#6c6cff' : 'transparent',
                                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                              }}
                            >
                              {isSel && <span style={{ fontSize: 10, color: '#fff' }}>✓</span>}
                            </div>
                            <span style={{ fontSize: 18 }}>
                              {file.ext === '.pdf' ? '📕' : file.ext === '.py' ? '🐍' : '📄'}
                            </span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12, color: '#d0d0e0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {file.name}
                              </div>
                              <div style={{ fontSize: 10, color: '#5a5a72', marginTop: 2 }}>
                                {formatDate(file.date)} · {formatSize(file.size)}
                              </div>
                            </div>
                            <span style={{
                              fontSize: 10, color: '#44444e', background: '#2a2a3a',
                              padding: '2px 6px', borderRadius: 4, flexShrink: 0,
                            }}>{file.ext}</span>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <VirtualGrid
                      files={filtered}
                      selectedFiles={selectedFiles}
                      onSelect={toggleSelect}
                      onOpen={openViewer}
                    />
                  )}
                </div>
              )
            })
          }
        </div>

        {/* Status bar */}
        <div style={{
          borderTop: '0.5px solid #2a2a2e', padding: '8px 20px',
          display: 'flex', alignItems: 'center', gap: 16,
          background: '#0d0d0f', flexShrink: 0,
        }}>
          <div style={{ fontSize: 11, color: '#44444e' }}>
            <span style={{ color: '#8080a8' }}>{drives.length}</span> drives
          </div>
          <div style={{ fontSize: 11, color: '#44444e' }}>
            <span style={{ color: '#8080a8' }}>{totalFiles}</span> files
          </div>
          <div style={{ fontSize: 11, color: '#44444e' }}>
            <span style={{ color: '#8080a8' }}>{months.length}</span> months
          </div>
          {duplicates.length > 0 && (
            <div style={{ fontSize: 11, color: '#ff8080' }}>⚠️ {duplicates.length} dupes</div>
          )}
          {selectedFiles.size > 0 && (
            <div style={{ fontSize: 11, color: '#6c6cff' }}>{selectedFiles.size} selected</div>
          )}
          <div style={{
            marginLeft: 'auto', fontSize: 10, color: '#4cd97b',
            background: 'rgba(76,217,123,0.1)', border: '0.5px solid rgba(76,217,123,0.3)',
            borderRadius: 4, padding: '2px 8px',
          }}>● live</div>
        </div>
      </div>

      {/* ── Viewer ── */}
      {viewerFile && (
        <Viewer
          file={viewerFile}
          allFiles={allVisibleFiles}
          selectedFiles={selectedFiles}
          onClose={() => setViewerFile(null)}
          onSelect={toggleSelect}
        />
      )}
    </div>
  )
}