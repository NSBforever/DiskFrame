import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './MapPage.css'
import type { ScannedFile } from '../App'
import { useReducedMotionPref } from '../hooks/useReducedMotionPref'

export interface MapBounds {
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
}

export interface MapCluster {
  cx: number
  cy: number
  count: number
  lat: number
  lng: number
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
  thumb: string | null
  path: string | null
}

/** The gallery query as the map needs it. Matches the preload bridge's shape. */
export interface MapQuery {
  drive: string
  nav: string
  search: string
  groupBy: string
  order: string
  bbox?: MapBounds | null
}

export interface MapPageProps {
  /** The gallery's current query, minus any box. Filters and search apply here too. */
  query: MapQuery | null
  onOpenFile: (file: ScannedFile, list: ScannedFile[], e?: React.MouseEvent) => void
}

/** How many files a place panel loads at a time. */
const PLACE_PAGE = 60
/** Below this the map stops splitting and opens the place instead. */
const MAX_SPLIT_ZOOM = 17

function mediaUrl(p: string): string {
  return 'media:///' + p.replace(/\\/g, '/')
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/**
 * A cluster's own extent, widened just enough that a place made of files at a
 * single coordinate still has a box a query can match.
 */
function clusterBounds(c: MapCluster): MapBounds {
  const padLat = Math.max((c.maxLat - c.minLat) * 0.08, 0.0004)
  const padLng = Math.max((c.maxLng - c.minLng) * 0.08, 0.0004)
  return {
    minLat: c.minLat - padLat,
    maxLat: c.maxLat + padLat,
    minLng: c.minLng - padLng,
    maxLng: c.maxLng + padLng
  }
}

function placeLabel(c: MapCluster): string {
  const ns = c.lat >= 0 ? 'N' : 'S'
  const ew = c.lng >= 0 ? 'E' : 'W'
  return `${Math.abs(c.lat).toFixed(3)}° ${ns}, ${Math.abs(c.lng).toFixed(3)}° ${ew}`
}

/**
 * The map view: thumbnail clusters over a tile map, sized to the viewport.
 *
 * Clusters are computed in SQLite for the visible box and the current zoom, so
 * the renderer never holds a marker or a thumbnail per file - panning a map
 * over a hundred thousand photos costs the same as over a hundred. Every
 * request carries a generation number and late replies from a superseded pan
 * or zoom are dropped rather than painted.
 */
export default function MapPage({ query, onOpenFile }: MapPageProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
  const reducedMotion = useReducedMotionPref()

  const [clusters, setClusters] = useState<MapCluster[]>([])
  const [loading, setLoading] = useState(true)
  /** null until the first answer, so "no location data" is never shown early. */
  const [anyLocated, setAnyLocated] = useState<boolean | null>(null)
  const [tileTrouble, setTileTrouble] = useState(false)
  const [place, setPlace] = useState<MapCluster | null>(null)

  // Superseded requests must not paint. Bumped on every fetch and on unmount.
  const genRef = useRef(0)
  const debounceRef = useRef<number | undefined>(undefined)
  const queryRef = useRef(query)
  queryRef.current = query
  // Where the camera was before a place was opened, so Back can restore it.
  const cameraRef = useRef<{ center: L.LatLng; zoom: number } | null>(null)

  const queryKey = useMemo(() => JSON.stringify(query ?? null), [query])

  const fetchClusters = useCallback(() => {
    const map = mapRef.current
    const q = queryRef.current
    if (!map || !q) return
    const b = map.getBounds()
    const zoom = map.getZoom()
    const generation = ++genRef.current
    setLoading(true)
    window.api
      .mapClusters(q, zoom, {
        minLat: b.getSouth(),
        maxLat: b.getNorth(),
        minLng: b.getWest(),
        maxLng: b.getEast()
      })
      .then((res: { clusters?: MapCluster[] }) => {
        if (generation !== genRef.current) return
        setClusters(res?.clusters ?? [])
        setLoading(false)
      })
      .catch(() => {
        if (generation !== genRef.current) return
        setClusters([])
        setLoading(false)
      })
  }, [])

  const scheduleFetch = useCallback(() => {
    window.clearTimeout(debounceRef.current)
    // Rapid pans and pinches produce a burst of moveend events; only the
    // settled viewport is worth a query.
    debounceRef.current = window.setTimeout(fetchClusters, 220)
  }, [fetchClusters])

  // ── map lifecycle ───────────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current
    if (!host || mapRef.current) return
    const map = L.map(host, {
      zoomControl: true,
      attributionControl: false,
      worldCopyJump: true,
      zoomAnimation: !reducedMotion,
      fadeAnimation: !reducedMotion
    }).setView([20, 0], 2)
    mapRef.current = map
    layerRef.current = L.layerGroup().addTo(map)

    const tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      crossOrigin: true
    })
    // Tiles come from the network. If they cannot be fetched the map still
    // works - markers, zooming and places are all local - so this says so
    // rather than leaving the user looking at a blank grey square.
    tiles.on('tileerror', () => setTileTrouble(true))
    tiles.on('tileload', () => setTileTrouble(false))
    tiles.addTo(map)

    map.on('moveend', scheduleFetch)
    map.on('zoomend', scheduleFetch)

    // The map is built before its flex parent has been laid out, so Leaflet
    // measures a zero-sized container and every bound collapses to a single
    // point - which asked SQLite for clusters inside a box of no area and got
    // nothing back. Re-measure whenever the container resizes, including the
    // first time it gains a size, and ask again.
    const ro = new ResizeObserver(() => {
      map.invalidateSize({ animate: false })
      scheduleFetch()
    })
    ro.observe(host)
    fetchClusters()

    return () => {
      genRef.current++
      window.clearTimeout(debounceRef.current)
      ro.disconnect()
      map.off('moveend', scheduleFetch)
      map.off('zoomend', scheduleFetch)
      map.remove()
      mapRef.current = null
      layerRef.current = null
    }
    // Built once. Reduced-motion changes are picked up on the next mount,
    // which is the right trade for not tearing the map down mid-interaction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-query when the gallery's filter or search changes.
  useEffect(() => {
    if (!mapRef.current) return
    setAnyLocated(null)
    fetchClusters()
  }, [queryKey, fetchClusters])

  // "No location data" is about the library, not about this viewport, so it is
  // decided by a separate unbounded look rather than by an empty pan.
  useEffect(() => {
    if (!query) return
    let cancelled = false
    window.api
      .mapClusters(query, 1, { minLat: -90, maxLat: 90, minLng: -180, maxLng: 180 })
      .then((res: { clusters?: MapCluster[] }) => {
        if (cancelled) return
        const found = (res?.clusters ?? []).length > 0
        setAnyLocated(found)
        // Frame everything that does have coordinates, once.
        const map = mapRef.current
        if (found && map) {
          map.invalidateSize({ animate: false })
          const all = res!.clusters!
          const bounds = L.latLngBounds(
            [Math.min(...all.map((c) => c.minLat)), Math.min(...all.map((c) => c.minLng))],
            [Math.max(...all.map((c) => c.maxLat)), Math.max(...all.map((c) => c.maxLng))]
          )
          map.fitBounds(bounds, { padding: [56, 56], maxZoom: 12, animate: false })
        }
      })
      .catch(() => {
        if (!cancelled) setAnyLocated(null)
      })
    return () => {
      cancelled = true
    }
  }, [queryKey, query])

  // ── markers ─────────────────────────────────────────────────────────
  const openCluster = useCallback((c: MapCluster) => {
    const map = mapRef.current
    if (map) cameraRef.current = { center: map.getCenter(), zoom: map.getZoom() }
    setPlace(c)
  }, [])

  useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (!map || !layer) return
    layer.clearLayers()

    for (const c of clusters) {
      const badge =
        c.count > 1 ? `<span class="map-pin-count">${c.count.toLocaleString()}</span>` : ''
      const inner = c.thumb
        ? `<img src="${escapeAttr(mediaUrl(c.thumb))}" alt="" draggable="false" />`
        : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:#8a8a8f"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>'
      const marker = L.marker([c.lat, c.lng], {
        icon: L.divIcon({
          className: '',
          html: `<div class="map-pin"><div class="map-pin-body">${inner}</div><span class="map-pin-tail"></span>${badge}</div>`,
          iconSize: [56, 64],
          iconAnchor: [28, 64]
        }),
        keyboard: true,
        title: `${c.count.toLocaleString()} file${c.count === 1 ? '' : 's'} near ${placeLabel(c)}`
      })

      marker.on('click', () => {
        const spans = c.maxLat - c.minLat > 1e-6 || c.maxLng - c.minLng > 1e-6
        // Zoom into a cluster that can still be broken up; otherwise there is
        // nothing left to split, so show what is actually there.
        if (c.count > 1 && spans && map.getZoom() < MAX_SPLIT_ZOOM) {
          const b = clusterBounds(c)
          map.flyToBounds(
            L.latLngBounds([b.minLat, b.minLng], [b.maxLat, b.maxLng]),
            { padding: [70, 70], maxZoom: MAX_SPLIT_ZOOM, animate: !reducedMotion, duration: 0.6 }
          )
        } else {
          openCluster(c)
        }
      })
      marker.addTo(layer)
    }
  }, [clusters, reducedMotion, openCluster])

  const closePlace = useCallback(() => {
    setPlace(null)
    const map = mapRef.current
    const cam = cameraRef.current
    if (map && cam) {
      map.setView(cam.center, cam.zoom, { animate: !reducedMotion })
      cameraRef.current = null
    }
  }, [reducedMotion])

  const total = useMemo(() => clusters.reduce((n, c) => n + c.count, 0), [clusters])

  return (
    <div className="map-page">
      <div ref={hostRef} className="map-canvas" />

      {anyLocated === false && (
        <div className="map-empty">
          <div className="map-empty-title">No location data</div>
          <div className="map-empty-note">
            None of the files in this view carry coordinates, so there is nothing to place on the
            map. Photos keep their location only if it was recorded when they were taken.
          </div>
        </div>
      )}

      {anyLocated !== false && (
        <div className="map-overlay map-status" aria-live="polite">
          {loading
            ? 'Loading places…'
            : `${clusters.length} place${clusters.length === 1 ? '' : 's'} · ${total.toLocaleString()} file${total === 1 ? '' : 's'}`}
        </div>
      )}

      {tileTrouble && anyLocated !== false && (
        <div className="map-overlay map-tile-warning">
          Map tiles unavailable — places are still plotted
        </div>
      )}

      {place && (
        <PlacePanel
          cluster={place}
          query={query}
          onClose={closePlace}
          onOpenFile={onOpenFile}
        />
      )}
    </div>
  )
}

/**
 * The files at one place, read a page at a time through the ordinary library
 * query with a box attached - so grouping, ordering and pagination are the
 * same code the gallery uses.
 */
function PlacePanel({
  cluster,
  query,
  onClose,
  onOpenFile
}: {
  cluster: MapCluster
  query: MapQuery | null
  onClose: () => void
  onOpenFile: (file: ScannedFile, list: ScannedFile[], e?: React.MouseEvent) => void
}): React.JSX.Element {
  const [rows, setRows] = useState<ScannedFile[]>([])
  const [total, setTotal] = useState(cluster.count)
  const [busy, setBusy] = useState(false)
  const genRef = useRef(0)

  const boxedQuery = useMemo(
    () => (query ? { ...query, bbox: clusterBounds(cluster) } : null),
    [query, cluster]
  )

  const loadMore = useCallback(
    (from: number) => {
      if (!boxedQuery) return
      const generation = genRef.current
      setBusy(true)
      window.api
        .libraryPage(boxedQuery, from, PLACE_PAGE)
        .then((res: { rows?: ScannedFile[] }) => {
          if (generation !== genRef.current) return
          setRows((prev) => (from === 0 ? (res?.rows ?? []) : prev.concat(res?.rows ?? [])))
          setBusy(false)
        })
        .catch(() => {
          if (generation !== genRef.current) return
          setBusy(false)
        })
    },
    [boxedQuery]
  )

  useEffect(() => {
    genRef.current++
    setRows([])
    if (!boxedQuery) return
    const generation = genRef.current
    window.api
      .librarySummary(boxedQuery)
      .then((res: { total?: number }) => {
        if (generation !== genRef.current) return
        setTotal(res?.total ?? cluster.count)
      })
      .catch(() => undefined)
    loadMore(0)
  }, [boxedQuery, loadMore, cluster.count])

  return (
    <aside className="map-overlay map-place" aria-label="Files at this place">
      <div className="map-place-head">
        <div className="map-place-title">
          {placeLabel(cluster)}
          <div className="map-place-sub">
            {total.toLocaleString()} file{total === 1 ? '' : 's'}
          </div>
        </div>
        <button type="button" className="map-btn" onClick={onClose}>
          Back to map
        </button>
      </div>

      <div className="map-place-grid">
        {rows.map((f) => (
          <button
            key={f.path}
            type="button"
            className="map-place-tile"
            title={f.name}
            onClick={(e) => onOpenFile(f, rows, e)}
          >
            {f.thumb ? <img src={mediaUrl(f.thumb)} alt="" draggable={false} /> : null}
          </button>
        ))}
      </div>

      {rows.length < total && (
        <div className="map-place-foot">
          <button
            type="button"
            className="map-btn"
            disabled={busy}
            onClick={() => loadMore(rows.length)}
          >
            {busy ? 'Loading…' : `Load ${Math.min(PLACE_PAGE, total - rows.length)} more`}
          </button>
        </div>
      )}
    </aside>
  )
}
