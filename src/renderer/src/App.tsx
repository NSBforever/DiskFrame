import { useState, useEffect } from 'react'

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

function App(): React.JSX.Element {
  const [activeNav, setActiveNav] = useState('all')
  const [drives, setDrives] = useState<DriveInfo[]>([])
  const [selectedDrive, setSelectedDrive] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanCount, setScanCount] = useState(0)
  const [groupedFiles, setGroupedFiles] = useState<Record<string, ScannedFile[]>>({})

  useEffect(() => {
    window.api.getDrives()
    window.api.onDrivesUpdated((updatedDrives) => {
      setDrives(updatedDrives as DriveInfo[])
    })
    window.api.onScanProgress((data) => {
      setScanCount(data.count)
    })
    window.api.onScanComplete((data) => {
      setScanning(false)
      setScanCount(data.count)
      window.api.getFiles(data.drive)
    })
    window.api.onFilesUpdated((grouped) => {
      setGroupedFiles(grouped as Record<string, ScannedFile[]>)
    })
  }, [])

  const handleDriveClick = (driveName: string): void => {
    setSelectedDrive(driveName)
    setScanning(true)
    setScanCount(0)
    setGroupedFiles({})
    window.api.scanDrive(driveName)
  }

  const months = Object.keys(groupedFiles).sort((a, b) => b.localeCompare(a))
  const photoExts = ['.jpg', '.jpeg', '.png', '.heic', '.raw', '.cr2', '.nef']

  return (
    <div style={{
      display: 'flex', height: '100vh', background: '#0f0f10',
      color: '#e8e8ea', fontFamily: 'system-ui, sans-serif',
      fontSize: '13px', overflow: 'hidden'
    }}>
      {/* Sidebar */}
      <div style={{ width: '200px', background: '#161618', borderRight: '0.5px solid #2a2a2e', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ padding: '16px 14px 12px', borderBottom: '0.5px solid #2a2a2e' }}>
          <div style={{ fontSize: '15px', fontWeight: 500, color: '#f0f0f2', letterSpacing: '-0.3px' }}>DiskFrame</div>
          <div style={{ fontSize: '11px', color: '#5a5a62', marginTop: '2px' }}>Smart file organiser</div>
        </div>

        {/* Drives */}
        <div style={{ overflowY: 'auto', maxHeight: '240px' }}>
          {drives.length === 0 ? (
            <div style={{ margin: '12px 10px', fontSize: '11px', color: '#5a5a62' }}>Scanning drives...</div>
          ) : (
            drives.map((drive, i) => {
              const usedPercent = drive.total > 0 ? Math.round((drive.used / drive.total) * 100) : 0
              const isSelected = selectedDrive === drive.name
              return (
                <div key={i} onClick={() => handleDriveClick(drive.name)} style={{
                  margin: '8px 10px', background: isSelected ? '#22223a' : '#1e1e22',
                  borderRadius: '10px', padding: '10px 12px',
                  border: `0.5px solid ${isSelected ? '#4040a0' : '#2e2e36'}`,
                  cursor: 'pointer'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 500, color: '#c8c8d0' }}>
                    <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#4cd97b', flexShrink: 0 }}></div>
                    {drive.name}
                  </div>
                  <div style={{ fontSize: '10px', color: '#5a5a62', marginTop: '4px' }}>{drive.total} GB · {drive.free} GB free</div>
                  <div style={{ height: '3px', background: '#2a2a2e', borderRadius: '2px', marginTop: '8px' }}>
                    <div style={{ height: '100%', width: `${usedPercent}%`, background: '#6c6cff', borderRadius: '2px' }}></div>
                  </div>
                  {isSelected && (
                    <div style={{ fontSize: '10px', color: '#6c6cff', marginTop: '6px' }}>
                      {scanning ? `Scanning... ${scanCount} files` : `${scanCount} files indexed`}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* Nav */}
        <div style={{ padding: '10px 10px 4px' }}>
          <div style={{ fontSize: '10px', color: '#44444e', textTransform: 'uppercase', letterSpacing: '0.8px', padding: '0 4px', marginBottom: '4px' }}>Browse</div>
          {[
            { id: 'all', label: 'All files' },
            { id: 'photos', label: 'Photos' },
            { id: 'videos', label: 'Videos' },
            { id: 'docs', label: 'Documents' },
          ].map(item => (
            <div key={item.id} onClick={() => setActiveNav(item.id)} style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '6px 8px', borderRadius: '7px', cursor: 'pointer',
              color: activeNav === item.id ? '#e8e8f4' : '#9090a0',
              background: activeNav === item.id ? '#252530' : 'transparent'
            }}>
              <span style={{ flex: 1 }}>{item.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Topbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 18px', borderBottom: '0.5px solid #2a2a2e', background: '#0f0f10' }}>
          <div style={{ flex: 1, fontSize: '13px', color: '#6060a0' }}>
            {selectedDrive ? <><span style={{ color: '#e8e8f4' }}>{selectedDrive}</span> › {activeNav}</> : 'Select a drive to scan'}
          </div>
          <div style={{ display: 'flex', gap: '2px', background: '#1a1a1e', borderRadius: '7px', padding: '2px' }}>
            {['Grid', 'Timeline', 'Map'].map(v => (
              <div key={v} style={{ padding: '4px 8px', borderRadius: '5px', cursor: 'pointer', fontSize: '11px', background: v === 'Grid' ? '#252530' : 'transparent', color: v === 'Grid' ? '#c0c0e0' : '#5a5a70' }}>{v}</div>
            ))}
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px' }}>
          {!selectedDrive && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#44444e' }}>
              <div style={{ fontSize: '32px', marginBottom: '12px' }}>💾</div>
              <div style={{ fontSize: '14px', fontWeight: 500, color: '#6060a0' }}>Click a drive to scan it</div>
              <div style={{ fontSize: '12px', marginTop: '4px' }}>DiskFrame will read EXIF data and organise your files by date</div>
            </div>
          )}

          {scanning && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#44444e' }}>
              <div style={{ fontSize: '14px', fontWeight: 500, color: '#6c6cff', marginBottom: '8px' }}>Scanning {selectedDrive}...</div>
              <div style={{ fontSize: '12px', color: '#5a5a72' }}>{scanCount} files found so far</div>
              <div style={{ marginTop: '16px', width: '200px', height: '3px', background: '#2a2a2e', borderRadius: '2px' }}>
                <div style={{ height: '100%', width: '60%', background: '#6c6cff', borderRadius: '2px', animation: 'pulse 1.5s ease-in-out infinite' }}></div>
              </div>
            </div>
          )}

          {!scanning && months.length > 0 && months.map(monthKey => {
            const files = groupedFiles[monthKey]
            const photos = activeNav === 'videos'
              ? files.filter(f => ['.mp4', '.mov', '.avi'].includes(f.ext))
              : activeNav === 'photos'
              ? files.filter(f => photoExts.includes(f.ext))
              : files

            if (photos.length === 0) return null
            const [year, month] = monthKey.split('-')

            return (
              <div key={monthKey} style={{ marginBottom: '24px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '10px' }}>
                  <div style={{ fontSize: '15px', fontWeight: 500, color: '#e0e0f0' }}>{month} {year}</div>
                  <div style={{ fontSize: '11px', color: '#44444e' }}>· {photos.length} files</div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '4px' }}>
                  {photos.slice(0, 18).map((file, i) => (
                    <div key={i} title={file.name} style={{
                      background: photoExts.includes(file.ext) ? '#1a2840' : '#2a1a1a',
                      borderRadius: '6px', aspectRatio: '1', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '10px', color: '#44444e', overflow: 'hidden'
                    }}>
                      {file.ext}
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>

        {/* Status bar */}
        <div style={{ borderTop: '0.5px solid #2a2a2e', padding: '8px 18px', display: 'flex', alignItems: 'center', gap: '16px', background: '#0d0d0f' }}>
          <div style={{ fontSize: '11px', color: '#44444e' }}><span style={{ color: '#8080a8' }}>{drives.length}</span> drives</div>
          <div style={{ fontSize: '11px', color: '#44444e' }}><span style={{ color: '#8080a8' }}>{Object.values(groupedFiles).flat().length}</span> files indexed</div>
          <div style={{ marginLeft: 'auto', fontSize: '10px', color: '#4cd97b', background: 'rgba(76,217,123,0.1)', border: '0.5px solid rgba(76,217,123,0.3)', borderRadius: '4px', padding: '2px 8px' }}>● live</div>
        </div>
      </div>
    </div>
  )
}

export default App