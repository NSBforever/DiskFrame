import { useEffect, useState } from 'react'
import { HardDrive, Usb } from 'lucide-react'
import './DriveSelectGrid.css'

export interface Drive {
  id: string
  label: string
  letter: string
  type: 'internal' | 'external' | 'unknown'
  /** Physical medium, independent of how the drive is attached. */
  media: 'ssd' | 'hdd' | 'unknown'
  model: string | null
  totalBytes: number
  freeBytes: number
}

interface DriveSelectGridProps {
  onSelectDrive: (drive: Drive) => void
  drives?: any[]
  driveFiles?: Record<string, Record<string, any[]>>
}

// Usage-bar color anchors: flat green through 40%, interpolating to yellow at
// 60%, orange at 80%, flat red from 95%. Piecewise-linear in RGB space.
import { usageColor } from '../../../main/usageColor'

function mapRawDrive(d: any): Drive {
  const totalBytes = (d.total || 0) * 1024 * 1024 * 1024
  const freeBytes = (d.free || 0) * 1024 * 1024 * 1024
  const nameUpper = (d.name || '').toUpperCase().trim()
  const rawLabel = (d.label || d.volumeName || d.name || '').trim()

  // connectionType comes from the main process, which maps this volume to its
  // physical disk and checks the real bus (Get-PhysicalDisk .BusType) rather
  // than guessing from the drive letter or filesystem name.
  const driveType: Drive['type'] =
    d.connectionType === 'internal' || d.connectionType === 'external' ? d.connectionType : 'unknown'

  const cleanLetter = nameUpper.endsWith('\\') ? nameUpper.slice(0, -1) : nameUpper

  // Clean any existing trailing drive letter brackets e.g. "(C:)" or "(C:) (C:)"
  let baseName = rawLabel.endsWith('\\') ? rawLabel.slice(0, -1) : rawLabel
  baseName = baseName.replace(/(\s*\([A-Z]:\))+$/gi, '').trim()

  let displayLabel = ''
  if (!baseName || baseName === cleanLetter || baseName.length <= 3) {
    displayLabel = `Local Disk (${cleanLetter})`
  } else {
    displayLabel = `${baseName} (${cleanLetter})`
  }

  const media: Drive['media'] =
    d.mediaType === 'ssd' || d.mediaType === 'hdd' ? d.mediaType : 'unknown'

  return {
    id: d.name,
    label: displayLabel,
    letter: cleanLetter,
    type: driveType,
    media,
    model: typeof d.model === 'string' && d.model ? d.model : null,
    totalBytes,
    freeBytes
  }
}

async function fetchDrives(): Promise<Drive[]> {
  return new Promise((resolve) => {
    if (typeof window !== 'undefined' && window.api) {
      let resolved = false
      const unbind = window.api.onDrivesUpdated((rawDrives) => {
        if (resolved) return
        resolved = true
        unbind()
        const mapped = (rawDrives || []).map((d) => mapRawDrive(d))
        resolve(mapped)
      })
      window.api.getDrives()

      setTimeout(() => {
        if (!resolved) {
          resolved = true
          unbind()
          resolve([])
        }
      }, 2500)
    } else {
      resolve([])
    }
  })
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 GB'
  const gb = bytes / 1024 ** 3
  if (gb > 1024) return (gb / 1024).toFixed(2) + ' TB'
  return gb.toFixed(1) + ' GB'
}

export default function DriveSelectGrid({ onSelectDrive, drives: propDrives }: DriveSelectGridProps) {
  const [drives, setDrives] = useState<Drive[]>([])
  const [loading, setLoading] = useState(true)
  // The real, DB-backed count for every drive ever indexed - not just the
  // renderer's session cache, which is empty until you've opened a drive
  // this session (that's what made an actually-indexed drive show "not
  // indexed" and, combined with the conditional status row below, made cards
  // different heights). null = not fetched yet.
  const [driveCounts, setDriveCounts] = useState<Record<string, number> | null>(null)

  useEffect(() => {
    window.api.getDriveFileCounts().then(setDriveCounts).catch(() => setDriveCounts({}))
  }, [])

  useEffect(() => {
    if (propDrives && propDrives.length > 0) {
      setDrives(propDrives.map((d) => mapRawDrive(d)))
      setLoading(false)
    } else {
      fetchDrives()
        .then((fetched) => {
          if (fetched.length > 0) {
            setDrives(fetched)
          }
        })
        .finally(() => setLoading(false))
    }
  }, [propDrives])

  useEffect(() => {
    if (typeof window !== 'undefined' && window.api) {
      const unbind = window.api.onDrivesUpdated((rawDrives) => {
        if (rawDrives && rawDrives.length > 0) {
          setDrives(rawDrives.map((d) => mapRawDrive(d)))
          setLoading(false)
        }
      })
      return () => {
        unbind()
      }
    }
    return undefined
  }, [])

  if (!loading && drives.length === 0) {
    return (
      <div className="drive-empty-state">
        <div className="drive-empty-icon">🖴</div>
        <div className="drive-empty-title">SELECT A DRIVE TO SCAN AND EXPLORE</div>
        <div className="drive-empty-sub">Smart EXIF-based local photo organizer</div>
      </div>
    )
  }

  return (
    <div className="drive-grid-container">
      <div style={{ textAlign: 'center', marginBottom: '32px' }}>
        <h1 style={{ fontSize: '20px', fontWeight: 800, color: '#ffffff', letterSpacing: '2px', textTransform: 'uppercase', margin: 0 }}>
          SELECT A DRIVE
        </h1>
        <div style={{ fontSize: '11px', color: 'var(--app-fg-dim, #8a8a8f)', marginTop: '6px', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600 }}>
          Choose a storage volume to scan and organize media files
        </div>
      </div>
      <div className="drive-grid">
        {drives.map((drive) => {
          const usedPct = drive.totalBytes > 0 ? ((drive.totalBytes - drive.freeBytes) / drive.totalBytes) * 100 : 0
          // The icon always renders: an unknown connection still gets the
          // neutral drive glyph rather than a gap.
          const Icon = drive.type === 'external' ? Usb : HardDrive
          const badgeText = drive.type === 'unknown' ? 'Drive' : drive.type.toUpperCase()
          const mediaText = drive.media === 'unknown' ? null : drive.media.toUpperCase()
          const realCount = driveCounts ? driveCounts[drive.letter] ?? 0 : undefined
          return (
            <button
              key={drive.id}
              className="drive-card"
              onClick={() => onSelectDrive(drive)}
              // A restrained highlight that follows the cursor inside the card.
              // Written to CSS custom properties so only the card's own
              // background paints - no React state, so moving the mouse never
              // re-renders the grid.
              onPointerMove={(e) => {
                const el = e.currentTarget
                const r = el.getBoundingClientRect()
                el.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`)
                el.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`)
                el.style.setProperty('--glow', '1')
              }}
              onPointerLeave={(e) => {
                // Fully reset on leave, and on navigation, so no card is left lit.
                e.currentTarget.style.setProperty('--glow', '0')
              }}
              onBlur={(e) => e.currentTarget.style.setProperty('--glow', '0')}
            >
              <div className="drive-card-top">
                <Icon className="drive-icon" size={26} color={drive.type === 'unknown' ? '#6a6a78' : '#e5e5e5'} />
                <span className="drive-badge-row">
                  <span className={`drive-badge drive-badge-${drive.type}`}>{badgeText}</span>
                  {mediaText && <span className="drive-badge drive-badge-media">{mediaText}</span>}
                </span>
              </div>
              <div className="drive-name">
                {drive.label}
              </div>
              <div className="drive-space">
                {formatBytes(drive.totalBytes - drive.freeBytes)} used of {formatBytes(drive.totalBytes)} — {formatBytes(drive.freeBytes)} free
              </div>
              <div className="drive-progress">
                <div
                  className="drive-progress-fill"
                  style={{
                    width: `${usedPct}%`,
                    background: usageColor(usedPct)
                  }}
                />
              </div>
              <div className="drive-filecount">
                {realCount === undefined
                  ? <span className="drive-filecount-loading" />
                  : realCount > 0
                    ? `${realCount.toLocaleString()} files indexed`
                    : 'Not indexed yet'}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
