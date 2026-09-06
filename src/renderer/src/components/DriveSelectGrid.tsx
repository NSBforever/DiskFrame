import { useEffect, useState } from 'react'
import './DriveSelectGrid.css'

export interface Drive {
  id: string
  label: string
  letter: string
  type: 'internal' | 'external'
  totalBytes: number
  freeBytes: number
  fileCount?: number
}

interface DriveSelectGridProps {
  onSelectDrive: (drive: Drive) => void
  drives?: any[]
  driveFiles?: Record<string, Record<string, any[]>>
}

function mapRawDrive(d: any, driveFiles?: Record<string, Record<string, any[]>>): Drive {
  const totalBytes = (d.total || 0) * 1024 * 1024 * 1024
  const freeBytes = (d.free || 0) * 1024 * 1024 * 1024
  const nameUpper = (d.name || '').toUpperCase().trim()
  const fsLower = (d.filesystem || '').toLowerCase()
  const rawLabel = (d.label || d.volumeName || d.name || '').trim()

  const isInternal =
    nameUpper.startsWith('C:') ||
    fsLower.includes('fixed') ||
    fsLower.includes('internal') ||
    (nameUpper.startsWith('D:') && !fsLower.includes('removable') && !fsLower.includes('usb'))

  const filesCount =
    driveFiles && driveFiles[d.name]
      ? Object.values(driveFiles[d.name]).flat().length
      : undefined

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
    type: isInternal ? 'internal' : 'external',
    totalBytes,
    freeBytes,
    fileCount: filesCount
  }
}

async function fetchDrives(driveFiles?: Record<string, Record<string, any[]>>): Promise<Drive[]> {
  return new Promise((resolve) => {
    if (typeof window !== 'undefined' && window.api) {
      let resolved = false
      const unbind = window.api.onDrivesUpdated((rawDrives) => {
        if (resolved) return
        resolved = true
        unbind()
        const mapped = (rawDrives || []).map((d) => mapRawDrive(d, driveFiles))
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

export default function DriveSelectGrid({ onSelectDrive, drives: propDrives, driveFiles }: DriveSelectGridProps) {
  const [drives, setDrives] = useState<Drive[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (propDrives && propDrives.length > 0) {
      setDrives(propDrives.map((d) => mapRawDrive(d, driveFiles)))
      setLoading(false)
    } else {
      fetchDrives(driveFiles)
        .then((fetched) => {
          if (fetched.length > 0) {
            setDrives(fetched)
          }
        })
        .finally(() => setLoading(false))
    }
  }, [propDrives, driveFiles])

  useEffect(() => {
    if (typeof window !== 'undefined' && window.api) {
      const unbind = window.api.onDrivesUpdated((rawDrives) => {
        if (rawDrives && rawDrives.length > 0) {
          setDrives(rawDrives.map((d) => mapRawDrive(d, driveFiles)))
          setLoading(false)
        }
      })
      return () => {
        unbind()
      }
    }
    return undefined
  }, [driveFiles])

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
      <div className="drive-grid">
        {drives.map((drive) => (
          <button
            key={drive.id}
            className="drive-card"
            onClick={() => onSelectDrive(drive)}
          >
            <div className="drive-card-top">
              <span className="drive-icon">{drive.type === 'internal' ? '💽' : '🔌'}</span>
              <span className={`drive-badge drive-badge-${drive.type}`}>
                {drive.type === 'internal' ? 'INTERNAL' : 'EXTERNAL'}
              </span>
            </div>
            <div className="drive-name">
              {drive.label}
            </div>
            <div className="drive-space">
              {formatBytes(drive.totalBytes - drive.freeBytes)} used of {formatBytes(drive.totalBytes)}
            </div>
            <div className="drive-progress">
              <div
                className="drive-progress-fill"
                style={{
                  width: `${drive.totalBytes > 0 ? ((drive.totalBytes - drive.freeBytes) / drive.totalBytes) * 100 : 0}%`
                }}
              />
            </div>
            {drive.fileCount !== undefined && (
              <div className="drive-filecount">{drive.fileCount.toLocaleString()} files indexed</div>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
