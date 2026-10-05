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
  /**
   * No volume identity could be read for this letter, and no backing volume was
   * found for it either. It is still listed - the app cannot tell whether it is
   * real - but its catalogue state is unknown, so the card must not claim one.
   */
  identityUnverified: boolean
  /** Records indexed for this drive's verified volume; undefined until known. */
  indexedCount: number | undefined
}

interface DriveSelectGridProps {
  onSelectDrive: (drive: Drive) => void
  drives?: any[]
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
    freeBytes,
    identityUnverified: d.identityUnverified === true,
    indexedCount: typeof d.indexedCount === 'number' ? d.indexedCount : undefined
  }
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 GB'
  const gb = bytes / 1024 ** 3
  if (gb > 1024) return (gb / 1024).toFixed(2) + ' TB'
  return gb.toFixed(1) + ' GB'
}

export default function DriveSelectGrid({ onSelectDrive, drives: propDrives }: DriveSelectGridProps) {
  // Seeded from the list the app already holds (returning from a drive), then
  // kept current by every 'drives-updated'. Each entry carries its own indexed
  // count, so a card never says "Not indexed yet" while a separate count
  // request is still on its way - which is what every card briefly said before.
  const [drives, setDrives] = useState<Drive[]>(() => (propDrives ?? []).map(mapRawDrive))
  // "No drives" is only said once the main process has actually answered. The
  // old 2.5s timeout said it on every cold start, while enumeration was still
  // waiting on PowerShell.
  const [received, setReceived] = useState(() => (propDrives?.length ?? 0) > 0)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.api) return undefined
    const unbind = window.api.onDrivesUpdated((rawDrives) => {
      setDrives((rawDrives || []).map((d) => mapRawDrive(d)))
      setReceived(true)
    })
    window.api.getDrives()
    return () => {
      unbind()
    }
  }, [])

  if (received && drives.length === 0) {
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
          {received ? 'Choose a storage volume to scan and organize media files' : 'Looking for drives…'}
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
          const realCount = drive.indexedCount
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
                {drive.identityUnverified
                  ? // Its catalogue is looked up by the volume verified at this
                    // letter. With no verified volume there is no count to
                    // report, and "Not indexed yet" would be a claim the app
                    // cannot make.
                    'Drive could not be verified'
                  : realCount === undefined
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
