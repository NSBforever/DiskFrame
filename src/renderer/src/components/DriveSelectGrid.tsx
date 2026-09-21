import { useEffect, useState } from 'react'
import { HardDrive, Usb } from 'lucide-react'
import './DriveSelectGrid.css'

export interface Drive {
  id: string
  label: string
  letter: string
  type: 'internal' | 'external' | 'unknown'
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
const USAGE_COLOR_STOPS: [number, [number, number, number]][] = [
  [0, [34, 197, 94]],
  [40, [34, 197, 94]],
  [60, [250, 204, 21]],
  [80, [249, 115, 22]],
  [95, [225, 29, 46]],
  [100, [225, 29, 46]]
]

function usageColor(pct: number): string {
  const p = Math.max(0, Math.min(100, pct))
  for (let i = 0; i < USAGE_COLOR_STOPS.length - 1; i++) {
    const [p0, c0] = USAGE_COLOR_STOPS[i]
    const [p1, c1] = USAGE_COLOR_STOPS[i + 1]
    if (p >= p0 && p <= p1) {
      const t = p1 === p0 ? 0 : (p - p0) / (p1 - p0)
      const r = Math.round(c0[0] + (c1[0] - c0[0]) * t)
      const g = Math.round(c0[1] + (c1[1] - c0[1]) * t)
      const b = Math.round(c0[2] + (c1[2] - c0[2]) * t)
      return `rgb(${r}, ${g}, ${b})`
    }
  }
  const last = USAGE_COLOR_STOPS[USAGE_COLOR_STOPS.length - 1][1]
  return `rgb(${last[0]}, ${last[1]}, ${last[2]})`
}

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

  return {
    id: d.name,
    label: displayLabel,
    letter: cleanLetter,
    type: driveType,
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
        <div style={{ fontSize: '11px', color: '#8a8a8f', marginTop: '6px', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600 }}>
          Choose a storage volume to scan and organize media files
        </div>
      </div>
      <div className="drive-grid">
        {drives.map((drive) => {
          const usedPct = drive.totalBytes > 0 ? ((drive.totalBytes - drive.freeBytes) / drive.totalBytes) * 100 : 0
          const Icon = drive.type === 'internal' ? HardDrive : drive.type === 'external' ? Usb : HardDrive
          const badgeText = drive.type === 'unknown' ? 'Type unavailable' : drive.type.toUpperCase()
          const realCount = driveCounts ? driveCounts[drive.letter] ?? 0 : undefined
          return (
            <button
              key={drive.id}
              className="drive-card"
              onClick={() => onSelectDrive(drive)}
            >
              <div className="drive-card-top">
                <Icon className="drive-icon" size={26} color={drive.type === 'unknown' ? '#6a6a78' : '#e5e5e5'} />
                <span className={`drive-badge drive-badge-${drive.type}`}>{badgeText}</span>
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
