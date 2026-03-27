import { useState, useEffect, useRef } from 'react'

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
  const [cachedDrives, setCachedDrives] = useState<Set<string>>(new Set())
  const initialized = useRef(false)

  const photoExts = ['.jpg', '.jpeg', '.png', '.heic', '.raw', '.cr2', '.nef', '.webp']
  const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.wmv']

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

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
      setCachedDrives(prev => new Set([...prev, data.drive]))
      window.api.getFiles(data.drive)
    })

    window.api.onFilesUpdated((grouped) => {
      setGroupedFiles(grouped as Record<string, ScannedFile[]>)
    })
  }, [])

  const handleDriveClick = (driveName: string): void => {
    setSelectedDrive(driveName)
    setGroupedFiles({})
    if (cachedDrives.has(driveName)) {
      setScanning(false)
      window.api.getFiles(driveName)
    } else {
      setScanning(true)
      setScanCount(0)
      window.api.scanDrive(driveName)
    }
  }

  const handleRescan = (driveName: string, e: React.MouseEvent): void => {
    e.stopPropagation()
    setCachedDrives(prev => { const n = new Set(prev); n.delete(driveName); return n })
    setSelectedDrive(driveName)
    setScanning(true)
    setScanCount(0)
    setGroupedFiles({})
    window.api.rescanDrive(driveName)
  }

  // KEY FIX: spaces must NOT be encoded — use raw path with file:///
  const toFileUrl = (filePath: string): string => {
    // Convert backslashes to forward slashes, do NOT encode spaces
    const clean = filePath.replace(/\\/g, '/')
    return "localfile:///" + clean
  }

  const getDriveLabel = (driveName: string): string => {
    if (driveName === 'C:') return '💻 C: — System Drive'
    if (driveName === 'D:') return '🖴 D: — Local Disk'
    // For external drives (E:, F:, G: etc)
    return `🔌 ${driveName} — USB Drive`
  }

  const getDriveIcon = (driveName: string): string => {
    if (driveName === 'C:') return '💻'
    if (driveName === 'D:') return '🖴'
    return '🔌'
  }

  const getFilteredFiles = (files: ScannedFile[]): ScannedFile[] => {
    if (!files) return []
    if (activeNav === 'photos') return files.filter(f => photoExts.includes(f.ext))
    if (activeNav === 'videos') return files.filter(f => videoExts.includes(f.ext))
    if (activeNav === 'docs') return files.filter(f => ['.pdf', '.docx', '.doc', '.txt', '.xlsx'].includes(f.ext))
    return files
  }

  const months = Object.keys(groupedFiles).sort((a, b) => b.localeCompare(a))
  const totalFiles = Object.values(groupedFiles).flat().length
  const noResults = !scanning && selectedDrive && months.length > 0 &&
    months.every(k => getFilteredFiles(groupedFiles[k]).length === 0)

  return (
    <div style={{
      display: 'flex', width: '100vw', height: '100vh',
      background: '#0f0f10', color: '#e8e8ea',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: '13px', overflow: 'hidden',
      position: 'fixed', top: 0, left: 0
    }}>

      {/* Sidebar */}
      <div style={{
        width: '230px', minWidth: '230px', height: '100vh',
        background: '#161618', borderRight: '0.5px solid #2a2a2e',
        display: 'flex', flexDirection: 'column', overflowY: 'auto', flexShrink: 0
      }}>
        <div style={{ padding: '18px 16px 12px', borderBottom: '0.5px solid #2a2a2e' }}>
          <div style={{ fontSize: '16px', fontWeight: 600, color: '#f0f0f2', letterSpacing: '-0.3px' }}>DiskFrame</div>
          <div style={{ fontSize: '11px', color: '#5a5a62', marginTop: '2px' }}>Smart file organiser</div>
        </div>

        {/* Drives section */}
        <div style={{ padding: '10px 0 4px' }}>
          <div style={{ fontSize: '10px', color: '#44444e', textTransform: 'uppercase', letterSpacing: '0.8px', padding: '0 14px', marginBottom: '6px' }}>Drives</div>
          {drives.length === 0 ? (
            <div style={{ margin: '8px 14px', fontSize: '11px', color: '#5a5a62' }}>Detecting drives...</div>
          ) : drives.map((drive, i) => {
            const usedPct = drive.total > 0 ? Math.round((drive.used / drive.total) * 100) : 0
            const isSelected = selectedDrive === drive.name
            const isCached = cachedDrives.has(drive.name)
            return (
              <div key={i} onClick={() => handleDriveClick(drive.name)} style={{
                margin: '4px 10px', borderRadius: '10px', padding: '10px 12px',
                background: isSelected ? '#22223a' : '#1e1e22',
                border: `0.5px solid ${isSelected ? '#4040a0' : '#2e2e36'}`,
                cursor: 'pointer', transition: 'all 0.15s'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '16px' }}>{getDriveIcon(drive.name)}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '12px', fontWeight: 600, color: '#d0d0e0' }}>
                      {drive.name === 'C:' ? 'System Drive' : drive.name === 'D:' ? 'Local Disk' : 'USB Drive'}
                    </div>
                    <div style={{ fontSize: '10px', color: '#5a5a72' }}>{drive.name} · {drive.free} GB free</div>
                  </div>
                  {isCached && (
                    <span onClick={(e) => handleRescan(drive.name, e)}
                      title="Rescan"
                      style={{ fontSize: '14px', color: '#5a5a80', cursor: 'pointer' }}>↺</span>
                  )}
                </div>
                <div style={{ height: '3px', background: '#2a2a2e', borderRadius: '2px', marginTop: '8px' }}>
                  <div style={{ height: '100%', width: `${usedPct}%`, background: isCached ? '#4cd97b' : '#6c6cff', borderRadius: '2px' }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                  <span style={{ fontSize: '10px', color: '#44444e' }}>{drive.used} GB used</span>
                  <span style={{ fontSize: '10px', color: '#44444e' }}>{drive.total} GB</span>
                </div>
                {isSelected && (
                  <div style={{ fontSize: '10px', color: isCached ? '#4cd97b' : '#6c6cff', marginTop: '4px', fontWeight: 500 }}>
                    {scanning ? `⏳ Scanning... ${scanCount} files` : `✓ ${scanCount} files${isCached ? ' · cached' : ''}`}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Browse section */}
        <div style={{ padding: '8px 10px 4px', marginTop: '4px', borderTop: '0.5px solid #1e1e22' }}>
          <div style={{ fontSize: '10px', color: '#44444e', textTransform: 'uppercase', letterSpacing: '0.8px', padding: '0 4px', marginBottom: '6px' }}>Browse</div>
          {[
            { id: 'all',    label: 'All files', emoji: '🗂️' },
            { id: 'photos', label: 'Photos',    emoji: '🖼️' },
            { id: 'videos', label: 'Videos',    emoji: '🎬' },
            { id: 'docs',   label: 'Documents', emoji: '📄' },
          ].map(item => (
            <div key={item.id} onClick={() => setActiveNav(item.id)} style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '7px 8px', borderRadius: '7px', cursor: 'pointer',
              color: activeNav === item.id ? '#e8e8f4' : '#9090a0',
              background: activeNav === item.id ? '#252530' : 'transparent',
              marginBottom: '2px'
            }}>
              <span>{item.emoji}</span>
              <span style={{ flex: 1 }}>{item.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Main panel */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', minWidth: 0 }}>

        {/* Topbar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '12px',
          padding: '12px 20px', borderBottom: '0.5px solid #2a2a2e',
          background: '#0f0f10', flexShrink: 0
        }}>
          <div style={{ flex: 1, fontSize: '13px', color: '#6060a0' }}>
            {selectedDrive
              ? <><span style={{ color: '#e8e8f4' }}>{getDriveLabel(selectedDrive)}</span> › <span style={{ color: '#8080c0' }}>{activeNav}</span></>
              : 'Select a drive to scan'}
          </div>
          <div style={{ display: 'flex', gap: '2px', background: '#1a1a1e', borderRadius: '7px', padding: '2px' }}>
            {['Grid', 'Timeline', 'Map'].map(v => (
              <div key={v} style={{
                padding: '4px 10px', borderRadius: '5px', cursor: 'pointer', fontSize: '11px',
                background: v === 'Grid' ? '#252530' : 'transparent',
                color: v === 'Grid' ? '#c0c0e0' : '#5a5a70'
              }}>{v}</div>
            ))}
          </div>
          <div style={{ fontSize: '11px', color: '#5a5a70', background: '#1a1a1e', border: '0.5px solid #2a2a2e', borderRadius: '6px', padding: '4px 10px' }}>Sort: Date ↓</div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>

          {!selectedDrive && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
              <div style={{ fontSize: '48px', marginBottom: '16px' }}>💾</div>
              <div style={{ fontSize: '15px', fontWeight: 500, color: '#6060a0', marginBottom: '6px' }}>Click a drive to scan it</div>
              <div style={{ fontSize: '12px', color: '#44444e' }}>DiskFrame reads EXIF data and organises your files by date</div>
            </div>
          )}

          {scanning && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
              <div style={{ fontSize: '15px', fontWeight: 500, color: '#6c6cff', marginBottom: '8px' }}>Scanning {selectedDrive}...</div>
              <div style={{ fontSize: '12px', color: '#5a5a72', marginBottom: '16px' }}>{scanCount} files found so far</div>
              <div style={{ width: '240px', height: '3px', background: '#2a2a2e', borderRadius: '2px' }}>
                <div style={{ height: '100%', width: '60%', background: '#6c6cff', borderRadius: '2px' }} />
              </div>
            </div>
          )}

          {noResults && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60%' }}>
              <div style={{ fontSize: '32px', marginBottom: '12px' }}>🔍</div>
              <div style={{ fontSize: '13px', color: '#5a5a72' }}>No {activeNav} found on this drive</div>
            </div>
          )}

          {!scanning && selectedDrive && months.map(monthKey => {
            const files = groupedFiles[monthKey]
            const filtered = getFilteredFiles(files)
            if (filtered.length === 0) return null
            const [year, month] = monthKey.split('-')

            return (
              <div key={monthKey} style={{ marginBottom: '32px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                  <div style={{ fontSize: '16px', fontWeight: 600, color: '#e0e0f0' }}>{month} {year}</div>
                  <div style={{ fontSize: '11px', color: '#44444e' }}>· {filtered.length} files</div>
                  <div style={{ flex: 1, height: '0.5px', background: '#1e1e24' }} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '6px' }}>
                  {filtered.slice(0, 30).map((file, i) => (
                    <div key={i} title={file.name} style={{
                      borderRadius: '8px', aspectRatio: '1',
                      cursor: 'pointer', overflow: 'hidden',
                      background: '#1a1a2a', position: 'relative'
                    }}>
                      {photoExts.includes(file.ext) ? (
                        <img
                          src={toFileUrl(file.path)}
                          loading="lazy"
                          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                          onError={(e) => {
                            const t = e.target as HTMLImageElement
                            const p = t.parentElement
                            if (p) p.innerHTML = `<div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px"><span style="font-size:22px">🖼️</span><span style="font-size:10px;color:#44444e">${file.ext}</span></div>`
                          }}
                        />
                      ) : (
                        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                          <span style={{ fontSize: '24px' }}>{videoExts.includes(file.ext) ? '🎬' : '📄'}</span>
                          <span style={{ fontSize: '10px', color: '#5a5a72' }}>{file.ext}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>

        {/* Status bar */}
        <div style={{
          borderTop: '0.5px solid #2a2a2e', padding: '8px 20px',
          display: 'flex', alignItems: 'center', gap: '16px',
          background: '#0d0d0f', flexShrink: 0
        }}>
          <div style={{ fontSize: '11px', color: '#44444e' }}><span style={{ color: '#8080a8' }}>{drives.length}</span> drives</div>
          <div style={{ fontSize: '11px', color: '#44444e' }}><span style={{ color: '#8080a8' }}>{totalFiles}</span> files indexed</div>
          <div style={{ fontSize: '11px', color: '#44444e' }}><span style={{ color: '#8080a8' }}>{months.length}</span> months</div>
          <div style={{ marginLeft: 'auto', fontSize: '10px', color: '#4cd97b', background: 'rgba(76,217,123,0.1)', border: '0.5px solid rgba(76,217,123,0.3)', borderRadius: '4px', padding: '2px 8px' }}>● live</div>
        </div>
      </div>
    </div>
  )
}

export default App