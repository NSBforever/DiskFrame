import React, { useState, useMemo } from 'react'
import Fuse from 'fuse.js'
import { FileTile } from '../App'
import { Search } from 'lucide-react'

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

interface SearchAgentProps {
  files: ScannedFile[]
  favourites: Set<string>
  onOpen: (file: ScannedFile, list: ScannedFile[]) => void
  onFav: (file: ScannedFile) => void
  selectedPaths: Set<string>
  onSelect: (file: ScannedFile, e: React.MouseEvent) => void
  onContextMenu: (file: ScannedFile, list: ScannedFile[], e: React.MouseEvent) => void
}

const CITIES = [
  { name: 'Jaipur', lat: 26.9124, lng: 75.7873 },
  { name: 'Hyderabad', lat: 17.3850, lng: 78.4867 },
  { name: 'Chennai', lat: 13.0827, lng: 80.2707 },
  { name: 'Bengaluru', lat: 12.9716, lng: 77.5946 },
  { name: 'Mumbai', lat: 19.0760, lng: 72.8777 },
  { name: 'Delhi', lat: 28.6139, lng: 77.2090 },
  { name: 'Kolkata', lat: 22.5726, lng: 88.3639 },
  { name: 'Pune', lat: 18.5204, lng: 73.8567 },
  { name: 'Ahmedabad', lat: 23.0225, lng: 72.5714 },
  { name: 'Kochi', lat: 9.9312, lng: 76.2673 },
  { name: 'Paris', lat: 48.8566, lng: 2.3522 },
  { name: 'London', lat: 51.5074, lng: -0.1278 },
  { name: 'New York', lat: 40.7128, lng: -74.0060 },
  { name: 'San Francisco', lat: 37.7749, lng: -122.4194 },
  { name: 'Tokyo', lat: 35.6762, lng: 139.6503 },
  { name: 'Singapore', lat: 1.3521, lng: 103.8198 },
  { name: 'Sydney', lat: -33.8688, lng: 151.2093 }
]

function getCityFromCoords(lat: number | null, lng: number | null): string | null {
  if (lat === null || lng === null) return null
  for (const city of CITIES) {
    const dist = Math.sqrt((city.lat - lat) ** 2 + (city.lng - lng) ** 2)
    if (dist < 0.5) return city.name
  }
  return null
}

export function ApertureLogo(): React.JSX.Element {
  return (
    <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ width: '80px', height: '80px' }}>
      <circle cx="50" cy="50" r="44" stroke="#e11d2e" strokeWidth="3" style={{ filter: 'drop-shadow(0px 0px 8px rgba(225,29,46,0.6))' }} />
      <path d="M50 6 L50 44 L83 22" stroke="#e11d2e" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M83 22 L55 36 L68 70" stroke="#e11d2e" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M68 70 L39 52 L45 88" stroke="#e11d2e" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M45 88 L32 58 L12 65" stroke="#e11d2e" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M12 65 L30 46 L15 30" stroke="#e11d2e" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M15 30 L41 38 L50 6" stroke="#e11d2e" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="48" cy="46" r="10" fill="none" stroke="#e11d2e" strokeWidth="1.5" strokeDasharray="3 3" />
    </svg>
  )
}

export async function resolveQueryWithLLM(query: string, localResults: ScannedFile[]): Promise<ScannedFile[]> {
  console.log(`[AI Search Agent] LLM resolver stub called for: "${query}" with ${localResults.length} initial items.`);
  return localResults;
}

export default function SearchAgent({
  files,
  favourites,
  onOpen,
  onFav,
  selectedPaths,
  onSelect,
  onContextMenu
}: SearchAgentProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [activeQuery, setActiveQuery] = useState('')

  // Pre-calculate cities and dates for fast querying
  const enrichedFiles = useMemo(() => {
    return files.map((f) => ({
      ...f,
      cityName: getCityFromCoords(f.lat, f.lng) || '',
      monthName: f.month || '',
      yearName: f.year || ''
    }))
  }, [files])

  // Extract query filters offline
  const parsedQuery = useMemo(() => {
    if (!activeQuery.trim()) return null
    const q = activeQuery.toLowerCase().trim()

    let type: 'photo' | 'video' | 'doc' | 'screenshot' | null = null
    if (/\b(photo|photos|image|images|picture|pictures|png|jpg|jpeg|webp)\b/i.test(q)) {
      type = 'photo'
    } else if (/\b(video|videos|movie|movies|film|films|mp4|mov|avi)\b/i.test(q)) {
      type = 'video'
    } else if (/\b(document|documents|doc|docs|pdf|pdfs|text|txt)\b/i.test(q)) {
      type = 'doc'
    } else if (/\b(screenshot|screenshots|captures|capture)\b/i.test(q)) {
      type = 'screenshot'
    }

    let favouriteOnly = false
    if (/\b(favourite|favourites|favorite|favorites|starred|liked|favs|fav)\b/i.test(q)) {
      favouriteOnly = true
    }

    const months = [
      'january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december',
      'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'
    ]
    let monthTarget: string | null = null
    for (const m of months) {
      if (new RegExp(`\\b${m}\\b`, 'i').test(q)) {
        monthTarget = m
        break
      }
    }

    let yearTarget: string | null = null
    const yearMatch = q.match(/\b(20\d{2})\b/)
    if (yearMatch) {
      yearTarget = yearMatch[1]
    } else if (/\b(last year)\b/i.test(q)) {
      yearTarget = (new Date().getFullYear() - 1).toString()
    } else if (/\b(this year)\b/i.test(q)) {
      yearTarget = new Date().getFullYear().toString()
    }

    let cityTarget: string | null = null
    for (const city of CITIES) {
      if (new RegExp(`\\b${city.name.toLowerCase()}\\b`, 'i').test(q)) {
        cityTarget = city.name
        break
      }
    }

    const cleanTerms = q
      .replace(/\b(photos|photo|images|image|pictures|picture|videos|video|movies|movie|documents|document|docs|doc|screenshots|screenshot|favourites|favourite|favorites|favorite|starred|liked|last year|this year|from|in|at|on|of|with|show|find|search|is:fav|fav:true)\b/gi, '')
      .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/gi, '')
      .replace(/\b(20\d{2})\b/g, '')
      .trim()

    return { type, favouriteOnly, monthTarget, yearTarget, cityTarget, cleanTerms }
  }, [activeQuery])

  // Run filtering based on parsed criteria and fuzzy match leftover text
  const results = useMemo(() => {
    if (!activeQuery.trim() || !parsedQuery) return []
    let filtered = enrichedFiles

    if (parsedQuery.type === 'photo') {
      filtered = filtered.filter((f) => ['.jpg', '.jpeg', '.png', '.webp', '.heic'].includes(f.ext.toLowerCase()))
    } else if (parsedQuery.type === 'video') {
      filtered = filtered.filter((f) => ['.mp4', '.mov', '.avi', '.mkv', '.wmv'].includes(f.ext.toLowerCase()))
    } else if (parsedQuery.type === 'doc') {
      filtered = filtered.filter((f) => ['.pdf', '.docx', '.doc', '.txt', '.xlsx', '.pptx', '.csv'].includes(f.ext.toLowerCase()))
    } else if (parsedQuery.type === 'screenshot') {
      filtered = filtered.filter((f) => f.path.toLowerCase().includes('screenshot') || f.path.toLowerCase().includes('screen shot'))
    }

    if (parsedQuery.favouriteOnly) {
      filtered = filtered.filter((f) => favourites.has(f.path))
    }

    if (parsedQuery.monthTarget) {
      const mTarget = parsedQuery.monthTarget.toLowerCase().substring(0, 3)
      filtered = filtered.filter((f) => f.monthName.toLowerCase().startsWith(mTarget))
    }

    if (parsedQuery.yearTarget) {
      filtered = filtered.filter((f) => f.yearName === parsedQuery.yearTarget)
    }

    if (parsedQuery.cityTarget) {
      filtered = filtered.filter((f) => f.cityName.toLowerCase() === parsedQuery.cityTarget!.toLowerCase())
    }

    if (parsedQuery.cleanTerms) {
      const fuse = new Fuse(filtered, {
        keys: ['name', 'path', 'cityName'],
        threshold: 0.45
      })
      return fuse.search(parsedQuery.cleanTerms).map((r) => r.item)
    }

    return filtered
  }, [enrichedFiles, activeQuery, parsedQuery, favourites])

  // Generate dynamic suggestion chips seeded from actual database contents
  const suggestionChips = useMemo(() => {
    const chips: string[] = []
    const cities = Array.from(new Set(enrichedFiles.map((f) => f.cityName).filter(Boolean)))
    const months = Array.from(new Set(enrichedFiles.map((f) => f.monthName).filter(Boolean)))
    const years = Array.from(new Set(enrichedFiles.map((f) => f.yearName).filter(Boolean)))

    if (cities.length > 0) {
      chips.push(`Photos from ${cities[0]}`)
      if (cities.length > 1) {
        chips.push(`Videos from ${cities[1]}`)
      }
    }
    if (months.length > 0) {
      chips.push(`Photos from ${months[0]}`)
    }
    if (years.length > 0) {
      chips.push(`Favourites from ${years[0]}`)
    }

    if (chips.length === 0) {
      chips.push('Photos from last year')
      chips.push('Starred videos')
      chips.push('Screenshots')
    }

    return chips.slice(0, 4)
  }, [enrichedFiles])

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setActiveQuery(query)
    resolveQueryWithLLM(query, results)
  }

  const handleChipClick = (chipText: string) => {
    setQuery(chipText)
    setActiveQuery(chipText)
  }

  const hasSearch = !!activeQuery.trim()

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Intro Dashboard Card */}
      <div
        className="cred-glass"
        style={{
          width: '580px',
          maxWidth: '90%',
          margin: hasSearch ? '10px auto' : '10vh auto 30px',
          borderRadius: '4px',
          padding: hasSearch ? '16px 24px' : '36px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: hasSearch ? '12px' : '20px',
          border: '1px solid rgba(225, 29, 46, 0.25)',
          boxShadow: 'none',
          transition: 'all 0.4s cubic-bezier(0.22, 1, 0.36, 1)',
          position: 'relative'
        }}
      >
        {!hasSearch && (
          <>
            <div style={{ animation: 'tileSpin 10s linear infinite', display: 'inline-flex' }}>
              <ApertureLogo />
            </div>
            <div style={{ textAlign: 'center' }}>
              <h2 style={{ fontSize: '20px', fontWeight: 700, color: '#f2f2f0', margin: 0 }}>
                DiskFrame Search Agent
              </h2>
              <p style={{ fontSize: '11px', color: '#8a8a8f', marginTop: '6px', maxWidth: '380px', lineHeight: 1.5 }}>
                Enter natural queries to search your local index for file types, creation dates, favorites, and GPS locations.
              </p>
            </div>
          </>
        )}

        {/* Chat input box */}
        <form onSubmit={handleSearchSubmit} style={{ width: '100%', display: 'flex', gap: '8px' }}>
          <input
            type="text"
            placeholder="Ask DiskFrame agent (e.g. 'photos from march', 'videos from Chennai')..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="cred-input"
            style={{ flex: 1, padding: '10px 16px', border: '1px solid rgba(225,29,46,0.15)', height: '40px', fontSize: '13px' }}
          />
          <button
            type="submit"
            className="cred-button"
            style={{
              background: '#e11d2e',
              color: '#f2f2f0',
              border: 'none',
              padding: '0 20px',
              height: '40px',
              borderRadius: '4px',
              fontWeight: 600,
              fontSize: '13px'
            }}
          >
            Ask
          </button>
        </form>

        {/* Suggestion Chips */}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center', width: '100%', marginTop: '4px' }}>
          {!hasSearch && <span style={{ fontSize: '11px', color: '#8a8a8f', alignSelf: 'center', marginRight: '4px' }}>Try now:</span>}
          {suggestionChips.map((chip) => (
            <div
              key={chip}
              onClick={() => handleChipClick(chip)}
              style={{
                fontSize: '11px',
                padding: '4px 12px',
                borderRadius: '16px',
                border: '1px solid rgba(225, 29, 46, 0.2)',
                background: 'rgba(225, 29, 46, 0.05)',
                color: '#8a8a8f',
                cursor: 'pointer',
                transition: 'all 0.25s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = '#f2f2f0'
                e.currentTarget.style.borderColor = '#e11d2e'
                e.currentTarget.style.background = 'rgba(225, 29, 46, 0.15)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = '#8a8a8f'
                e.currentTarget.style.borderColor = 'rgba(225, 29, 46, 0.2)'
                e.currentTarget.style.background = 'rgba(225, 29, 46, 0.05)'
              }}
            >
              {chip}
            </div>
          ))}
        </div>
      </div>

      {/* Grid Results */}
      {hasSearch && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '0 20px 20px' }} className="view-transition-enter">
          <div style={{ fontSize: '13px', color: '#8a8a8f', marginBottom: '12px', fontWeight: 500, paddingLeft: '4px' }}>
            Found {results.length} match{results.length !== 1 ? 'es' : ''} for query "{activeQuery}"
          </div>
          {results.length === 0 ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '12px',
                background: '#0e0e11',
                borderRadius: '4px',
                border: '1px solid rgba(255,255,255,0.04)'
              }}
            >
              <Search size={32} style={{ color: '#52525b' }} />
              <div style={{ fontSize: '13px', color: '#8a8a8f' }}>No matching items found.</div>
              <div style={{ fontSize: '11px', color: '#52525b' }}>Try broadening your search or modifying keywords.</div>
            </div>
          ) : (
            <div style={{ flex: 1, overflowY: 'auto', paddingRight: '4px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: '5px' }}>
                {results.map((file) => (
                  <FileTile
                    key={file.path}
                    file={file}
                    onOpen={(f) => onOpen(f, results)}
                    onFav={onFav}
                    isFav={favourites.has(file.path)}
                    isSelected={selectedPaths.has(file.path)}
                    onSelect={onSelect}
                    onContextMenu={(f, e) => onContextMenu(f, results, e)}
                    tileSize={100}
                    selectedPaths={Array.from(selectedPaths)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
