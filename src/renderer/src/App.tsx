import { useState } from 'react'
import './assets/main.css'

function App(): React.JSX.Element {
  const [activeNav, setActiveNav] = useState('all')

  return (
    <div style={{
      display: 'flex',
      height: '100vh',
      background: '#0f0f10',
      color: '#e8e8ea',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '13px',
      overflow: 'hidden'
    }}>
      {/* Sidebar */}
      <div style={{
        width: '200px',
        background: '#161618',
        borderRight: '0.5px solid #2a2a2e',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0
      }}>
        <div style={{ padding: '16px 14px 12px', borderBottom: '0.5px solid #2a2a2e' }}>
          <div style={{ fontSize: '15px', fontWeight: 500, color: '#f0f0f2', letterSpacing: '-0.3px' }}>DiskFrame</div>
          <div style={{ fontSize: '11px', color: '#5a5a62', marginTop: '2px' }}>Smart file organiser</div>
        </div>

        {/* Drive Card */}
        <div style={{ margin: '12px 10px', background: '#1e1e22', borderRadius: '10px', padding: '10px 12px', border: '0.5px solid #2e2e36' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 500, color: '#c8c8d0' }}>
            <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#4cd97b' }}></div>
            Samsung T7 Pro
          </div>
          <div style={{ fontSize: '10px', color: '#5a5a62', marginTop: '4px' }}>2.0 TB · 1.36 TB used</div>
          <div style={{ height: '3px', background: '#2a2a2e', borderRadius: '2px', marginTop: '8px' }}>
            <div style={{ height: '100%', width: '68%', background: '#6c6cff', borderRadius: '2px' }}></div>
          </div>
        </div>

        {/* Nav */}
        <div style={{ padding: '10px 10px 4px' }}>
          <div style={{ fontSize: '10px', color: '#44444e', textTransform: 'uppercase', letterSpacing: '0.8px', padding: '0 4px', marginBottom: '4px' }}>Browse</div>
          {[
            { id: 'all', label: 'All files', count: '4,821' },
            { id: 'photos', label: 'Photos', count: '3,204' },
            { id: 'videos', label: 'Videos', count: '617' },
            { id: 'docs', label: 'Documents', count: '1,000' },
          ].map(item => (
            <div key={item.id} onClick={() => setActiveNav(item.id)} style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '6px 8px', borderRadius: '7px', cursor: 'pointer',
              color: activeNav === item.id ? '#e8e8f4' : '#9090a0',
              background: activeNav === item.id ? '#252530' : 'transparent'
            }}>
              <span style={{ flex: 1 }}>{item.label}</span>
              <span style={{ fontSize: '10px', color: '#44444e' }}>{item.count}</span>
            </div>
          ))}
        </div>

        <div style={{ padding: '10px 10px 4px' }}>
          <div style={{ fontSize: '10px', color: '#44444e', textTransform: 'uppercase', letterSpacing: '0.8px', padding: '0 4px', marginBottom: '4px' }}>Events</div>
          {['Goa Trip', 'Graduation Day', 'Hostel Memories'].map(event => (
            <div key={event} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '7px', cursor: 'pointer', color: '#9090a0' }}>
              <span style={{ fontSize: '12px' }}>★</span>
              <span style={{ flex: 1 }}>{event}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Topbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 18px', borderBottom: '0.5px solid #2a2a2e', background: '#0f0f10' }}>
          <div style={{ flex: 1, fontSize: '13px', color: '#6060a0' }}>
            Samsung T7 Pro › <span style={{ color: '#e8e8f4' }}>2024</span>
          </div>
          <div style={{ display: 'flex', gap: '2px', background: '#1a1a1e', borderRadius: '7px', padding: '2px' }}>
            {['Grid', 'Timeline', 'Map'].map(v => (
              <div key={v} style={{ padding: '4px 8px', borderRadius: '5px', cursor: 'pointer', fontSize: '11px', background: v === 'Grid' ? '#252530' : 'transparent', color: v === 'Grid' ? '#c0c0e0' : '#5a5a70' }}>{v}</div>
            ))}
          </div>
          <div style={{ fontSize: '11px', color: '#5a5a70', background: '#1a1a1e', border: '0.5px solid #2a2a2e', borderRadius: '6px', padding: '4px 10px', cursor: 'pointer' }}>Sort: Date ↓</div>
        </div>

        {/* Photo Grid */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '10px' }}>
            <div style={{ fontSize: '15px', fontWeight: 500, color: '#e0e0f0' }}>December 2024</div>
            <div style={{ fontSize: '11px', color: '#44444e' }}>· 142 files</div>
            <div style={{ fontSize: '10px', color: '#8080c0', background: '#1a1a2e', border: '0.5px solid #2a2a4e', borderRadius: '5px', padding: '2px 7px', marginLeft: '6px' }}>★ Goa Trip</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '4px', marginBottom: '20px' }}>
            {['#1a3040','#2a1f3a','#1f2e20','#3a2218','#1e2040','#28201e','#1c3030','#301c28','#223020','#2a2a1c'].map((bg, i) => (
              <div key={i} style={{ background: bg, borderRadius: '6px', aspectRatio: '1', cursor: 'pointer' }}></div>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
            <div style={{ fontSize: '12px', color: '#5a5a72' }}>November</div>
            <div style={{ flex: 1, height: '0.5px', background: '#222228' }}></div>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '10px' }}>
            <div style={{ fontSize: '15px', fontWeight: 500, color: '#e0e0f0' }}>November 2024</div>
            <div style={{ fontSize: '11px', color: '#44444e' }}>· 98 files</div>
            <div style={{ fontSize: '10px', color: '#8080c0', background: '#1a1a2e', border: '0.5px solid #2a2a4e', borderRadius: '5px', padding: '2px 7px', marginLeft: '6px' }}>★ Graduation Day</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px' }}>
            {['#1e2840','#28181a','#1a2820','#2e2018','#181e30','#201e28'].map((bg, i) => (
              <div key={i} style={{ background: bg, borderRadius: '6px', aspectRatio: '4/3', cursor: 'pointer' }}></div>
            ))}
          </div>
        </div>

        {/* Status bar */}
        <div style={{ borderTop: '0.5px solid #2a2a2e', padding: '8px 18px', display: 'flex', alignItems: 'center', gap: '16px', background: '#0d0d0f' }}>
          <div style={{ fontSize: '11px', color: '#44444e' }}><span style={{ color: '#8080a8' }}>4,821</span> total files</div>
          <div style={{ fontSize: '11px', color: '#44444e' }}><span style={{ color: '#8080a8' }}>3,204</span> photos</div>
          <div style={{ fontSize: '11px', color: '#44444e' }}><span style={{ color: '#8080a8' }}>617</span> videos</div>
          <div style={{ marginLeft: 'auto', fontSize: '10px', color: '#4cd97b', background: 'rgba(76,217,123,0.1)', border: '0.5px solid rgba(76,217,123,0.3)', borderRadius: '4px', padding: '2px 8px' }}>+ 1,240 new files detected</div>
        </div>
      </div>
    </div>
  )
}

export default App