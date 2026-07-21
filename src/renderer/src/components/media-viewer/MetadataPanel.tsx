import React, { useState, useEffect } from 'react'
import exifr from 'exifr'

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

interface MetadataPanelProps {
  file: ScannedFile
  isOpen: boolean
  onClose: () => void
  naturalDimensions: { width: number; height: number } | null
}

interface ParsedMetadata {
  camera?: string
  lens?: string
  iso?: string
  exposure?: string
  focalLength?: string
  dateTaken?: string
  location?: { lat: number; lng: number }
  dimensions?: string
  colorSpace?: string
  fileSize: string
  resolution?: string
}

function formatExposureTime(sec: any): string {
  const s = Number(sec)
  if (!s || isNaN(s)) return ''
  if (s >= 0.5) return s.toFixed(1) + 's'
  const denom = Math.round(1 / s)
  return `1/${denom}s`
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

export const MetadataPanel: React.FC<MetadataPanelProps> = ({
  file,
  isOpen,
  onClose,
  naturalDimensions
}) => {
  const [meta, setMeta] = useState<ParsedMetadata | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    setLoading(true)

    const fetchExif = async () => {
      try {
        const isPhoto = ['.jpg', '.jpeg', '.png', '.webp', '.heic'].includes(file.ext.toLowerCase())
        let exifData: any = {}

        if (isPhoto) {
          const mediaUrl = 'media:///' + file.path.replace(/\\/g, '/')
          const res = await fetch(mediaUrl)
          const buffer = await res.arrayBuffer()
          exifData = await exifr.parse(buffer, true) || {}
        }

        const sizeStr = formatBytes(file.size)

        // Determine dimensions
        let dimStr = ''
        let resStr = ''
        const w = naturalDimensions?.width || exifData.ExifImageWidth || exifData.ImageWidth
        const h = naturalDimensions?.height || exifData.ExifImageHeight || exifData.ImageHeight
        if (w && h) {
          dimStr = `${w} × ${h}`
          const mp = ((w * h) / 1000000).toFixed(1)
          resStr = `${mp} MP`
        }

        // Camera strings
        const make = exifData.Make || ''
        const model = exifData.Model || ''
        const camera = make || model ? `${make} ${model}`.trim() : undefined

        // Lens
        const lens = exifData.LensModel || exifData.LensInfo || undefined

        // ISO
        const iso = exifData.ISOSpeedRatings || exifData.ISO || undefined

        // Exposure / Shutter Speed
        const exposure = formatExposureTime(exifData.ExposureTime)

        // Focal Length
        const focalLength = exifData.FocalLength ? `${exifData.FocalLength} mm` : undefined

        // Date taken
        const dateTaken = exifData.DateTimeOriginal
          ? new Date(exifData.DateTimeOriginal).toLocaleString()
          : file.date
            ? new Date(file.date).toLocaleString()
            : undefined

        // Location coordinates
        let location: { lat: number; lng: number } | undefined = undefined
        const lat = exifData.latitude ?? exifData.GPSLatitude ?? file.lat
        const lng = exifData.longitude ?? exifData.GPSLongitude ?? file.lng
        if (typeof lat === 'number' && typeof lng === 'number') {
          location = { lat, lng }
        }

        // Color Space
        let colorSpace: string | undefined = undefined
        if (exifData.ColorSpace === 1) {
          colorSpace = 'sRGB'
        } else if (exifData.ColorSpace === 2 || exifData.ColorSpace === 65535) {
          colorSpace = 'Adobe RGB'
        }

        setMeta({
          camera,
          lens,
          iso: iso ? String(iso) : undefined,
          exposure,
          focalLength,
          dateTaken,
          location,
          dimensions: dimStr || undefined,
          resolution: resStr || undefined,
          colorSpace,
          fileSize: sizeStr
        })
      } catch (err) {
        console.error('Error parsing EXIF metadata', err)
        setMeta({
          fileSize: formatBytes(file.size),
          dateTaken: file.date ? new Date(file.date).toLocaleString() : undefined
        })
      } finally {
        setLoading(false)
      }
    }

    fetchExif()
  }, [file, isOpen, naturalDimensions])

  if (!isOpen) return null

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        width: '320px',
        height: '100%',
        background: '#0c0c0f',
        borderLeft: '1px solid rgba(255,255,255,0.04)',
        zIndex: 1500,
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '-8px 0 24px rgba(0,0,0,0.6)',
        color: '#f2f2f0',
        overflowY: 'auto',
        fontFamily: 'system-ui, sans-serif'
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 20px',
          borderBottom: '1px solid rgba(255,255,255,0.04)'
        }}
      >
        <div style={{ fontSize: '15px', fontWeight: 600, color: '#ffffff' }}>Info</div>
        <button
          onClick={onClose}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#8a8a8f',
            fontSize: '18px',
            cursor: 'pointer',
            padding: '4px',
            display: 'flex',
            alignItems: 'center'
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = '#e11d2e')}
          onMouseLeave={(e) => (e.currentTarget.style.color = '#8a8a8f')}
        >
          ✕
        </button>
      </div>

      {loading ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#e11d2e',
            fontSize: '13px'
          }}
        >
          Loading metadata...
        </div>
      ) : (
        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {/* File details */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ fontSize: '11px', color: '#e11d2e', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>File Details</div>
            <div style={{ fontSize: '14px', fontWeight: 500, color: '#fff', wordBreak: 'break-all' }}>{file.name}</div>
            <div style={{ fontSize: '12px', color: '#8a8a8f', marginTop: '4px' }}>Path: {file.path}</div>
            <div style={{ fontSize: '12px', color: '#8a8a8f' }}>Size: {meta?.fileSize}</div>
            {meta?.dimensions && (
              <div style={{ fontSize: '12px', color: '#8a8a8f' }}>
                Dimensions: {meta.dimensions} {meta.resolution ? `(${meta.resolution})` : ''}
              </div>
            )}
            {meta?.colorSpace && <div style={{ fontSize: '12px', color: '#8a8a8f' }}>Color Space: {meta.colorSpace}</div>}
          </div>

          {/* EXIF */}
          {(meta?.camera || meta?.lens || meta?.iso || meta?.exposure || meta?.focalLength) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontSize: '11px', color: '#8a8a8f', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Camera Properties</div>
              {meta.camera && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '16px' }}>📷</span>
                  <div style={{ fontSize: '13px' }}>
                    <div style={{ color: '#fff', fontWeight: 500 }}>{meta.camera}</div>
                    <div style={{ fontSize: '11px', color: '#8a8a8f' }}>Camera</div>
                  </div>
                </div>
              )}
              {meta.lens && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px' }}>
                  <span style={{ fontSize: '16px' }}>🔍</span>
                  <div style={{ fontSize: '13px' }}>
                    <div style={{ color: '#fff', fontWeight: 500 }}>{meta.lens}</div>
                    <div style={{ fontSize: '11px', color: '#8a8a8f' }}>Lens</div>
                  </div>
                </div>
              )}
              {(meta.exposure || meta.iso || meta.focalLength) && (
                <div style={{ display: 'flex', gap: '16px', background: '#161619', padding: '10px 12px', borderRadius: '8px', marginTop: '6px' }}>
                  {meta.exposure && (
                    <div style={{ flex: 1, textAlign: 'center' }}>
                      <div style={{ fontSize: '12px', color: '#fff', fontWeight: 600 }}>{meta.exposure}</div>
                      <div style={{ fontSize: '10px', color: '#8a8a8f' }}>Shutter</div>
                    </div>
                  )}
                  {meta.focalLength && (
                    <div style={{ flex: 1, textAlign: 'center' }}>
                      <div style={{ fontSize: '12px', color: '#fff', fontWeight: 600 }}>{meta.focalLength}</div>
                      <div style={{ fontSize: '10px', color: '#8a8a8f' }}>Focal</div>
                    </div>
                  )}
                  {meta.iso && (
                    <div style={{ flex: 1, textAlign: 'center' }}>
                      <div style={{ fontSize: '12px', color: '#fff', fontWeight: 600 }}>ISO {meta.iso}</div>
                      <div style={{ fontSize: '10px', color: '#8a8a8f' }}>ISO</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Date Taken */}
          {meta?.dateTaken && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ fontSize: '11px', color: '#8a8a8f', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Date Taken</div>
              <div style={{ fontSize: '13px', color: '#f2f2f0', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>📅</span> {meta.dateTaken}
              </div>
            </div>
          )}

          {/* GPS Location */}
          {meta?.location && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ fontSize: '11px', color: '#8a8a8f', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Location</div>
              <div style={{ fontSize: '12px', color: '#e11d2e', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>📍</span>
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${meta.location.lat},${meta.location.lng}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: '#e11d2e', textDecoration: 'none', fontWeight: 500 }}
                  onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
                  onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
                >
                  {meta.location.lat.toFixed(5)}, {meta.location.lng.toFixed(5)}
                </a>
              </div>
              <div style={{ fontSize: '10px', color: '#8a8a8f', marginTop: '2px' }}>Opens external map view</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
