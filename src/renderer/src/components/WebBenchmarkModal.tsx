import React, { useState, useRef, useEffect } from 'react'
import { X, Play, Activity, Cpu, Clock, Film, Copy, Check, RefreshCw } from 'lucide-react'

interface WebBenchmarkModalProps {
  isOpen: boolean
  onClose: () => void
}

interface BenchmarkResults {
  url: string
  pageLoadTimeMs: number
  ttffMs: number | null
  videoFound: boolean
  fps: number | null
  totalFrames: number | null
  droppedFrames: number | null
  droppedPercent: number | null
  videoWidth: number | null
  videoHeight: number | null
  memoryMB: number | null
  cpuPercent: number | null
  timestamp: string
}

const PRESETS = [
  { name: 'HTML5 Big Buck Bunny', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4' },
  { name: 'Tears of Steel (4K H.264)', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4' },
  { name: 'Sintel Sample Video', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4' },
  { name: 'Mozilla Video Test Page', url: 'https://mdn.github.io/learning-area/html/multimedia-and-embedding/video-and-audio-content/responsive-video-example.html' }
]

export const WebBenchmarkModal: React.FC<WebBenchmarkModalProps> = ({ isOpen, onClose }) => {
  const [targetUrl, setTargetUrl] = useState('https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4')
  const [activeUrl, setActiveUrl] = useState<string | null>(null)
  const [isBenchmarking, setIsBenchmarking] = useState(false)
  const [benchmarkStep, setBenchmarkStep] = useState<string>('')
  const [results, setResults] = useState<BenchmarkResults | null>(null)
  const [copied, setCopied] = useState(false)

  const webviewRef = useRef<any>(null)
  const startTimeRef = useRef<number>(0)
  const navStartTimeRef = useRef<number>(0)

  useEffect(() => {
    if (!isOpen) {
      setActiveUrl(null)
      setIsBenchmarking(false)
      setResults(null)
      setBenchmarkStep('')
    }
  }, [isOpen])

  const runBenchmark = () => {
    if (!targetUrl.trim()) return

    let formattedUrl = targetUrl.trim()
    if (!/^https?:\/\//i.test(formattedUrl)) {
      formattedUrl = 'https://' + formattedUrl
    }

    setResults(null)
    setIsBenchmarking(true)
    setBenchmarkStep('Navigating & timing page load...')
    startTimeRef.current = performance.now()
    navStartTimeRef.current = Date.now()
    setActiveUrl(formattedUrl)
  }

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview || !isBenchmarking) return

    let isSubscribed = true

    const handleDidFinishLoad = async () => {
      if (!isSubscribed) return
      const loadTimeMs = Math.round(performance.now() - startTimeRef.current)
      setBenchmarkStep('Page loaded. Monitoring video element & frame performance...')

      // Query process memory/CPU metrics from main process
      let memoryMB: number | null = null
      let cpuPercent: number | null = null
      try {
        if (window.api && window.api.getBenchmarkMetrics) {
          const metrics = await window.api.getBenchmarkMetrics()
          memoryMB = metrics.memoryMB
          cpuPercent = metrics.cpuPercent
        }
      } catch (e) {
        console.error('Error fetching metrics:', e)
      }

      // Inject JS script into webview to measure video TTFF, FPS, dropped frames
      const script = `
        (async () => {
          const video = document.querySelector('video');
          if (!video) {
            return { videoFound: false };
          }

          const startPlay = performance.now();
          if (video.paused) {
            try { await video.play(); } catch(e) {}
          }

          let ttff = null;
          await new Promise((resolve) => {
            if (video.readyState >= 3 && !video.paused) {
              ttff = Math.round(performance.now() - startPlay);
              return resolve(null);
            }
            const onTimeUpdate = () => {
              ttff = Math.round(performance.now() - startPlay);
              video.removeEventListener('timeupdate', onTimeUpdate);
              video.removeEventListener('playing', onTimeUpdate);
              resolve(null);
            };
            video.addEventListener('playing', onTimeUpdate);
            video.addEventListener('timeupdate', onTimeUpdate);
            setTimeout(() => resolve(null), 3000);
          });

          // Wait 3 seconds to measure playback smoothness
          const qualityStart = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
          const timeStart = performance.now();

          await new Promise(r => setTimeout(r, 3000));

          const qualityEnd = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
          const durationSecs = (performance.now() - timeStart) / 1000;

          let totalFrames = null;
          let droppedFrames = null;
          let fps = null;
          let droppedPercent = null;

          if (qualityStart && qualityEnd) {
            totalFrames = qualityEnd.totalVideoFrames - qualityStart.totalVideoFrames;
            droppedFrames = qualityEnd.droppedVideoFrames - qualityStart.droppedVideoFrames;
            fps = Math.round((totalFrames / durationSecs) * 10) / 10;
            droppedPercent = totalFrames > 0 ? Math.round((droppedFrames / totalFrames) * 1000) / 10 : 0;
          }

          return {
            videoFound: true,
            ttffMs: ttff,
            fps,
            totalFrames,
            droppedFrames,
            droppedPercent,
            videoWidth: video.videoWidth || null,
            videoHeight: video.videoHeight || null
          };
        })()
      `

      try {
        const videoRes = await webview.executeJavaScript(script)
        if (!isSubscribed) return

        const res: BenchmarkResults = {
          url: activeUrl || targetUrl,
          pageLoadTimeMs: loadTimeMs,
          ttffMs: videoRes?.ttffMs ?? null,
          videoFound: !!videoRes?.videoFound,
          fps: videoRes?.fps ?? null,
          totalFrames: videoRes?.totalFrames ?? null,
          droppedFrames: videoRes?.droppedFrames ?? null,
          droppedPercent: videoRes?.droppedPercent ?? null,
          videoWidth: videoRes?.videoWidth ?? null,
          videoHeight: videoRes?.videoHeight ?? null,
          memoryMB,
          cpuPercent,
          timestamp: new Date().toLocaleTimeString()
        }

        setResults(res)
        setIsBenchmarking(false)
        setBenchmarkStep('Benchmark Completed')
      } catch (err) {
        console.error('Webview script error:', err)
        if (!isSubscribed) return
        setResults({
          url: activeUrl || targetUrl,
          pageLoadTimeMs: loadTimeMs,
          ttffMs: null,
          videoFound: false,
          fps: null,
          totalFrames: null,
          droppedFrames: null,
          droppedPercent: null,
          videoWidth: null,
          videoHeight: null,
          memoryMB,
          cpuPercent,
          timestamp: new Date().toLocaleTimeString()
        })
        setIsBenchmarking(false)
        setBenchmarkStep('Benchmark Completed (No video detected)')
      }
    }

    webview.addEventListener('did-finish-load', handleDidFinishLoad)

    return () => {
      isSubscribed = false
      webview.removeEventListener('did-finish-load', handleDidFinishLoad)
    }
  }, [activeUrl, isBenchmarking, targetUrl])

  const copyReport = () => {
    if (!results) return
    const text = `Diskframe Video Benchmark Report
---------------------------------
Target URL: ${results.url}
Timestamp: ${results.timestamp}
Page Load Time: ${results.pageLoadTimeMs} ms
Video Detected: ${results.videoFound ? 'Yes' : 'No'}
Time to First Frame (TTFF): ${results.ttffMs !== null ? `${results.ttffMs} ms` : 'N/A'}
Playback Smoothness: ${results.fps !== null ? `${results.fps} FPS` : 'N/A'}
Dropped Frames: ${results.droppedFrames !== null ? `${results.droppedFrames} (${results.droppedPercent}%)` : 'N/A'}
Resolution: ${results.videoWidth && results.videoHeight ? `${results.videoWidth}x${results.videoHeight}` : 'N/A'}
Process Memory Usage: ${results.memoryMB !== null ? `${results.memoryMB} MB` : 'N/A'}
Process CPU Usage: ${results.cpuPercent !== null ? `${results.cpuPercent}%` : 'N/A'}
`
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (!isOpen) return null

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 3500,
        background: 'rgba(0,0,0,0.85)',
        backdropFilter: 'blur(12px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '94vw',
          maxWidth: '1280px',
          height: '88vh',
          background: '#0a0a0c',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          borderRadius: '8px',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 24px 48px rgba(0, 0, 0, 0.8)'
        }}
      >
        {/* Top Header Bar */}
        <div
          style={{
            padding: '14px 20px',
            background: 'rgba(18, 18, 22, 0.95)',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            gap: '16px'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#e11d2e', fontWeight: 700, fontSize: '15px' }}>
            <Activity size={20} color="#e11d2e" />
            <span>Web Video Benchmark</span>
          </div>

          {/* URL Input & Launch Button */}
          <div style={{ flex: 1, display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input
              type="text"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="Enter website URL (e.g. https://example.com/video)"
              onKeyDown={(e) => {
                if (e.key === 'Enter') runBenchmark()
              }}
              style={{
                flex: 1,
                padding: '8px 14px',
                borderRadius: '4px',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: '#ffffff',
                fontSize: '13px',
                outline: 'none'
              }}
            />
            <button
              onClick={runBenchmark}
              disabled={isBenchmarking}
              style={{
                padding: '8px 18px',
                borderRadius: '4px',
                background: isBenchmarking ? 'rgba(225,29,46,0.5)' : '#e11d2e',
                border: 'none',
                color: '#ffffff',
                fontWeight: 600,
                fontSize: '13px',
                cursor: isBenchmarking ? 'wait' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                transition: 'all 0.2s'
              }}
            >
              {isBenchmarking ? <RefreshCw size={14} className="spin" /> : <Play size={14} />}
              <span>{isBenchmarking ? 'Benchmarking...' : 'Run Benchmark'}</span>
            </button>
          </div>

          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#8a8a8f',
              cursor: 'pointer',
              padding: '4px'
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Presets Bar */}
        <div
          style={{
            padding: '8px 20px',
            background: 'rgba(12, 12, 16, 0.6)',
            borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            fontSize: '11px',
            color: '#8a8a8f'
          }}
        >
          <span>Presets:</span>
          {PRESETS.map((preset) => (
            <button
              key={preset.name}
              onClick={() => {
                setTargetUrl(preset.url)
              }}
              style={{
                background: targetUrl === preset.url ? 'rgba(225,29,46,0.15)' : 'rgba(255,255,255,0.04)',
                border: `1px solid ${targetUrl === preset.url ? '#e11d2e' : 'rgba(255,255,255,0.08)'}`,
                color: targetUrl === preset.url ? '#ffffff' : '#b0b0b5',
                borderRadius: '3px',
                padding: '4px 10px',
                fontSize: '11px',
                cursor: 'pointer',
                transition: 'all 0.15s'
              }}
            >
              {preset.name}
            </button>
          ))}
        </div>

        {/* Main Body Layout (Webview Left, Results Right) */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* Webview Container */}
          <div style={{ flex: 1, position: 'relative', background: '#000000', display: 'flex', flexDirection: 'column' }}>
            {activeUrl ? (
              <webview
                ref={webviewRef}
                src={activeUrl}
                style={{ width: '100%', height: '100%', border: 'none' }}
                allowpopups={true}
              />
            ) : (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', color: '#6a6a70' }}>
                <Film size={48} color="#3a3a40" />
                <div style={{ fontSize: '14px', fontWeight: 600 }}>No Website Loaded</div>
                <div style={{ fontSize: '12px', maxWidth: '360px', textAlign: 'center' }}>
                  Select a preset video or enter any website URL above and click <strong>Run Benchmark</strong> to begin analysis.
                </div>
              </div>
            )}

            {/* Benchmarking Status Bar */}
            {isBenchmarking && (
              <div
                style={{
                  position: 'absolute',
                  top: '16px',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  background: 'rgba(10, 10, 14, 0.92)',
                  border: '1px solid #e11d2e',
                  borderRadius: '20px',
                  padding: '8px 20px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  fontSize: '12px',
                  color: '#ffffff',
                  boxShadow: '0 8px 24px rgba(225,29,46,0.3)',
                  zIndex: 100
                }}
              >
                <div
                  style={{
                    width: '12px',
                    height: '12px',
                    borderRadius: '50%',
                    border: '2px solid rgba(255,255,255,0.2)',
                    borderTop: '2px solid #e11d2e',
                    animation: 'tileSpin 0.8s linear infinite'
                  }}
                />
                <span>{benchmarkStep}</span>
              </div>
            )}
          </div>

          {/* Results Side Panel */}
          <div
            style={{
              width: '340px',
              background: '#121216',
              borderLeft: '1px solid rgba(255, 255, 255, 0.08)',
              display: 'flex',
              flexDirection: 'column',
              padding: '20px',
              gap: '18px',
              overflowY: 'auto'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '13px', fontWeight: 700, color: '#ffffff', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Benchmark Results
              </span>
              {results && (
                <button
                  onClick={copyReport}
                  title="Copy Report"
                  style={{
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    color: copied ? '#4ba561' : '#f2f2f0',
                    borderRadius: '4px',
                    padding: '4px 8px',
                    fontSize: '11px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px'
                  }}
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  <span>{copied ? 'Copied' : 'Copy'}</span>
                </button>
              )}
            </div>

            {results ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                {/* Metric Card 1: Page Load Time */}
                <div
                  style={{
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    borderRadius: '6px',
                    padding: '14px'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#8a8a8f', marginBottom: '6px' }}>
                    <Clock size={14} color="#e11d2e" />
                    <span>Page Load Time</span>
                  </div>
                  <div style={{ fontSize: '24px', fontWeight: 700, color: '#ffffff' }}>
                    {results.pageLoadTimeMs} <span style={{ fontSize: '13px', color: '#8a8a8f', fontWeight: 400 }}>ms</span>
                  </div>
                </div>

                {/* Metric Card 2: Time to First Frame */}
                <div
                  style={{
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    borderRadius: '6px',
                    padding: '14px'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#8a8a8f', marginBottom: '6px' }}>
                    <Film size={14} color="#e11d2e" />
                    <span>Time-To-First-Frame (TTFF)</span>
                  </div>
                  <div style={{ fontSize: '24px', fontWeight: 700, color: '#ffffff' }}>
                    {results.ttffMs !== null ? (
                      <>
                        {results.ttffMs} <span style={{ fontSize: '13px', color: '#8a8a8f', fontWeight: 400 }}>ms</span>
                      </>
                    ) : (
                      <span style={{ fontSize: '15px', color: '#8a8a8f', fontWeight: 400 }}>No video detected</span>
                    )}
                  </div>
                  {results.videoWidth && results.videoHeight && (
                    <div style={{ fontSize: '11px', color: '#6a6a70', marginTop: '4px' }}>
                      Resolution: {results.videoWidth} × {results.videoHeight}
                    </div>
                  )}
                </div>

                {/* Metric Card 3: Playback Smoothness & Dropped Frames */}
                <div
                  style={{
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    borderRadius: '6px',
                    padding: '14px'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#8a8a8f', marginBottom: '6px' }}>
                    <Activity size={14} color="#e11d2e" />
                    <span>Playback Smoothness</span>
                  </div>
                  <div style={{ fontSize: '24px', fontWeight: 700, color: '#ffffff' }}>
                    {results.fps !== null ? `${results.fps} FPS` : 'N/A'}
                  </div>
                  {results.droppedFrames !== null && (
                    <div style={{ fontSize: '11px', color: results.droppedFrames > 0 ? '#e11d2e' : '#4ba561', marginTop: '4px' }}>
                      {results.droppedFrames} dropped frames ({results.droppedPercent}%)
                    </div>
                  )}
                </div>

                {/* Metric Card 4: Resource Usage */}
                <div
                  style={{
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    borderRadius: '6px',
                    padding: '14px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#8a8a8f' }}>
                    <Cpu size={14} color="#e11d2e" />
                    <span>Session Resource Usage</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '12px', color: '#b0b0b5' }}>Memory Usage</span>
                    <span style={{ fontSize: '14px', fontWeight: 700, color: '#ffffff' }}>
                      {results.memoryMB !== null ? `${results.memoryMB} MB` : 'N/A'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '12px', color: '#b0b0b5' }}>CPU Usage</span>
                    <span style={{ fontSize: '14px', fontWeight: 700, color: '#ffffff' }}>
                      {results.cpuPercent !== null ? `${results.cpuPercent}%` : 'N/A'}
                    </span>
                  </div>
                </div>

                <div style={{ fontSize: '10px', color: '#5a5a60', textAlign: 'center', marginTop: '10px' }}>
                  Tested at {results.timestamp}
                </div>
              </div>
            ) : (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', color: '#4a4a50', textAlign: 'center' }}>
                <Activity size={32} color="#3a3a40" />
                <div style={{ fontSize: '12px' }}>Results will appear here after benchmark completes.</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default WebBenchmarkModal
