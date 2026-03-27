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
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [viewerFile, setViewerFile] = useState<ScannedFile | null>(null)
  const initialized = useRef(false)

  const photoExts = ['.jpg', '.jpeg', '.png', '.heic', '.raw', '.cr2', '.nef', '.webp']
  const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.wmv']
  const docExts = ['.pdf', '.docx', '.doc', '.txt', '.xlsx', '.pptx', '.m', '.py', '.js', '.ts', '.csv']

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    window.api.getDrives()
    window.api.onDrivesUpdated((u) => setDrives(u as DriveInfo[]))
    window.api.onScanProgress((d) => setScanCount(d.count))
    window.api.onScanComplete((d) => {
      setScanning(false)
      setScanCount(d.count)
      setCachedDrives(prev => new Set([...prev, d.drive]))
      window.api.getFiles(d.drive)
    })
    window.api.onFilesUpdated((g) => setGroupedFiles(g as Record<string, ScannedFile[]>))
  }, [])

  const handleDriveClick = (name: string) => {
    setSelectedDrive(name)
    setGroupedFiles({})
    setSelectedFiles(new Set())
    if (cachedDrives.has(name)) { setScanning(false); window.api.getFiles(name) }
    else { setScanning(true); setScanCount(0); window.api.scanDrive(name) }
  }

  const handleRescan = (name: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setCachedDrives(prev => { const n = new Set(prev); n.delete(name); return n })
    setSelectedDrive(name); setScanning(true); setScanCount(0); setGroupedFiles({})
    window.api.rescanDrive(name)
  }

  const toggleSelect = (path: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setSelectedFiles(prev => {
      const n = new Set(prev)
      n.has(path) ? n.delete(path) : n.add(path)
      return n
    })
  }

  const toFileUrl = (filePath: string): string =>
    'localfile:///' + filePath.replace(/\\/g, '/')

  const getDriveIcon = (name: string) => name === 'C:' ? '💻' : name === 'D:' ? '🖴' : '🔌'
  const getDriveLabel = (name: string) => name === 'C:' ? 'System Drive' : name === 'D:' ? 'Local Disk' : 'USB Drive'

  const getFilteredFiles = (files: ScannedFile[]): ScannedFile[] => {
    if (!files) return []
    if (activeNav === 'photos') return files.filter(f => photoExts.includes(f.ext))
    if (activeNav === 'videos') return files.filter(f => videoExts.includes(f.ext))
    if (activeNav === 'docs') return files.filter(f => docExts.includes(f.ext))
    return files
  }

  const formatDate = (dateStr: string): string => {
    const d = new Date(dateStr)
    return d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  }

  const formatTime = (dateStr: string): string => {
    const d = new Date(dateStr)
    return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
  }

  const formatSize = (bytes: number): string => {
    if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
    if (bytes > 1024) return (bytes / 1024).toFixed(0) + ' KB'
    return bytes + ' B'
  }

  const months = Object.keys(groupedFiles).sort((a, b) => b.localeCompare(a))
  const totalFiles = Object.values(groupedFiles).flat().length
  const noResults = !scanning && selectedDrive && months.length > 0 &&
    months.every(k => getFilteredFiles(groupedFiles[k]).length === 0)

  return (
    <div style={{ display: 'flex', width: '100vw', height: '100vh', background: '#0f0f10', color: '#e8e8ea', fontFamily: 'system-ui, -apple-system, sans-serif', fontSize: '13px', overflow: 'hidden', position: 'fixed', top: 0, left: 0 }}>

      {/* ── Sidebar ── */}
      <div style={{ width: '230px', minWidth: '230px', height: '100vh', background: '#161618', borderRight: '0.5px solid #2a2a2e', display: 'flex', flexDirection: 'column', overflowY: 'auto', flexShrink: 0 }}>
        <div style={{ padding: '18px 16px 12px', borderBottom: '0.5px solid #2a2a2e' }}>
          <div style={{ fontSize: '16px', fontWeight: 600, color: '#f0f0f2', letterSpacing: '-0.3px' }}>DiskFrame</div>
          <div style={{ fontSize: '11px', color: '#5a5a62', marginTop: '2px' }}>Smart file organiser</div>
        </div>

        <div style={{ padding: '10px 0 4px' }}>
          <div style={{ fontSize: '10px', color: '#44444e', textTransform: 'uppercase', letterSpacing: '0.8px', padding: '0 14px', marginBottom: '6px' }}>Drives</div>
          {drives.length === 0
            ? <div style={{ margin: '8px 14px', fontSize: '11px', color: '#5a5a62' }}>Detecting...</div>
            : drives.map((drive, i) => {
              const usedPct = drive.total > 0 ? Math.round((drive.used / drive.total) * 100) : 0
              const isSelected = selectedDrive === drive.name
              const isCached = cachedDrives.has(drive.name)
              return (
                <div key={i} onClick={() => handleDriveClick(drive.name)} style={{ margin: '4px 10px', borderRadius: '10px', padding: '10px 12px', background: isSelected ? '#22223a' : '#1e1e22', border: `0.5px solid ${isSelected ? '#4040a0' : '#2e2e36'}`, cursor: 'pointer' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '16px' }}>{getDriveIcon(drive.name)}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '12px', fontWeight: 600, color: '#d0d0e0' }}>{getDriveLabel(drive.name)}</div>
                      <div style={{ fontSize: '10px', color: '#5a5a72' }}>{drive.name} · {drive.free} GB free</div>
                    </div>
                    {isCached && <span onClick={(e) => handleRescan(drive.name, e)} title="Rescan" style={{ fontSize: '14px', color: '#5a5a80', cursor: 'pointer' }}>↺</span>}
                  </div>
                  <div style={{ height: '3px', background: '#2a2a2e', borderRadius: '2px', marginTop: '8px' }}>
                    <div style={{ height: '100%', width: `${usedPct}%`, background: isCached ? '#4cd97b' : '#6c6cff', borderRadius: '2px' }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                    <span style={{ fontSize: '10px', color: '#44444e' }}>{drive.used} GB used</span>
                    <span style={{ fontSize: '10px', color: '#44444e' }}>{drive.total} GB</span>
                  </div>
                  {isSelected && <div style={{ fontSize: '10px', color: isCached ? '#4cd97b' : '#6c6cff', marginTop: '4px', fontWeight: 500 }}>
                    {scanning ? `⏳ Scanning... ${scanCount}` : `✓ ${scanCount} files${isCached ? ' · cached' : ''}`}
                  </div>}
                </div>
              )
            })}
        </div>

        <div style={{ padding: '8px 10px 4px', marginTop: '4px', borderTop: '0.5px solid #1e1e22' }}>
          <div style={{ fontSize: '10px', color: '#44444e', textTransform: 'uppercase', letterSpacing: '0.8px', padding: '0 4px', marginBottom: '6px' }}>Browse</div>
          {[{ id: 'all', label: 'All files', emoji: '🗂️' }, { id: 'photos', label: 'Photos', emoji: '🖼️' }, { id: 'videos', label: 'Videos', emoji: '🎬' }, { id: 'docs', label: 'Documents', emoji: '📄' }].map(item => (
            <div key={item.id} onClick={() => setActiveNav(item.id)} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 8px', borderRadius: '7px', cursor: 'pointer', color: activeNav === item.id ? '#e8e8f4' : '#9090a0', background: activeNav === item.id ? '#252530' : 'transparent', marginBottom: '2px' }}>
              <span>{item.emoji}</span><span style={{ flex: 1 }}>{item.label}</span>
            </div>
          ))}
        </div>

        {selectedFiles.size > 0 && (
          <div style={{ margin: '8px 10px', padding: '10px 12px', background: '#2a1a1a', borderRadius: '10px', border: '0.5px solid #4a2a2a' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: '#ff8080', marginBottom: '6px' }}>{selectedFiles.size} selected</div>
            <div onClick={() => setSelectedFiles(new Set())} style={{ fontSize: '11px', color: '#9090a0', cursor: 'pointer', marginBottom: '4px' }}>✕ Clear selection</div>
          </div>
        )}
      </div>

      {/* ── Main ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 20px', borderBottom: '0.5px solid #2a2a2e', background: '#0f0f10', flexShrink: 0 }}>
          <div style={{ flex: 1, fontSize: '13px', color: '#6060a0' }}>
            {selectedDrive ? <><span style={{ color: '#e8e8f4' }}>{getDriveIcon(selectedDrive)} {getDriveLabel(selectedDrive)}</span> › <span style={{ color: '#8080c0' }}>{activeNav}</span></> : 'Select a drive to scan'}
          </div>
          <div style={{ display: 'flex', gap: '2px', background: '#1a1a1e', borderRadius: '7px', padding: '2px' }}>
            {['Grid', 'Timeline', 'Map'].map(v => (
              <div key={v} style={{ padding: '4px 10px', borderRadius: '5px', cursor: 'pointer', fontSize: '11px', background: v === 'Grid' ? '#252530' : 'transparent', color: v === 'Grid' ? '#c0c0e0' : '#5a5a70' }}>{v}</div>
            ))}
          </div>
          <div style={{ fontSize: '11px', color: '#5a5a70', background: '#1a1a1e', border: '0.5px solid #2a2a2e', borderRadius: '6px', padding: '4px 10px' }}>Sort: Date ↓</div>
        </div>

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

                {/* Document list view */}
                {activeNav === 'docs' ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {filtered.map((file, i) => {
                      const isSelected = selectedFiles.has(file.path)
                      return (
                        <div key={i} onClick={() => setViewerFile(file)} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 12px', borderRadius: '8px', background: isSelected ? '#22223a' : '#1a1a22', border: `0.5px solid ${isSelected ? '#4040a0' : '#2a2a32'}`, cursor: 'pointer' }}>
                          <div onClick={(e) => toggleSelect(file.path, e)} style={{ width: '18px', height: '18px', borderRadius: '50%', border: `1.5px solid ${isSelected ? '#6c6cff' : '#44444e'}`, background: isSelected ? '#6c6cff' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, cursor: 'pointer' }}>
                            {isSelected && <span style={{ fontSize: '10px', color: '#fff' }}>✓</span>}
                          </div>
                          <span style={{ fontSize: '18px' }}>{file.ext === '.pdf' ? '📕' : file.ext === '.m' ? '📊' : file.ext === '.py' ? '🐍' : '📄'}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '12px', color: '#d0d0e0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{file.name}</div>
                            <div style={{ fontSize: '10px', color: '#5a5a72', marginTop: '2px' }}>{formatDate(file.date)} · {formatSize(file.size)}</div>
                          </div>
                          <span style={{ fontSize: '10px', color: '#44444e', background: '#2a2a3a', padding: '2px 6px', borderRadius: '4px' }}>{file.ext}</span>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  /* Photo/Video grid */
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '6px' }}>
                    {filtered.slice(0, 30).map((file, i) => {
                      const isSelected = selectedFiles.has(file.path)
                      const isPhoto = photoExts.includes(file.ext)
                      const isVideo = videoExts.includes(file.ext)

                      return (
                        <div key={i} onClick={() => setViewerFile(file)} style={{ borderRadius: '8px', aspectRatio: '1', cursor: 'pointer', overflow: 'hidden', background: '#1a1a2a', position: 'relative', border: isSelected ? '2px solid #6c6cff' : '2px solid transparent' }}>

                          {/* Select tick top-right */}
                          <div onClick={(e) => toggleSelect(file.path, e)} style={{ position: 'absolute', top: '6px', right: '6px', zIndex: 10, width: '20px', height: '20px', borderRadius: '50%', background: isSelected ? '#6c6cff' : 'rgba(0,0,0,0.5)', border: `1.5px solid ${isSelected ? '#6c6cff' : 'rgba(255,255,255,0.4)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }}>
                            {isSelected && <span style={{ fontSize: '11px', color: '#fff', fontWeight: 700 }}>✓</span>}
                          </div>

                          {/* Video badge */}
                          {isVideo && (
                            <div style={{ position: 'absolute', bottom: '6px', left: '6px', zIndex: 10, background: 'rgba(0,0,0,0.6)', borderRadius: '4px', padding: '2px 5px', fontSize: '9px', color: '#fff', backdropFilter: 'blur(4px)' }}>▶ {file.ext.replace('.', '').toUpperCase()}</div>
                          )}

                          {/* HEIC badge */}
                          {file.ext === '.heic' && (
                            <div style={{ position: 'absolute', bottom: '6px', right: '6px', zIndex: 10, background: 'rgba(0,0,0,0.6)', borderRadius: '4px', padding: '2px 5px', fontSize: '9px', color: '#aaffaa', backdropFilter: 'blur(4px)' }}>HEIC</div>
                          )}

                          {isPhoto ? (
                            <img
                              src={toFileUrl(file.path)}
                              loading="lazy"
                              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                              onError={(e) => {
                                const t = e.target as HTMLImageElement
                                const p = t.parentElement
                                if (p) p.innerHTML += `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;background:#1a1a2a"><span style="font-size:22px">${file.ext === '.heic' ? '🍎' : '🖼️'}</span><span style="font-size:10px;color:#44444e">${file.ext.toUpperCase()}</span></div>`
                                t.style.display = 'none'
                              }}
                            />
                          ) : isVideo ? (
                            <video
                              src={toFileUrl(file.path)}
                              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                              muted
                              preload="metadata"
                              onLoadedMetadata={(e) => {
                                const v = e.target as HTMLVideoElement
                                v.currentTime = 1
                              }}
                              onError={(e) => {
                                const v = e.target as HTMLVideoElement
                                const p = v.parentElement
                                if (p) p.innerHTML += `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;background:#1a1a2a"><span style="font-size:28px">🎬</span><span style="font-size:10px;color:#44444e">${file.ext.toUpperCase()}</span></div>`
                                v.style.display = 'none'
                              }}
                            />
                          ) : (
                            <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                              <span style={{ fontSize: '24px' }}>📄</span>
                              <span style={{ fontSize: '10px', color: '#5a5a72' }}>{file.ext}</span>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div style={{ borderTop: '0.5px solid #2a2a2e', padding: '8px 20px', display: 'flex', alignItems: 'center', gap: '16px', background: '#0d0d0f', flexShrink: 0 }}>
          <div style={{ fontSize: '11px', color: '#44444e' }}><span style={{ color: '#8080a8' }}>{drives.length}</span> drives</div>
          <div style={{ fontSize: '11px', color: '#44444e' }}><span style={{ color: '#8080a8' }}>{totalFiles}</span> files</div>
          <div style={{ fontSize: '11px', color: '#44444e' }}><span style={{ color: '#8080a8' }}>{months.length}</span> months</div>
          {selectedFiles.size > 0 && <div style={{ fontSize: '11px', color: '#6c6cff' }}>{selectedFiles.size} selected</div>}
          <div style={{ marginLeft: 'auto', fontSize: '10px', color: '#4cd97b', background: 'rgba(76,217,123,0.1)', border: '0.5px solid rgba(76,217,123,0.3)', borderRadius: '4px', padding: '2px 8px' }}>● live</div>
        </div>
      </div>

      {/* ── iPhone-style Viewer ── */}
      {viewerFile && (
        <div
          onClick={() => setViewerFile(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', zIndex: 100, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(20px)' }}
        >
          {/* Close */}
          <div style={{ position: 'absolute', top: '20px', right: '24px', fontSize: '22px', color: '#808080', cursor: 'pointer', zIndex: 101 }} onClick={() => setViewerFile(null)}>✕</div>

          {/* File display */}
          <div onClick={(e) => e.stopPropagation()} style={{ maxWidth: '80vw', maxHeight: '65vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {photoExts.includes(viewerFile.ext) ? (
              <img src={toFileUrl(viewerFile.path)} style={{ maxWidth: '80vw', maxHeight: '65vh', borderRadius: '12px', objectFit: 'contain', boxShadow: '0 32px 80px rgba(0,0,0,0.8)' }} />
            ) : videoExts.includes(viewerFile.ext) ? (
              <video src={toFileUrl(viewerFile.path)} controls autoPlay style={{ maxWidth: '80vw', maxHeight: '65vh', borderRadius: '12px', boxShadow: '0 32px 80px rgba(0,0,0,0.8)' }} onClick={(e) => e.stopPropagation()} />
            ) : (
              <div style={{ width: '200px', height: '200px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#1a1a2a', borderRadius: '20px' }}>
                <span style={{ fontSize: '64px' }}>📄</span>
                <span style={{ fontSize: '14px', color: '#8080a0', marginTop: '8px' }}>{viewerFile.ext.toUpperCase()}</span>
              </div>
            )}
          </div>

          {/* iPhone-style info panel */}
          <div onClick={(e) => e.stopPropagation()} style={{ marginTop: '24px', background: 'rgba(30,30,40,0.9)', borderRadius: '20px', padding: '20px 28px', width: 'min(500px, 85vw)', border: '0.5px solid rgba(255,255,255,0.08)' }}>
            {/* Filename */}
            <div style={{ fontSize: '15px', fontWeight: 600, color: '#f0f0f2', marginBottom: '16px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{viewerFile.name}</div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
              <div>
                <div style={{ fontSize: '10px', color: '#5a5a72', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '3px' }}>Date</div>
                <div style={{ fontSize: '13px', color: '#d0d0e0' }}>{formatDate(viewerFile.date)}</div>
              </div>
              <div>
                <div style={{ fontSize: '10px', color: '#5a5a72', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '3px' }}>Time</div>
                <div style={{ fontSize: '13px', color: '#d0d0e0' }}>{formatTime(viewerFile.date)}</div>
              </div>
              <div>
                <div style={{ fontSize: '10px', color: '#5a5a72', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '3px' }}>Size</div>
                <div style={{ fontSize: '13px', color: '#d0d0e0' }}>{formatSize(viewerFile.size)}</div>
              </div>
              <div>
                <div style={{ fontSize: '10px', color: '#5a5a72', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '3px' }}>Format</div>
                <div style={{ fontSize: '13px', color: '#d0d0e0' }}>{viewerFile.ext.replace('.', '').toUpperCase()}</div>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <div style={{ fontSize: '10px', color: '#5a5a72', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '3px' }}>Path</div>
                <div style={{ fontSize: '11px', color: '#6060a0', wordBreak: 'break-all' }}>{viewerFile.path}</div>
              </div>
              {viewerFile.lat && viewerFile.lng && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <div style={{ fontSize: '10px', color: '#5a5a72', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '3px' }}>Location</div>
                  <div style={{ fontSize: '13px', color: '#4cd97b' }}>📍 {viewerFile.lat.toFixed(4)}, {viewerFile.lng.toFixed(4)}</div>
                </div>
              )}
            </div>

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
              <div onClick={() => { toggleSelect(viewerFile.path, { stopPropagation: () => {} } as React.MouseEvent); setViewerFile(null) }}
                style={{ flex: 1, padding: '8px', borderRadius: '10px', background: selectedFiles.has(viewerFile.path) ? '#2a2a4a' : '#1e1e2e', border: '0.5px solid #3a3a5a', textAlign: 'center', cursor: 'pointer', fontSize: '12px', color: '#8080c0' }}>
                {selectedFiles.has(viewerFile.path) ? '✓ Selected' : '○ Select'}
              </div>
              <div style={{ flex: 1, padding: '8px', borderRadius: '10px', background: '#1e1e2e', border: '0.5px solid #3a3a5a', textAlign: 'center', cursor: 'pointer', fontSize: '12px', color: '#8080c0' }}>
                Share
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App