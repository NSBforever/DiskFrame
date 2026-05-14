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
  file,
  onOpen,
  onFav,
  isFav,
  isSelected,
  onSelect
}: {
  file: ScannedFile
  onOpen: (f: ScannedFile) => void
  onFav: (f: ScannedFile) => void
  isFav: boolean
  isSelected: boolean
  onSelect: (f: ScannedFile) => void
}): React.JSX.Element {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)
  const [hovered, setHovered] = useState(false)
  const isPhoto = photoExts.includes(file.ext)
  const isVideo = videoExts.includes(file.ext)
  const isDoc = docExts.includes(file.ext)
  const hasThumb = !!file.thumb

  // Use thumb as a key on the img elements instead of syncing state in an effect
  const imgKey = file.thumb ?? 'no-thumb'

  return (
    <div
      onClick={() => onOpen(file)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        borderRadius: '12px',
        aspectRatio: '1',
        cursor: 'pointer',
        overflow: 'hidden',
        background: '#141420',
        position: 'relative',
        border: `1px solid ${isSelected ? '#6c6cff' : hovered ? '#4a4a7a' : '#1e1e2a'}`,
        outline: isSelected ? '2px solid #6c6cff' : 'none',
        outlineOffset: '2px',
        transform: hovered ? 'scale(1.03) translateY(-4px)' : 'scale(1) translateY(0)',
        boxShadow: hovered
          ? '0 16px 32px rgba(108, 108, 255, 0.15), 0 8px 16px rgba(0,0,0,0.4)'
          : '0 2px 8px rgba(0,0,0,0.1)',
        transition: 'all 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
        zIndex: hovered ? 2 : 1
      }}
    >
      {/* Photo tile */}
      {isPhoto && !error ? (
        <>
          {!loaded && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                background: '#141420',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <div
                style={{
                  width: '18px',
                  height: '18px',
                  border: '1.5px solid #2a2a3a',
                  borderTop: '1.5px solid #6c6cff',
                  borderRadius: '50%',
                  animation: 'tileSpin 0.8s linear infinite'
                }}
              />
            </div>
          )}
          <img
            key={imgKey}
            src={thumbUrl(file)}
            loading="lazy"
            decoding="async"
            onLoad={() => setLoaded(true)}
            onError={() => {
              console.error('Image Error [Photo]:', file.path, thumbUrl(file))
              setError(true)
              setLoaded(true)
            }}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: loaded ? 'block' : 'none',
              transform: hovered ? 'scale(1.08)' : 'scale(1)',
              transition: 'transform 0.5s cubic-bezier(0.16, 1, 0.3, 1)',
              willChange: 'transform'
            }}
          />
        </>
      ) : isVideo ? (
        <>
          {/* Show video thumb if available, else emoji fallback */}
          {hasThumb && !error ? (
            <>
              {!loaded && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: '#1a1020',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                >
                  <div
                    style={{
                      width: '18px',
                      height: '18px',
                      border: '1.5px solid #2a2a3a',
                      borderTop: '1.5px solid #a060ff',
                      borderRadius: '50%',
                      animation: 'tileSpin 0.8s linear infinite'
                    }}
                  />
                </div>
              )}
              <img
                key={imgKey}
                src={thumbUrl(file)}
                loading="lazy"
                decoding="async"
                onLoad={() => {
                  console.log('Loaded Video Thumb:', file.path)
                  setLoaded(true)
                }}
                onError={() => {
                  console.error('Image Error [Video]:', file.path, thumbUrl(file))
                  setError(true)
                  setLoaded(true)
                }}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  display: loaded ? 'block' : 'none',
                  transform: hovered ? 'scale(1.08)' : 'scale(1)',
                  transition: 'transform 0.5s cubic-bezier(0.16, 1, 0.3, 1)',
                  willChange: 'transform'
                }}
              />
              {/* Play overlay */}
              {loaded && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'rgba(0,0,0,0.25)'
                  }}
                >
                  <div
                    style={{
                      width: '28px',
                      height: '28px',
                      borderRadius: '50%',
                      background: 'rgba(0,0,0,0.6)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '12px'
                    }}
                  >
                    ▶
                  </div>
                </div>
              )}
            </>
          ) : (
            <div
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '4px',
                background: '#1a1020'
              }}
            >
              <div style={{ fontSize: '28px' }}>🎬</div>
              <div style={{ fontSize: '9px', color: '#7070a0' }}>{file.ext}</div>
              <div
                style={{
                  fontSize: '8px',
                  color: '#44444e',
                  maxWidth: '90%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {file.name}
              </div>
            </div>
          )}
        </>
      ) : isDoc ? (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '4px',
            background: '#101a20'
          }}
        >
          <div style={{ fontSize: '28px' }}>{file.ext === '.pdf' ? '📕' : '📄'}</div>
          <div style={{ fontSize: '9px', color: '#7070a0' }}>{file.ext}</div>
          <div
            style={{
              fontSize: '8px',
              color: '#44444e',
              maxWidth: '90%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {file.name}
          </div>
        </div>
      ) : (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '4px'
          }}
        >
          <div style={{ fontSize: '28px' }}>🖼️</div>
          <div style={{ fontSize: '9px', color: '#44444e' }}>{file.ext}</div>
        </div>
      )}

      {/* Hover overlay with filename */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          padding: '24px 8px 6px',
          background:
            'linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.5) 40%, transparent 100%)',
          display: 'flex',
          alignItems: 'flex-end',
          opacity: hovered ? 1 : 0,
          transform: hovered ? 'translateY(0)' : 'translateY(10px)',
          transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
          pointerEvents: 'none'
        }}
      >
        <div
          style={{
            fontSize: '9px',
            fontWeight: 500,
            color: '#e8e8f4',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            width: '100%'
          }}
        >
          {file.name}
        </div>
      </div>

      {/* Select checkbox */}
      <div
        onClick={(e) => {
          e.stopPropagation()
          onSelect(file)
        }}
        style={{
          position: 'absolute',
          top: '5px',
          left: '5px',
          width: '18px',
          height: '18px',
          borderRadius: '4px',
          background: isSelected ? '#6c6cff' : 'rgba(0,0,0,0.6)',
          border: `1.5px solid ${isSelected ? '#6c6cff' : 'rgba(255,255,255,0.3)'}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '10px',
          cursor: 'pointer',
          color: '#fff',
          opacity: hovered || isSelected ? 1 : 0,
          transition: 'opacity 0.15s'
        }}
      >
        {isSelected ? '✓' : ''}
      </div>

      {/* Fav button */}
      <div
        onClick={(e) => {
          e.stopPropagation()
          onFav(file)
        }}
        style={{
          position: 'absolute',
          top: '5px',
          right: '5px',
          width: '22px',
          height: '22px',
          borderRadius: '50%',
          background: 'rgba(0,0,0,0.6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '11px',
          cursor: 'pointer',
          opacity: hovered || isFav ? 1 : 0,
          transition: 'opacity 0.15s'
        }}
      >
        {isFav ? '❤️' : '🤍'}
      </div>
    </div>
  )
}

function LightBox({
  file,
  onClose,
  onFav,
  isFav,
  onNext,
  onPrev,
  onReveal
}: {
  file: ScannedFile
  onClose: () => void
  onFav: (f: ScannedFile) => void
  isFav: boolean
  onNext: () => void
  onPrev: () => void
  onReveal: (f: ScannedFile) => void
}): React.JSX.Element {
  const isPhoto = photoExts.includes(file.ext)
  const isVideo = videoExts.includes(file.ext)
  const isPdf = file.ext === '.pdf'
  const [zoom, setZoom] = useState(1)
  const [imgError, setImgError] = useState(false)

  useEffect(() => {
    setZoom(1)
    setImgError(false)
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
    if (isPdf) {
      window.api.openFile(file.path)
      onClose()
    }
  }, [file.path, isPdf, onClose])

  const mediaSrc = toUrl(file.path)

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.96)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      {/* Prev/Next */}
      <div
        onClick={(e) => {
          e.stopPropagation()
          onPrev()
        }}
        style={{
          position: 'absolute',
          left: '16px',
          top: '50%',
          transform: 'translateY(-50%)',
          width: '44px',
          height: '44px',
          borderRadius: '50%',
          background: 'rgba(255,255,255,0.1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          fontSize: '22px',
          color: '#fff',
          zIndex: 10
        }}
      >
        ‹
      </div>
      <div
        onClick={(e) => {
          e.stopPropagation()
          onNext()
        }}
        style={{
          position: 'absolute',
          right: '16px',
          top: '50%',
          transform: 'translateY(-50%)',
          width: '44px',
          height: '44px',
          borderRadius: '50%',
          background: 'rgba(255,255,255,0.1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          fontSize: '22px',
          color: '#fff',
          zIndex: 10
        }}
      >
        ›
      </div>

      {/* Top bar */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.9), transparent)',
          zIndex: 10
        }}
      >
        <div
          style={{
            flex: 1,
            fontSize: '12px',
            color: '#c0c0d0',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {file.name}
        </div>
        {isPhoto && !imgError && (
          <>
            <div
              onClick={(e) => {
                e.stopPropagation()
                setZoom((z) => Math.min(z + 0.5, 4))
              }}
              style={{
                padding: '4px 10px',
                borderRadius: '6px',
                background: 'rgba(255,255,255,0.1)',
                cursor: 'pointer',
                fontSize: '14px',
                color: '#fff'
              }}
            >
              ＋
            </div>
            <div
              onClick={(e) => {
                e.stopPropagation()
                setZoom((z) => Math.max(z - 0.5, 0.5))
              }}
              style={{
                padding: '4px 10px',
                borderRadius: '6px',
                background: 'rgba(255,255,255,0.1)',
                cursor: 'pointer',
                fontSize: '14px',
                color: '#fff'
              }}
            >
              －
            </div>
            <div
              onClick={(e) => {
                e.stopPropagation()
                setZoom(1)
              }}
              style={{
                padding: '4px 10px',
                borderRadius: '6px',
                background: 'rgba(255,255,255,0.1)',
                cursor: 'pointer',
                fontSize: '11px',
                color: '#ccc'
              }}
            >
              Reset
            </div>
          </>
        )}
        <div
          onClick={(e) => {
            e.stopPropagation()
            onFav(file)
          }}
          style={{
            padding: '4px 10px',
            borderRadius: '6px',
            background: 'rgba(255,255,255,0.1)',
            cursor: 'pointer',
            fontSize: '16px'
          }}
        >
          {isFav ? '❤️' : '🤍'}
        </div>
        <div
          onClick={(e) => {
            e.stopPropagation()
            onReveal(file)
          }}
          style={{
            padding: '4px 10px',
            borderRadius: '6px',
            background: 'rgba(255,255,255,0.1)',
            cursor: 'pointer',
            fontSize: '11px',
            color: '#fff'
          }}
        >
          📁 Show in folder
        </div>
        <div
          onClick={onClose}
          style={{
            padding: '4px 10px',
            borderRadius: '6px',
            background: 'rgba(255,255,255,0.1)',
            cursor: 'pointer',
            fontSize: '14px',
            color: '#fff'
          }}
        >
          ✕
        </div>
      </div>

      {/* Media */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '90vw',
          maxHeight: '85vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'auto'
        }}
      >
        {isPhoto ? (
          imgError ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '12px'
              }}
            >
              <div style={{ fontSize: '48px' }}>🖼️</div>
              <div style={{ fontSize: '13px', color: '#6060a0' }}>Cannot preview this image</div>
              <div
                onClick={(e) => {
                  e.stopPropagation()
                  onReveal(file)
                }}
                style={{
                  padding: '8px 20px',
                  borderRadius: '8px',
                  background: '#252535',
                  cursor: 'pointer',
                  fontSize: '12px',
                  color: '#c0c0e0',
                  border: '0.5px solid #3a3a5a'
                }}
              >
                📁 Open file location
              </div>
            </div>
          ) : (
            <img
              key={file.path}
              src={mediaSrc}
              onError={() => setImgError(true)}
              style={{
                transform: `scale(${zoom})`,
                transformOrigin: 'center',
                maxWidth: '88vw',
                maxHeight: '83vh',
                objectFit: 'contain',
                display: 'block',
                transition: 'transform 0.2s'
              }}
            />
          )
        ) : isVideo ? (
          <video
            key={file.path}
            src={mediaSrc}
            controls
            autoPlay
            style={{
              maxWidth: '88vw',
              maxHeight: '83vh',
              borderRadius: '8px',
              background: '#000',
              display: 'block'
            }}
            onError={(e) => console.error('Video error', e)}
          />
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '16px',
              padding: '40px'
            }}
          >
            <div style={{ fontSize: '72px' }}>📄</div>
            <div style={{ fontSize: '14px', color: '#8080a0', textAlign: 'center' }}>
              {file.name}
            </div>
            <div
              onClick={(e) => {
                e.stopPropagation()
                onReveal(file)
              }}
              style={{
                padding: '8px 20px',
                borderRadius: '8px',
                background: '#252535',
                cursor: 'pointer',
                fontSize: '12px',
                color: '#c0c0e0',
                border: '0.5px solid #3a3a5a'
              }}
            >
              📁 Open file location
            </div>
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          padding: '12px 16px',
          background: 'linear-gradient(to top, rgba(0,0,0,0.9), transparent)',
          display: 'flex',
          gap: '16px',
          fontSize: '11px',
          color: '#6060a0'
        }}
      >
        <span>{file.date ? new Date(file.date).toLocaleDateString() : ''}</span>
        <span>{(file.size / 1024 / 1024).toFixed(1)} MB</span>
        <span
          style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {file.path}
        </span>
        {file.lat && file.lng && (
          <span>
            📍 {file.lat.toFixed(3)}, {file.lng.toFixed(3)}
          </span>
        )}
      </div>
    </div>
  )
}

function MapView({
  files,
  onOpen
}: {
  files: ScannedFile[]
  onOpen: (f: ScannedFile, list: ScannedFile[]) => void
}): React.JSX.Element {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<L.Map | null>(null)
  const geoFiles = files.filter((f) => f.lat && f.lng)

  useEffect(() => {
    if (!mapRef.current) return
    if (mapInstanceRef.current) {
      mapInstanceRef.current.remove()
      mapInstanceRef.current = null
    }

    const map = L.map(mapRef.current, { zoomControl: true, attributionControl: false }).setView(
      [20, 0],
      2
    )
    mapInstanceRef.current = map

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19
    }).addTo(map)

    // Group nearby files into clusters manually
    const grouped: Record<string, ScannedFile[]> = {}
    geoFiles.forEach((file) => {
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

      // Custom marker icon
      const iconHtml = hasThumb
        ? `<div style="width:44px;height:44px;border-radius:8px;overflow:hidden;border:2px solid #6c6cff;box-shadow:0 2px 8px rgba(0,0,0,0.5);position:relative;">
            <img src="media:///${first.thumb!.replace(/\\/g, '/')}" style="width:100%;height:100%;object-fit:cover;" />
            ${count > 1 ? `<div style="position:absolute;bottom:2px;right:2px;background:rgba(108,108,255,0.9);color:#fff;font-size:9px;font-weight:700;border-radius:3px;padding:1px 3px;">${count}</div>` : ''}
          </div>`
        : `<div style="width:36px;height:36px;border-radius:50%;background:#6c6cff;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700;">${count > 1 ? count : '📍'}</div>`

      const icon = L.divIcon({
        html: iconHtml,
        className: '',
        iconSize: hasThumb ? [44, 44] : [36, 36],
        iconAnchor: hasThumb ? [22, 44] : [18, 36]
      })
      const marker = L.marker([first.lat, first.lng], { icon })

      // Popup with thumbnail grid
      const thumbsHtml = clusterFiles
        .slice(0, 4)
        .map((f) => {
          const src = f.thumb ? `media:///${f.thumb.replace(/\\/g, '/')}` : ''
          return src
            ? `<img src="${src}" style="width:56px;height:56px;object-fit:cover;border-radius:4px;cursor:pointer;" />`
            : `<div style="width:56px;height:56px;background:#2a2a3a;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:18px;">${videoExts.includes(f.ext) ? '🎬' : '📄'}</div>`
        })
        .join('')

      marker.bindPopup(
        `
        <div style="font-size:12px;min-width:140px;font-family:system-ui,sans-serif;">
          <div style="font-weight:600;margin-bottom:6px;color:#e0e0f0;">${count} file${count > 1 ? 's' : ''}</div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;">${thumbsHtml}</div>
          <div style="font-size:10px;color:#8080a0;">${new Date(first.date).toLocaleDateString()}</div>
          ${count > 4 ? `<div style="font-size:10px;color:#6c6cff;margin-top:2px;">+${count - 4} more</div>` : ''}
        </div>
      `,
        { maxWidth: 200 }
      )

      marker.on('click', () => onOpen(first, clusterFiles))
      marker.addTo(map)
    })

    // Fit map to markers if we have any
    if (geoFiles.length > 0) {
      const lats = geoFiles.map((f) => f.lat!)
      const lngs = geoFiles.map((f) => f.lng!)
      const bounds = L.latLngBounds(
        [Math.min(...lats), Math.min(...lngs)],
        [Math.max(...lats), Math.max(...lngs)]
      )
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 })
    }

    return () => {
      map.remove()
      mapInstanceRef.current = null
    }
  }, [files, geoFiles, onOpen])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          marginBottom: '10px',
          fontSize: '12px',
          color: '#7070a0',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}
      >
        <span>📍 {geoFiles.length} files with GPS location</span>
        {geoFiles.length === 0 && (
          <span style={{ color: '#3a3a48' }}>
            — scan photos with location data to see them here
          </span>
        )}
      </div>
      {geoFiles.length === 0 ? (
        <div
          style={{
            flex: 1,
            background: '#141420',
            borderRadius: '12px',
            border: '0.5px solid #1e1e2a',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px'
          }}
        >
          <div style={{ fontSize: '48px' }}>🗺️</div>
          <div style={{ fontSize: '14px', color: '#5050a0' }}>No GPS data found</div>
          <div style={{ fontSize: '11px', color: '#3a3a48' }}>
            Photos with location info will appear here
          </div>
        </div>
      ) : (
        <div
          ref={mapRef}
          style={{ flex: 1, borderRadius: '12px', overflow: 'hidden', minHeight: '400px' }}
        />
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

  const [zoomLevel, setZoomLevel] = useState(1.0)
  const [transitioning, setTransitioning] = useState(false)
  const monthRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const lastCenteredMonth = useRef<string | null>(null)

  const getCenteredMonth = useCallback(() => {
    let closest = ''
    let minDiff = Infinity
    const center = window.innerHeight / 2
    for (const [key, el] of Object.entries(monthRefs.current)) {
      if (!el) continue
      const rect = el.getBoundingClientRect()
      const diff = Math.abs(rect.top - center)
      if (diff < minDiff) {
        minDiff = diff
        closest = key
      }
    }
    return closest
  }, [])

  useEffect(() => {
    const preventZoom = (e: WheelEvent): void => {
      if (e.ctrlKey) e.preventDefault()
    }
    window.addEventListener('wheel', preventZoom, { passive: false })
    return () => window.removeEventListener('wheel', preventZoom)
  }, [])

  useEffect(() => {
    if (
      !transitioning &&
      lastCenteredMonth.current &&
      monthRefs.current[lastCenteredMonth.current]
    ) {
      monthRefs.current[lastCenteredMonth.current]?.scrollIntoView({
        behavior: 'instant',
        block: 'start'
      })
      lastCenteredMonth.current = null
    }
  }, [activeView, transitioning])

  const handleWheel = (e: React.WheelEvent): void => {
    if (!e.ctrlKey) return
    const delta = e.deltaY > 0 ? 0.04 : -0.04
    const newZoom = Math.max(0.3, Math.min(1.0, zoomLevel - delta))
    setZoomLevel(newZoom)

    // Grid: zoom out → Timeline
    if (activeView === 'Grid' && newZoom < 0.55 && !transitioning) {
      lastCenteredMonth.current = getCenteredMonth()
      setTransitioning(true)
      setTimeout(() => {
        setActiveView('Timeline')
        setZoomLevel(1.0)
        setTransitioning(false)
      }, 300)
    }

    // Timeline: zoom IN only → Grid
    if (activeView === 'Timeline' && e.deltaY < 0 && newZoom > 0.85 && !transitioning) {
      lastCenteredMonth.current = getCenteredMonth()
      setTransitioning(true)
      setTimeout(() => {
        setActiveView('Grid')
        setZoomLevel(1.0)
        setTransitioning(false)
      }, 300)
    }
  }

  useEffect(() => {
    if (listenersSet.current) return
    listenersSet.current = true
    window.api.getDrives()
    window.api.onDrivesUpdated((d) => {
      const drives = d as DriveInfo[]
      setDrives(drives)
    })
    window.api.onScanProgress((d) => setScanCount(d.count))
    window.api.onScanComplete((d) => {
      setScanning(false)
      setScanCount(d.count)
      currentDriveRef.current = d.drive
      window.api.getFiles(d.drive)
    })
    window.api.onFilesUpdated((g) => {
      if (currentDriveRef.current) {
        setDriveFiles((prev) => ({
          ...prev,
          [currentDriveRef.current!]: g as Record<string, ScannedFile[]>
        }))
      }
    })
    window.api.onThumbReady(({ filePath, thumbPath }) => {
      setDriveFiles((prev) => {
        const updated = { ...prev }
        for (const drive in updated) {
          for (const month in updated[drive]) {
            updated[drive][month] = updated[drive][month].map((f) =>
              f.path === filePath ? { ...f, thumb: thumbPath } : f
            )
          }
        }
        return updated
      })
    })
    window.api.onFavouriteToggled((p) => {
      setFavourites((prev) => {
        const next = new Set(prev)
        if (next.has(p as string)) next.delete(p as string)
        else next.add(p as string)
        return next
      })
    })
  }, [])

  const handleDriveClick = (name: string): void => {
    setSelectedDrive(name)
    currentDriveRef.current = name
    setScanning(true)
    setScanCount(0)
    setActiveNav('all')
    setActiveView('Grid')
    setSelected(new Set())
    setVisibleCount({})
    window.api.scanDrive(name)
  }

  const handleRescan = (name: string): void => {
    setScanning(true)
    setScanCount(0)
    currentDriveRef.current = name
    setSelected(new Set())
    setVisibleCount({})
    window.electron.ipcRenderer.send('rescan-drive', name)
  }

  const handleFav = useCallback((file: ScannedFile): void => {
    window.api.toggleFavourite(file.path)
  }, [])

  const handleSelect = useCallback((file: ScannedFile): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(file.path)) next.delete(file.path)
      else next.add(file.path)
      return next
    })
  }, [])

  const handleReveal = useCallback((file: ScannedFile): void => {
    window.electron.ipcRenderer.send('reveal-file', file.path)
  }, [])

  const openLightbox = useCallback((file: ScannedFile, list: ScannedFile[]): void => {
    setLightbox({ file, list })
  }, [])

  const groupedFiles = selectedDrive && driveFiles[selectedDrive] ? driveFiles[selectedDrive] : {}
  const months = Object.keys(groupedFiles).sort((a, b) => b.localeCompare(a))

  const getFiltered = (files: ScannedFile[]): ScannedFile[] => {
    if (activeNav === 'photos') return files.filter((f) => photoExts.includes(f.ext))
    if (activeNav === 'videos') return files.filter((f) => videoExts.includes(f.ext))
    if (activeNav === 'docs') return files.filter((f) => docExts.includes(f.ext))
    return files
  }

  const allFiles = Object.values(groupedFiles).flat()
  const allFavFiles = allFiles.filter((f) => favourites.has(f.path))
  const totalFiles = allFiles.length
  const getVisible = (key: string): number => visibleCount[key] ?? 40

  return (
    <div
      style={{
        display: 'flex',
        width: '100vw',
        height: '100vh',
        background: '#0f0f10',
        color: '#e8e8ea',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '13px',
        overflow: 'hidden',
        position: 'fixed',
        inset: 0
      }}
    >
      <style>{`
        @keyframes tileSpin { to { transform: rotate(360deg); } }
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(250%); }
        }
        @keyframes slideOutLeft { from { opacity: 1; transform: translateX(0); } to { opacity: 0; transform: translateX(-50px); } }
        @keyframes slideInRight { from { opacity: 0; transform: translateX(50px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes slideOutRight { from { opacity: 1; transform: translateX(0); } to { opacity: 0; transform: translateX(50px); } }
        @keyframes slideInLeft { from { opacity: 0; transform: translateX(-50px); } to { opacity: 1; transform: translateX(0); } }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #2a2a3a; border-radius: 2px; }
        .leaflet-container { background: #141420 !important; }
        .leaflet-popup-content-wrapper { background: #1a1a2a !important; border: 0.5px solid #2a2a3a !important; color: #e0e0f0 !important; border-radius: 10px !important; box-shadow: 0 4px 20px rgba(0,0,0,0.5) !important; }
        .leaflet-popup-tip { background: #1a1a2a !important; }
        .leaflet-popup-close-button { color: #7070a0 !important; }
      `}</style>

      {/* Sidebar */}
      <div
        style={{
          width: '220px',
          minWidth: '220px',
          background: '#161618',
          borderRight: '0.5px solid #2a2a2e',
          display: 'flex',
          flexDirection: 'column',
          height: '100vh',
          overflowY: 'auto'
        }}
      >
        <div style={{ padding: '18px 16px 12px', borderBottom: '0.5px solid #2a2a2e' }}>
          <div
            style={{ fontSize: '16px', fontWeight: 600, color: '#f0f0f2', letterSpacing: '-0.3px' }}
          >
            DiskFrame
          </div>
          <div style={{ fontSize: '11px', color: '#5a5a62', marginTop: '2px' }}>
            Smart file organiser
          </div>
        </div>

        {drives.map((drive) => {
          const pct = drive.total > 0 ? Math.round((drive.used / drive.total) * 100) : 0
          const sel = selectedDrive === drive.name
          return (
            <div
              key={drive.name}
              onClick={() => handleDriveClick(drive.name)}
              style={{
                margin: '8px 10px',
                background: sel ? '#1e1e32' : '#1a1a1e',
                borderRadius: '10px',
                padding: '10px 12px',
                border: `0.5px solid ${sel ? '#3a3a6a' : '#242428'}`,
                cursor: 'pointer'
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '12px',
                  fontWeight: 500,
                  color: '#c8c8d0'
                }}
              >
                <div
                  style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    background: '#4cd97b'
                  }}
                />
                {drive.name}
              </div>
              <div style={{ fontSize: '10px', color: '#5a5a62', marginTop: '3px' }}>
                {drive.total} GB · {drive.free} GB free
              </div>
              <div
                style={{
                  height: '2px',
                  background: '#222228',
                  borderRadius: '2px',
                  marginTop: '7px'
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${pct}%`,
                    background: '#6c6cff',
                    borderRadius: '2px'
                  }}
                />
              </div>
              {sel && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginTop: '5px'
                  }}
                >
                  <div style={{ fontSize: '10px', color: '#6c6cff' }}>
                    {scanning ? `Scanning... ${scanCount}` : `${scanCount} files`}
                  </div>
                  {!scanning && scanCount > 0 && (
                    <div
                      onClick={(e) => {
                        e.stopPropagation()
                        handleRescan(drive.name)
                      }}
                      style={{
                        fontSize: '10px',
                        color: '#4cd97b',
                        cursor: 'pointer',
                        padding: '1px 5px',
                        borderRadius: '3px',
                        background: 'rgba(76,217,123,0.1)'
                      }}
                    >
                      ↺ Rescan
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}

        <div style={{ padding: '12px 10px 4px' }}>
          <div
            style={{
              fontSize: '10px',
              color: '#3a3a48',
              textTransform: 'uppercase',
              letterSpacing: '0.8px',
              padding: '0 4px',
              marginBottom: '4px'
            }}
          >
            Browse
          </div>
          {[
            { id: 'all', label: 'All files', icon: '🗂️', count: allFiles.length },
            {
              id: 'photos',
              label: 'Photos',
              icon: '🖼️',
              count: allFiles.filter((f) => photoExts.includes(f.ext)).length
            },
            {
              id: 'videos',
              label: 'Videos',
              icon: '🎬',
              count: allFiles.filter((f) => videoExts.includes(f.ext)).length
            },
            {
              id: 'docs',
              label: 'Documents',
              icon: '📄',
              count: allFiles.filter((f) => docExts.includes(f.ext)).length
            },
            { id: 'favourites', label: 'Favourites', icon: '❤️', count: allFavFiles.length }
          ].map((item) => (
            <div
              key={item.id}
              onClick={() => setActiveNav(item.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '6px 8px',
                borderRadius: '7px',
                cursor: 'pointer',
                color: activeNav === item.id ? '#e8e8f4' : '#7070a0',
                background: activeNav === item.id ? '#1e1e30' : 'transparent',
                marginBottom: '1px'
              }}
            >
              <span style={{ fontSize: '13px' }}>{item.icon}</span>
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.count > 0 && (
                <span
                  style={{
                    fontSize: '10px',
                    color: '#5050a0',
                    background: '#1a1a2e',
                    borderRadius: '4px',
                    padding: '1px 5px'
                  }}
                >
                  {item.count}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Main */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          height: '100vh',
          overflow: 'hidden',
          minWidth: 0
        }}
      >
        {/* Topbar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '10px 18px',
            borderBottom: '0.5px solid #1e1e24',
            background: '#0f0f10',
            flexShrink: 0
          }}
        >
          <div style={{ flex: 1, fontSize: '13px', color: '#5050a0' }}>
            {selectedDrive ? (
              <>
                <span style={{ color: '#d0d0e8' }}>{selectedDrive}</span> ›{' '}
                <span style={{ color: '#7070c0' }}>{activeNav}</span>
              </>
            ) : (
              'Select a drive'
            )}
          </div>
          {selected.size > 0 && (
            <div
              style={{
                fontSize: '11px',
                color: '#e8e8f4',
                background: '#252535',
                border: '0.5px solid #3a3a5a',
                borderRadius: '6px',
                padding: '4px 12px'
              }}
            >
              {selected.size} selected
              <span
                onClick={() => setSelected(new Set())}
                style={{ marginLeft: '8px', cursor: 'pointer', color: '#7070a0' }}
              >
                ✕
              </span>
            </div>
          )}
          <div
            style={{
              display: 'flex',
              gap: '1px',
              background: '#161618',
              borderRadius: '7px',
              padding: '2px',
              border: '0.5px solid #2a2a2e'
            }}
          >
            {['Grid', 'Timeline', 'Map'].map((v) => (
              <div
                key={v}
                onClick={() => setActiveView(v)}
                style={{
                  padding: '4px 10px',
                  borderRadius: '5px',
                  cursor: 'pointer',
                  fontSize: '11px',
                  background: activeView === v ? '#252535' : 'transparent',
                  color: activeView === v ? '#c0c0e8' : '#5a5a70'
                }}
              >
                {v}
              </div>
            ))}
          </div>
        </div>

        <div
          style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '18px 20px' }}
          onWheel={handleWheel}
        >
          {/* Empty state */}
          {!selectedDrive && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                gap: '10px'
              }}
            >
              <div style={{ fontSize: '48px' }}>💾</div>
              <div style={{ fontSize: '14px', color: '#5050a0' }}>Click a drive to scan</div>
              <div style={{ fontSize: '11px', color: '#3a3a48' }}>
                DiskFrame reads EXIF and organises by date
              </div>
            </div>
          )}

          {/* Scanning progress */}
          {scanning && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                gap: '12px'
              }}
            >
              <div style={{ fontSize: '14px', color: '#6c6cff' }}>Scanning {selectedDrive}...</div>
              <div style={{ fontSize: '12px', color: '#5a5a72' }}>{scanCount} files found</div>
              <div
                style={{
                  width: '220px',
                  height: '3px',
                  background: '#1e1e2a',
                  borderRadius: '2px',
                  overflow: 'hidden'
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: '45%',
                    background: 'linear-gradient(90deg, transparent, #6c6cff, transparent)',
                    borderRadius: '2px',
                    animation: 'shimmer 1.4s ease-in-out infinite'
                  }}
                />
              </div>
            </div>
          )}

          {/* Favourites */}
          {!scanning && activeNav === 'favourites' && (
            <div>
              <div
                style={{
                  fontSize: '15px',
                  fontWeight: 600,
                  color: '#e0e0f0',
                  marginBottom: '16px'
                }}
              >
                ❤️ Favourites · {allFavFiles.length} files
              </div>
              {allFavFiles.length === 0 ? (
                <div style={{ color: '#3a3a48', fontSize: '13px' }}>
                  No favourites yet — hover a tile and tap 🤍 to add.
                </div>
              ) : (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
                    gap: '5px'
                  }}
                >
                  {allFavFiles.map((file) => (
                    <FileTile
                      key={file.path}
                      file={file}
                      onOpen={(f) => openLightbox(f, allFavFiles)}
                      onFav={handleFav}
                      isFav={true}
                      isSelected={selected.has(file.path)}
                      onSelect={handleSelect}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Map */}
          {!scanning && activeView === 'Map' && (
            <div style={{ height: 'calc(100vh - 120px)' }}>
              <MapView files={allFiles} onOpen={openLightbox} />
            </div>
          )}

          {/* Timeline and Grid Views */}
          {!scanning &&
            activeNav !== 'favourites' &&
            (activeView === 'Grid' || activeView === 'Timeline') && (
              <div
                style={{
                  animation:
                    transitioning && activeView === 'Grid'
                      ? 'slideOutLeft 0.3s forwards'
                      : transitioning && activeView === 'Timeline'
                        ? 'slideOutRight 0.3s forwards'
                        : activeView === 'Timeline'
                          ? 'slideInRight 0.3s forwards'
                          : 'slideInLeft 0.3s forwards'
                }}
              >
                <div
                  style={{
                    transform: `scale(${zoomLevel})`,
                    transformOrigin: 'top center',
                    transition: transitioning ? 'none' : 'transform 0.1s ease-out'
                  }}
                >
                  {activeView === 'Timeline' && (
                    <div style={{ paddingLeft: '24px', borderLeft: '1px solid #1e1e2a' }}>
                      {months.map((monthKey) => {
                        const files = getFiltered(groupedFiles[monthKey] || [])
                        if (files.length === 0) return null
                        const [year, month] = monthKey.split('-')
                        return (
                          <div
                            key={monthKey}
                            ref={(el) => {
                              monthRefs.current[monthKey] = el
                            }}
                            style={{ marginBottom: '28px', position: 'relative' }}
                          >
                            <div
                              style={{
                                position: 'absolute',
                                left: '-28px',
                                top: '4px',
                                width: '8px',
                                height: '8px',
                                borderRadius: '50%',
                                background: '#6c6cff',
                                border: '2px solid #0f0f10'
                              }}
                            />
                            <div
                              style={{
                                fontSize: '13px',
                                fontWeight: 600,
                                color: '#c0c0e0',
                                marginBottom: '8px'
                              }}
                            >
                              {month} {year}{' '}
                              <span style={{ fontWeight: 400, fontSize: '11px', color: '#44444e' }}>
                                · {files.length} files
                              </span>
                            </div>
                            <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                              {files.slice(0, 12).map((file) => (
                                <div
                                  key={file.path}
                                  onClick={() => openLightbox(file, files)}
                                  style={{
                                    width: '80px',
                                    height: '80px',
                                    borderRadius: '6px',
                                    overflow: 'hidden',
                                    cursor: 'pointer',
                                    background: '#141420',
                                    position: 'relative'
                                  }}
                                >
                                  {photoExts.includes(file.ext) ||
                                  (videoExts.includes(file.ext) && file.thumb) ? (
                                    <>
                                      <img
                                        src={thumbUrl(file)}
                                        loading="lazy"
                                        decoding="async"
                                        style={{
                                          width: '100%',
                                          height: '100%',
                                          objectFit: 'cover'
                                        }}
                                      />
                                      {videoExts.includes(file.ext) && (
                                        <div
                                          style={{
                                            position: 'absolute',
                                            inset: 0,
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            background: 'rgba(0,0,0,0.3)'
                                          }}
                                        >
                                          <div style={{ fontSize: '18px' }}>▶</div>
                                        </div>
                                      )}
                                    </>
                                  ) : (
                                    <div
                                      style={{
                                        width: '100%',
                                        height: '100%',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        fontSize: '24px'
                                      }}
                                    >
                                      {videoExts.includes(file.ext) ? '🎬' : '📄'}
                                    </div>
                                  )}
                                </div>
                              ))}
                              {files.length > 12 && (
                                <div
                                  style={{
                                    width: '80px',
                                    height: '80px',
                                    borderRadius: '6px',
                                    background: '#1a1a2a',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    fontSize: '11px',
                                    color: '#5050a0',
                                    cursor: 'pointer'
                                  }}
                                >
                                  +{files.length - 12} more
                                </div>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {activeView === 'Grid' &&
                    months.map((monthKey) => {
                      const files = getFiltered(groupedFiles[monthKey] || [])
                      if (files.length === 0) return null
                      const [year, month] = monthKey.split('-')
                      const visible = getVisible(monthKey)
                      return (
                        <div
                          key={monthKey + '_grid_' + files.filter((f) => f.thumb).length}
                          ref={(el) => {
                            monthRefs.current[monthKey] = el
                          }}
                          style={{ marginBottom: '28px' }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              marginBottom: '10px'
                            }}
                          >
                            <div style={{ fontSize: '15px', fontWeight: 600, color: '#d0d0e8' }}>
                              {month} {year}
                            </div>
                            <div style={{ fontSize: '11px', color: '#3a3a48' }}>
                              · {files.length} files
                            </div>
                            <div style={{ flex: 1, height: '0.5px', background: '#1a1a22' }} />
                          </div>
                          <div
                            key={monthKey + '_' + files.filter((f) => f.thumb).length}
                            style={{
                              display: 'grid',
                              gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
                              gap: '5px'
                            }}
                          >
                            {files.slice(0, visible).map((file) => (
                              <FileTile
                                key={file.path}
                                file={file}
                                onOpen={(f) => openLightbox(f, files)}
                                onFav={handleFav}
                                isFav={favourites.has(file.path)}
                                isSelected={selected.has(file.path)}
                                onSelect={handleSelect}
                              />
                            ))}
                          </div>
                          {files.length > visible && (
                            <div
                              onClick={() =>
                                setVisibleCount((prev) => ({ ...prev, [monthKey]: visible + 40 }))
                              }
                              style={{
                                marginTop: '10px',
                                padding: '8px',
                                borderRadius: '8px',
                                background: '#1a1a2a',
                                border: '0.5px solid #2a2a3a',
                                cursor: 'pointer',
                                fontSize: '12px',
                                color: '#6060a0',
                                textAlign: 'center'
                              }}
                            >
                              Show more ({files.length - visible} remaining)
                            </div>
                          )}
                        </div>
                      )
                    })}
                </div>
              </div>
            )}
        </div>

        {/* Status bar */}
        <div
          style={{
            borderTop: '0.5px solid #1a1a22',
            padding: '6px 18px',
            display: 'flex',
            alignItems: 'center',
            gap: '14px',
            background: '#0c0c0e',
            flexShrink: 0
          }}
        >
          <div style={{ fontSize: '11px', color: '#3a3a48' }}>
            <span style={{ color: '#6060a0' }}>{drives.length}</span> drives
          </div>
          <div style={{ fontSize: '11px', color: '#3a3a48' }}>
            <span style={{ color: '#6060a0' }}>{totalFiles}</span> files
          </div>
          <div style={{ fontSize: '11px', color: '#3a3a48' }}>
            <span style={{ color: '#6060a0' }}>{months.length}</span> months
          </div>
          <div style={{ fontSize: '11px', color: '#3a3a48' }}>
            <span style={{ color: '#e060a0' }}>❤️ {allFavFiles.length}</span> favourites
          </div>
          {selected.size > 0 && (
            <div style={{ fontSize: '11px', color: '#6c6cff' }}>✓ {selected.size} selected</div>
          )}
          <div
            style={{
              marginLeft: 'auto',
              fontSize: '10px',
              color: '#4cd97b',
              background: 'rgba(76,217,123,0.08)',
              border: '0.5px solid rgba(76,217,123,0.2)',
              borderRadius: '4px',
              padding: '2px 7px'
            }}
          >
            ● live
          </div>
        </div>
      </div>

      {lightbox && (
        <LightBox
          file={lightbox.file}
          isFav={favourites.has(lightbox.file.path)}
          onFav={handleFav}
          onReveal={handleReveal}
          onClose={() => setLightbox(null)}
          onNext={() => {
            const idx = lightbox.list.indexOf(lightbox.file)
            if (idx < lightbox.list.length - 1)
              setLightbox({ file: lightbox.list[idx + 1], list: lightbox.list })
          }}
          onPrev={() => {
            const idx = lightbox.list.indexOf(lightbox.file)
            if (idx > 0) setLightbox({ file: lightbox.list[idx - 1], list: lightbox.list })
          }}
        />
      )}
    </div>
  )
}
