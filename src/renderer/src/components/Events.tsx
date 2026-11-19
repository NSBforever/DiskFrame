import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  CalendarDays,
  Check,
  Home,
  Layers,
  MapPin,
  Merge,
  Pencil,
  Plane,
  Plus,
  Scissors,
  Settings2,
  Star,
  Trash2,
  X
} from 'lucide-react'
import type { CollectionCard, CollectionKind, FileRef } from '../../../main/collections'
import type { DiscoveryPrefs } from '../../../main/discovery'
import { mediaUrl } from '../../../main/mediaUrl'
import type { ScannedFile } from '../App'
import type { DayFile } from '../../../main/calendarTypes'
import { CoverCard, EventPage, OtherEvents, StatusPill, type EventRef } from './CalendarEvents'
import { bumpCalendar, useCalendarStatus, useEventsList } from '../hooks/useCalendarEvents'
import './Events.css'

/**
 * Events: one place for Google Calendar events (optional), Places, Trips and
 * the user's own collections. Places and Trips are found on this computer from
 * each photo's and video's own GPS and capture time; nothing is looked up
 * online, and a place is a name the user gives it. Suggestions are only
 * suggestions until accepted. Calendar matching reads only drives the user
 * allowed. Tiles are the gallery's own, so opening, favouriting and the
 * context menu behave exactly as they do there.
 */

export type RenderTile = (file: ScannedFile, list: ScannedFile[], size: number) => React.ReactNode
type Filter = 'all' | 'calendar' | 'places' | 'trips' | 'collections' | 'suggested'
type Open = { kind: 'collection'; id: number } | { kind: 'calendar'; drive: string; ev: EventRef }
type CalendarDrive = { drive: string; volumeId: string; name: string; allowed: boolean }
type VolumeInfo = { letter: string | null; mounted: boolean; label: string | null }
type EventsList = { cards: CollectionCard[]; volumeIds: string[]; prefs: DiscoveryPrefs }

// ── Formatting ───────────────────────────────────────────────────────────────

const dayFmt = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric'
})
const shortDay = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
const itemsWord = (n: number): string => (n === 1 ? '1 item' : `${n.toLocaleString()} items`)
const KIND_WORD: Record<CollectionKind, string> = {
  place: 'Place',
  trip: 'Trip',
  custom: 'Collection'
}

function rangeText(startMs: number | null, endMs: number | null): string | null {
  if (startMs == null || endMs == null) return null
  const a = new Date(startMs)
  const b = new Date(endMs)
  if (a.toDateString() === b.toDateString()) return dayFmt.format(a)
  if (a.getFullYear() === b.getFullYear()) return `${shortDay.format(a)} – ${dayFmt.format(b)}`
  return `${dayFmt.format(a)} – ${dayFmt.format(b)}`
}
function dates(c: CollectionCard): string | null {
  // Dates the user gave a collection they made win; otherwise the files' own.
  if (c.origin !== 'auto' && c.startMs != null) return rangeText(c.startMs, c.endMs ?? c.startMs)
  const s = c.minDate ? Date.parse(c.minDate) : c.startMs
  const e = c.maxDate ? Date.parse(c.maxDate) : c.endMs
  return rangeText(s ?? null, e ?? null)
}
/** `<input type="date">` value (local day) <-> epoch ms. */
const toDateInput = (ms: number | null): string => {
  if (ms == null) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const fromDateInput = (v: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null
}
function coordText(lat: number, lng: number): string {
  const f = (v: number, pos: string, neg: string): string =>
    `${Math.abs(v).toFixed(3)}° ${v >= 0 ? pos : neg}`
  return `${f(lat, 'N', 'S')}, ${f(lng, 'E', 'W')}`
}
/** A name the user gave, else a plain description - never a guessed place name. */
function displayName(c: Pick<CollectionCard, 'name' | 'kind' | 'startMs' | 'minDate'>): string {
  if (c.name) return c.name
  if (c.kind === 'place') return 'Unnamed place'
  const t = c.minDate ? Date.parse(c.minDate) : c.startMs
  if (c.kind === 'trip') return t ? `Trip · ${monthFmt.format(t)}` : 'Trip'
  return 'Untitled collection'
}
const CONFIDENCE: Record<string, string> = { high: 'Likely', medium: 'Possible', low: 'Unsure' }
const refOf = (f: ScannedFile): FileRef | null =>
  f.volume_id ? { path: f.path, volumeId: f.volume_id } : null
const keyOf = (f: { path: string; volume_id?: string | null }): string =>
  (f.volume_id ?? '') + '|' + f.path
const KindIcon = ({ kind, size }: { kind: CollectionKind; size: number }): React.JSX.Element =>
  kind === 'place' ? (
    <MapPin size={size} aria-hidden />
  ) : kind === 'trip' ? (
    <Plane size={size} aria-hidden />
  ) : (
    <Layers size={size} aria-hidden />
  )

// ── Data ─────────────────────────────────────────────────────────────────────

function useVolumes(): Map<string, VolumeInfo> {
  const [m, setM] = useState(new Map<string, VolumeInfo>())
  useEffect(() => {
    void window.api.driveScope().then((s) =>
      setM(
        new Map(
          s.volumes.map((v) => [
            v.volumeId,
            {
              letter: v.mountedLetter ?? (v.label?.trim() || v.letter),
              mounted: !!v.mountedLetter,
              label: v.label
            }
          ])
        )
      )
    )
  }, [])
  return m
}

/**
 * Thumbnails for tiles shown here: Events has no grid pump, so it asks for the
 * ones it shows (the same prioritised queue). A thumbnail is taken only by the
 * row of the volume it was made from.
 */
function useLiveThumbs(files: ScannedFile[] | null): ScannedFile[] {
  const [made, setMade] = useState<Record<string, string>>({})
  const missing = useMemo(() => (files ?? []).filter((f) => !f.thumb && !f.offline), [files])
  const missingKey = missing.map(keyOf).join('\u0000')
  useEffect(() => {
    if (!missing.length) return
    const want = new Set(missing.map(keyOf))
    const off = window.api.onThumbReady((d) => {
      const k = (d.volumeId ?? '') + '|' + d.filePath
      if (want.has(k)) setMade((m) => ({ ...m, [k]: d.thumbPath }))
    })
    const paths = missing.map((f) => f.path)
    void window.api.prioritizeThumbnails({
      visible: paths.slice(0, 120),
      prefetch: paths.slice(120, 600)
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps -- missingKey names the set
  }, [missingKey])
  return useMemo(
    () =>
      (files ?? []).map((f) => (!f.thumb && made[keyOf(f)] ? { ...f, thumb: made[keyOf(f)] } : f)),
    [files, made]
  )
}

/** A sharper picture for a card or a hero, made from the file when its drive is connected. */
function useCover(c: CollectionCard | null): string | null {
  // Kept with the file it was made for, so a changed cover never shows the old picture.
  const [big, setBig] = useState<{ key: string; src: string | null } | null>(null)
  const path = c?.coverPath
  const vol = c?.coverVolumeId
  const key = `${vol ?? ''}|${path ?? ''}`
  useEffect(() => {
    if (!path || !vol) return
    let live = true
    void window.api
      .collectionCover({ path, volumeId: vol })
      .then((src) => live && setBig({ key: `${vol}|${path}`, src }))
    return () => {
      live = false
    }
  }, [path, vol])
  const thumb =
    c?.coverThumb && !c.coverThumb.startsWith('!') && c.coverThumb !== 'NO_FILE'
      ? c.coverThumb
      : null
  return (big?.key === key ? big.src : null) ?? thumb
}

// ── Section ──────────────────────────────────────────────────────────────────

export function EventsSection({
  drive,
  renderTile,
  onOpenSettings
}: {
  drive: string | null
  renderTile: RenderTile
  onOpenSettings: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState<Open | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)
  const volumes = useVolumes()
  const [list, setList] = useState<EventsList | null>(null)
  const [finding, setFinding] = useState(false)

  // Only the newest request may land: switching drives while a list is loading
  // must never show (or act on) the previous drive's collections.
  const latest = useRef(0)
  const reload = useCallback(async (): Promise<void> => {
    if (!drive) return
    const n = ++latest.current
    const next = await window.api.eventsList(drive)
    if (n === latest.current) setList(next)
  }, [drive])

  const discover = useCallback(async (): Promise<boolean> => {
    if (!drive) return false
    setFinding(true)
    try {
      const r = await window.api.eventsDiscover(drive)
      return r.some((x) => x.added + x.updated + x.removed > 0)
    } finally {
      setFinding(false)
    }
  }, [drive])

  // List what is known at once, then look for anything new; a second read
  // only when discovery actually changed something.
  useEffect(() => {
    let live = true
    void (async () => {
      await reload()
      if ((await discover()) && live) await reload()
    })()
    return () => {
      live = false
    }
  }, [reload, discover])

  // Back to the list lands where the user left it.
  useEffect(() => {
    if (open === null && scroller.current) scroller.current.scrollTop = scrollTop
  }, [open, scrollTop])

  const card =
    open?.kind === 'collection' ? (list?.cards.find((c) => c.id === open.id) ?? null) : null
  const go = (o: Open): void => {
    setScrollTop(scroller.current?.scrollTop ?? 0)
    setOpen(o)
    scroller.current?.scrollTo({ top: 0 })
  }
  return (
    <div className="ev-scroll view-transition-enter" ref={scroller}>
      {open?.kind === 'calendar' ? (
        <EventPage
          drive={open.drive}
          ev={open.ev}
          onBack={() => setOpen(null)}
          // A DayFile carries every gallery-row field.
          renderTile={
            renderTile as unknown as (f: DayFile, l: DayFile[], n: number) => React.ReactNode
          }
        />
      ) : card ? (
        <CollectionPage
          key={card.id}
          card={card}
          others={list?.cards ?? []}
          volumes={volumes}
          renderTile={renderTile}
          onBack={() => setOpen(null)}
          onChanged={reload}
          onOpen={(id) => setOpen({ kind: 'collection', id })}
        />
      ) : (
        <Landing
          drive={drive}
          list={list}
          finding={finding}
          volumes={volumes}
          onChanged={reload}
          onRediscover={async () => {
            await discover()
            await reload()
          }}
          onOpen={(id) => go({ kind: 'collection', id })}
          onOpenEvent={(d, ev) => go({ kind: 'calendar', drive: d, ev })}
          onOpenSettings={onOpenSettings}
        />
      )}
    </div>
  )
}

// ── Landing ──────────────────────────────────────────────────────────────────

function Landing({
  drive,
  list,
  finding,
  volumes,
  onOpen,
  onOpenEvent,
  onOpenSettings,
  onChanged,
  onRediscover
}: {
  drive: string | null
  list: EventsList | null
  finding: boolean
  volumes: Map<string, VolumeInfo>
  onOpen: (id: number) => void
  onOpenEvent: (drive: string, ev: EventRef) => void
  onOpenSettings: () => void
  onChanged: () => Promise<void>
  onRediscover: () => Promise<void>
}): React.JSX.Element {
  const calendarDrives = useCalendarDrives(drive)
  const [filter, setFilter] = useState<Filter>('all')
  const [creating, setCreating] = useState<CollectionKind | null>(null)
  const [settings, setSettings] = useState(false)
  const cards = list?.cards ?? []
  const suggested = cards.filter((c) => c.status === 'suggested')
  const kept = cards.filter((c) => c.status !== 'suggested')
  const counts: Record<Filter, number | null> = {
    all: null,
    calendar: null,
    places: cards.filter((c) => c.kind === 'place').length,
    trips: cards.filter((c) => c.kind === 'trip').length,
    collections: cards.filter((c) => c.kind === 'custom').length,
    suggested: suggested.length
  }
  const sections: [string, CollectionCard[]][] =
    filter === 'calendar'
      ? []
      : filter === 'collections'
        ? [['Collections', kept.filter((c) => c.kind === 'custom')]]
        : filter === 'suggested'
          ? [['Suggested', suggested]]
          : filter === 'places'
            ? [
                ['Places', kept.filter((c) => c.kind === 'place')],
                ['Suggested places', suggested.filter((c) => c.kind === 'place')]
              ]
            : filter === 'trips'
              ? [
                  ['Trips', kept.filter((c) => c.kind === 'trip')],
                  ['Suggested trips', suggested.filter((c) => c.kind === 'trip')]
                ]
              : [
                  ['Suggested', suggested],
                  ['Trips', kept.filter((c) => c.kind === 'trip')],
                  ['Places', kept.filter((c) => c.kind === 'place')],
                  ['Collections', kept.filter((c) => c.kind === 'custom')]
                ]
  const decide = async (c: CollectionCard, status: 'accepted' | 'dismissed'): Promise<void> => {
    await window.api.collectionUpdate({ id: c.id, status })
    await onChanged()
  }

  return (
    <div className="ev-page">
      <header className="ev-head">
        <div>
          <h1 className="ev-title">Events</h1>
          <p className="ev-sub">
            Your calendar events (optional), and places and trips found on this computer from your
            photos’ and videos’ own location and date. Nothing about your files is sent anywhere.
          </p>
        </div>
        <div className="ev-head-actions">
          {finding && (
            <div className="ev-pill" role="status">
              Looking for places and trips…
            </div>
          )}
          <NewMenu onPick={setCreating} />
          <button
            type="button"
            className="ev-icon-btn"
            title="How places and trips are found"
            aria-label="Discovery settings"
            onClick={() => setSettings(true)}
          >
            <Settings2 size={16} />
          </button>
        </div>
      </header>

      <div className="ev-filters" role="tablist" aria-label="Show">
        {(['all', 'calendar', 'places', 'trips', 'collections', 'suggested'] as Filter[]).map(
          (f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className={`ev-chip${filter === f ? ' is-active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {FILTER_WORD[f]}
              {counts[f] !== null && <span className="ev-chip-n">{counts[f]}</span>}
            </button>
          )
        )}
      </div>

      {(filter === 'all' || filter === 'calendar') && (
        <CalendarSections
          drives={calendarDrives}
          full={filter === 'calendar'}
          onOpen={onOpenEvent}
          onOpenSettings={onOpenSettings}
        />
      )}

      {filter === 'calendar' ? null : list === null ? (
        <div className="ev-loading" aria-busy="true">
          <div className="ev-skel ev-skel-feature" />
          <div className="ev-skel" />
          <div className="ev-skel" />
        </div>
      ) : sections.every(([, cs]) => cs.length === 0) ? (
        <div className="ev-empty glass-panel">
          <MapPin size={28} className="ev-empty-icon" aria-hidden />
          <h2>
            {finding
              ? 'Looking through your photos…'
              : filter === 'suggested'
                ? 'No suggestions right now'
                : 'No places or trips yet'}
          </h2>
          <p>
            Places and trips are found from the location and capture time a camera or phone recorded
            in each file. Photos and videos without them can still go into a Place, Trip or
            collection you make yourself - right-click any of them in the gallery and choose “Add to
            collection…”.
          </p>
        </div>
      ) : (
        sections
          .filter(([, cs]) => cs.length > 0)
          .map(([title, cs]) => (
            <section key={title} className="ev-year" aria-label={title}>
              <h2 className="ev-year-label">
                {title} <span className="ev-dim">{cs.length}</span>
              </h2>
              <div className="ev-grid">
                {cs.map((c) => (
                  <Card
                    key={c.id}
                    card={c}
                    volumes={volumes}
                    onOpen={() => onOpen(c.id)}
                    onDecide={(s) => void decide(c, s)}
                  />
                ))}
              </div>
            </section>
          ))
      )}

      {creating && drive && (
        <NameDialog
          title={`New ${KIND_WORD[creating].toLowerCase()}`}
          hint={
            creating === 'place'
              ? 'Give it the name you use for it. Add photos from the gallery with right-click → Add to collection…'
              : 'Add photos from the gallery with right-click → Add to collection…'
          }
          onCancel={() => setCreating(null)}
          onSave={async (name) => {
            const id = await window.api.collectionCreate({ kind: creating, name })
            setCreating(null)
            await onChanged()
            if (id) onOpen(id)
          }}
        />
      )}
      {settings && list && (
        <SettingsDialog
          prefs={list.prefs}
          multiDrive={list.volumeIds.length > 1}
          onClose={() => setSettings(false)}
          onSaved={async () => {
            setSettings(false)
            await onRediscover()
          }}
        />
      )}
    </div>
  )
}

function NewMenu({ onPick }: { onPick: (k: CollectionKind) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="ev-new">
      <button
        type="button"
        className="df-button df-button-primary"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Plus size={15} /> New
      </button>
      {open && (
        <div className="ev-menu glass-panel" role="menu" onMouseLeave={() => setOpen(false)}>
          {(['place', 'trip', 'custom'] as CollectionKind[]).map((k) => (
            <button
              key={k}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onPick(k)
              }}
            >
              <KindIcon kind={k} size={14} /> {KIND_WORD[k]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function DriveBadges({
  ids,
  volumes
}: {
  ids: string[]
  volumes: Map<string, VolumeInfo>
}): React.JSX.Element | null {
  if (!ids.length) return null
  return (
    <span className="ev-drives">
      {ids.map((id) => {
        const v = volumes.get(id)
        return (
          <span
            key={id}
            className={`ev-drive${v && !v.mounted ? ' is-offline' : ''}`}
            title={v && !v.mounted ? 'Drive not connected' : (v?.label ?? undefined)}
          >
            {v?.letter ?? '?'}
          </span>
        )
      })}
    </span>
  )
}

function Card({
  card: c,
  volumes,
  onOpen,
  onDecide
}: {
  card: CollectionCard
  volumes: Map<string, VolumeInfo>
  onOpen: () => void
  onDecide: (s: 'accepted' | 'dismissed') => void
}): React.JSX.Element {
  const src = useCover(c)
  const [loaded, setLoaded] = useState(false)
  const name = displayName(c)
  const when = dates(c)
  const suggested = c.status === 'suggested'
  return (
    <div className={`ev-card-wrap${suggested ? ' is-suggested' : ''}`}>
      <button
        type="button"
        className="ev-card"
        onClick={onOpen}
        aria-label={`${KIND_WORD[c.kind]}: ${name}${when ? `, ${when}` : ''}, ${itemsWord(c.count)}`}
        data-collection={c.id}
      >
        {src && (
          <img
            className={`ev-card-img${loaded ? ' is-loaded' : ''}`}
            src={mediaUrl(src)}
            alt=""
            loading="lazy"
            decoding="async"
            onLoad={() => setLoaded(true)}
          />
        )}
        <span className="ev-card-shade" aria-hidden />
        <span className="ev-card-count">{itemsWord(c.count)}</span>
        <span className="ev-card-text">
          <span className="ev-card-kind">
            <KindIcon kind={c.kind} size={12} />
            {KIND_WORD[c.kind]}
            {suggested && c.confidence && (
              <span className={`ev-conf is-${c.confidence}`}>{CONFIDENCE[c.confidence]}</span>
            )}
          </span>
          <span className="ev-card-title">{name}</span>
          {when && <span className="ev-card-when">{when}</span>}
          <DriveBadges ids={c.volumes} volumes={volumes} />
        </span>
      </button>
      {suggested && (
        <div className="ev-card-decide">
          <button
            type="button"
            className="ev-tile-btn"
            title="Keep"
            aria-label={`Keep ${name}`}
            onClick={() => onDecide('accepted')}
          >
            <Check size={15} />
          </button>
          <button
            type="button"
            className="ev-tile-btn"
            title="Dismiss"
            aria-label={`Dismiss ${name}`}
            onClick={() => onDecide('dismissed')}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  )
}

// ── Calendar (optional) ──────────────────────────────────────────────────────

const FILTER_WORD: Record<Filter, string> = {
  all: 'All',
  calendar: 'Calendar',
  places: 'Places',
  trips: 'Trips',
  collections: 'Collections',
  suggested: 'Suggested'
}

/**
 * The drives Calendar events are shown for: the open drive, or every
 * connected drive in All Drives. Each one is matched separately, and only if
 * the user allowed it - two drives may hold two different people's photos.
 */
function useCalendarDrives(drive: string | null): CalendarDrive[] | null {
  const [drives, setDrives] = useState<CalendarDrive[] | null>(null)
  const [n, setN] = useState(0)
  useEffect(() => {
    let live = true
    void Promise.all([window.api.calendarConsent(), window.api.driveScope()]).then(
      ([consent, scope]) => {
        if (!live) return
        const inView =
          drive && /^[A-Z]:$/i.test(drive)
            ? null
            : new Set(scope.volumes.filter((v) => v.included).map((v) => v.volumeId))
        setDrives(
          consent
            .filter(
              (v) =>
                v.mountedLetter &&
                (inView
                  ? inView.has(v.volumeId)
                  : v.mountedLetter.toUpperCase() === drive?.toUpperCase())
            )
            .map((v) => ({
              drive: v.mountedLetter!,
              volumeId: v.volumeId,
              name:
                (v.label ?? '').trim().length > 3
                  ? `${v.label!.trim()} (${v.mountedLetter})`
                  : `Local Disk (${v.mountedLetter})`,
              allowed: v.allowed
            }))
        )
      }
    )
    const off = window.api.onDrivesUpdated(() => setN((x) => x + 1))
    return () => {
      live = false
      off()
    }
  }, [drive, n])
  return drives
}

function CalendarSections({
  drives,
  full,
  onOpen,
  onOpenSettings
}: {
  drives: CalendarDrive[] | null
  full: boolean
  onOpen: (drive: string, ev: EventRef) => void
  onOpenSettings: () => void
}): React.JSX.Element | null {
  const status = useCalendarStatus()
  const [allowedNow, setAllowedNow] = useState<Set<string>>(new Set())
  if (!drives || !status) return null
  const state = status.state
  const noAccount = state === 'unconfigured' || state === 'disconnected'
  const allowed = drives.filter((d) => d.allowed || allowedNow.has(d.volumeId))
  const blocked = drives.filter((d) => !d.allowed && !allowedNow.has(d.volumeId))
  // Saved events stay browsable offline or after a disconnect; with nothing
  // saved, only the Calendar filter says how to connect.
  return (
    <>
      {full && noAccount && (
        <div className="ev-empty glass-panel">
          <CalendarDays size={28} className="ev-empty-icon" aria-hidden />
          <h2>
            {state === 'unconfigured'
              ? 'Google Calendar is not set up in this build'
              : 'Connect Google Calendar'}
          </h2>
          <p>
            {state === 'unconfigured'
              ? 'Places, Trips and your collections work without it.'
              : 'Optional. DiskFrame reads your calendar (read-only) and finds the photos you took during each event, on this PC. Nothing about your files is sent to Google. Places, Trips and collections work without it.'}
          </p>
          {state !== 'unconfigured' && (
            <button type="button" className="df-button df-button-primary" onClick={onOpenSettings}>
              Open Settings
            </button>
          )}
        </div>
      )}
      {full &&
        !noAccount &&
        blocked.map((d) => (
          <div key={d.volumeId} className="ev-empty glass-panel">
            <CalendarDays size={28} className="ev-empty-icon" aria-hidden />
            <h2>Calendar matching is off for {d.name}</h2>
            <p>
              Only drives you choose are matched to your calendar, so photos on someone else’s drive
              are never sorted into your events.
            </p>
            <button
              type="button"
              className="df-button df-button-primary"
              onClick={() =>
                void window.api.setCalendarConsent(d.volumeId, true).then((ok) => {
                  if (!ok) return
                  setAllowedNow((s) => new Set(s).add(d.volumeId))
                  bumpCalendar()
                })
              }
            >
              Match photos on {d.drive}
            </button>
          </div>
        ))}
      {allowed.map((d) => (
        <CalendarDriveSection
          key={d.volumeId}
          d={d}
          titled={drives.length > 1}
          full={full}
          state={state}
          lastSyncAt={status.lastSyncAt ?? null}
          onOpen={onOpen}
        />
      ))}
    </>
  )
}

function CalendarDriveSection({
  d,
  titled,
  full,
  state,
  lastSyncAt,
  onOpen
}: {
  d: CalendarDrive
  titled: boolean
  full: boolean
  state: string
  lastSyncAt: string | null
  onOpen: (drive: string, ev: EventRef) => void
}): React.JSX.Element | null {
  const list = useEventsList(d.drive)
  if (!list) return null
  if (!full && list.cards.length === 0) return null
  return (
    <section className="ev-year" aria-label={`Calendar events, ${d.name}`}>
      <h2 className="ev-year-label ev-cal-head">
        <span>
          Calendar{titled ? ` · ${d.name}` : ''} <span className="ev-dim">{list.cards.length}</span>
        </span>
        {full && <StatusPill state={state} lastSyncAt={lastSyncAt} />}
      </h2>
      {list.cards.length === 0 ? (
        full && (
          <p className="ev-hint">
            No events with photos on {d.name} yet. Open an event below to add photos yourself.
          </p>
        )
      ) : (
        <div className="ev-grid">
          {list.cards.map((c) => (
            <CoverCard
              key={c.calendarId + c.eventId}
              card={c}
              featured={false}
              onOpen={() => onOpen(d.drive, c)}
            />
          ))}
        </div>
      )}
      {full && list.others.length > 0 && (
        <OtherEvents events={list.others} onOpen={(ev) => onOpen(d.drive, ev)} />
      )}
    </section>
  )
}

// ── Collection page ──────────────────────────────────────────────────────────

const PAGE = 600

function CollectionPage({
  card: c,
  others,
  volumes,
  renderTile,
  onBack,
  onChanged,
  onOpen
}: {
  card: CollectionCard
  others: CollectionCard[]
  volumes: Map<string, VolumeInfo>
  renderTile: RenderTile
  onBack: () => void
  onChanged: () => Promise<void>
  onOpen: (id: number) => void
}): React.JSX.Element {
  const [raw, setRaw] = useState<ScannedFile[] | null>(null)
  const [shown, setShown] = useState(PAGE)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState<'rename' | 'split' | 'merge' | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const load = useCallback(async () => setRaw(await window.api.collectionFiles(c.id)), [c.id])
  useEffect(() => {
    let live = true
    void window.api.collectionFiles(c.id).then((rows) => live && setRaw(rows))
    return () => {
      live = false
    }
  }, [c.id])
  const files = useLiveThumbs(raw)
  // The viewer pages only through files it can actually show.
  const viewable = useMemo(() => files.filter((f) => !f.offline), [files])
  const src = useCover(c)
  const name = displayName(c)
  const suggested = c.status === 'suggested'
  const word = KIND_WORD[c.kind].toLowerCase()
  const pickedRefs = (): FileRef[] =>
    files
      .filter((f) => picked.has(keyOf(f)))
      .map(refOf)
      .filter((r): r is FileRef => !!r)
  const after = async (msg: string): Promise<void> => {
    setPicked(new Set())
    setNote(msg)
    await Promise.all([load(), onChanged()])
  }
  const togglePick = (k: string): void =>
    setPicked((p) => {
      const n = new Set(p)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })

  // Esc goes back - unless a dialog or the viewer has it (both take Esc first).
  useEffect(() => {
    const onKey = (k: KeyboardEvent): void => {
      if (k.key !== 'Escape' || dialog || k.defaultPrevented) return
      onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack, dialog])

  const mergeTargets = others.filter(
    (o) => o.id !== c.id && o.kind === c.kind && o.status !== 'dismissed'
  )
  return (
    <div className="ev-page">
      <button type="button" className="ev-back" onClick={onBack}>
        <ArrowLeft size={16} /> Events
      </button>

      <section className={`ev-hero${src ? '' : ' is-plain'}`} aria-label={name}>
        {src && <img className="ev-hero-img" src={mediaUrl(src)} alt="" decoding="async" />}
        <span className="ev-card-shade" aria-hidden />
        <div className="ev-hero-text">
          <div className="ev-card-kind">
            <KindIcon kind={c.kind} size={13} />
            {KIND_WORD[c.kind]}
            {suggested && (
              <span className={`ev-conf is-${c.confidence ?? 'low'}`}>
                Suggested · {CONFIDENCE[c.confidence ?? 'low']}
              </span>
            )}
          </div>
          <h1 className="ev-hero-title">{name}</h1>
          <div className="ev-hero-when">
            {[dates(c), itemsWord(c.count)].filter(Boolean).join(' · ')}
          </div>
          {c.note && <div className="ev-hero-where">{c.note}</div>}
          {c.lat != null && c.lng != null && (
            <div
              className="ev-hero-where"
              title="The middle of where these were taken, from their own GPS"
            >
              <MapPin size={13} aria-hidden /> {coordText(c.lat, c.lng)}
              {c.kind === 'place' && c.radiusM != null && (
                <span className="ev-dim">
                  {' '}
                  · within about {Math.max(10, Math.round(c.radiusM / 10) * 10)} m
                </span>
              )}
            </div>
          )}
          <DriveBadges ids={c.volumes} volumes={volumes} />
        </div>
      </section>

      <div className="ev-actions">
        {suggested && (
          <>
            <button
              type="button"
              className="df-button df-button-primary"
              onClick={() =>
                void window.api
                  .collectionUpdate({ id: c.id, status: 'accepted' })
                  .then(() => after('Kept.'))
              }
            >
              <Check size={14} /> Keep
            </button>
            <button
              type="button"
              className="df-button"
              onClick={() =>
                void window.api
                  .collectionUpdate({ id: c.id, status: 'dismissed' })
                  .then(async () => {
                    await onChanged()
                    onBack()
                  })
              }
            >
              <X size={14} /> Dismiss
            </button>
          </>
        )}
        <button type="button" className="df-button" onClick={() => setDialog('rename')}>
          <Pencil size={14} /> {c.name ? 'Edit details' : 'Name it'}
        </button>
        {mergeTargets.length > 0 && (
          <button type="button" className="df-button" onClick={() => setDialog('merge')}>
            <Merge size={14} /> Merge with…
          </button>
        )}
        {c.kind === 'place' && c.lat != null && c.lng != null && (
          <button
            type="button"
            className="df-button"
            title="Trips are then also measured from here"
            onClick={() =>
              void window.api
                .setDiscoveryPrefs({ home: { lat: c.lat!, lng: c.lng! } })
                .then(() => setNote('Set as your home. Trips will be looked for again with it.'))
            }
          >
            <Home size={14} /> This is my home
          </button>
        )}
        {!suggested && (
          <button
            type="button"
            className="df-button"
            onClick={() => {
              if (confirm(`Delete “${name}”? The photos and videos themselves are not touched.`))
                void window.api.collectionDelete(c.id).then(async () => {
                  await onChanged()
                  onBack()
                })
            }}
          >
            <Trash2 size={14} /> Delete
          </button>
        )}
      </div>
      {note && (
        <p className="ev-hint" role="status">
          {note}
        </p>
      )}

      {picked.size > 0 && (
        <div className="ev-selbar glass-panel" role="toolbar" aria-label="Selected">
          <span>{picked.size} selected</span>
          <button
            type="button"
            className="df-button"
            onClick={() =>
              void window.api
                .collectionRemove(c.id, pickedRefs())
                .then((n) => after(`Removed ${itemsWord(n)}.`))
            }
          >
            <X size={14} /> Remove from {word}
          </button>
          <button type="button" className="df-button" onClick={() => setDialog('split')}>
            <Scissors size={14} /> Move to a new {word}
          </button>
          <button type="button" className="df-button" onClick={() => setPicked(new Set())}>
            Clear
          </button>
        </div>
      )}

      <section className="ev-files" aria-label="Photos and videos">
        {raw === null ? (
          <div className="ev-loading" aria-busy="true">
            <div className="ev-skel" />
          </div>
        ) : files.length === 0 ? (
          <p className="ev-hint">
            Nothing here yet. In the gallery, right-click a photo or video and choose “Add to
            collection…”.
          </p>
        ) : (
          <>
            <div className="ev-tiles">
              {files.slice(0, shown).map((f) => {
                const k = keyOf(f)
                const isCover = f.path === c.coverPath && f.volume_id === c.coverVolumeId
                return (
                  <div
                    key={k}
                    className={`ev-tile${picked.has(k) ? ' is-picked' : ''}`}
                    data-file={f.name}
                  >
                    {renderTile(f, viewable, 168)}
                    <div className="ev-tile-actions">
                      <TileAction
                        label={`Select ${f.name}`}
                        on={picked.has(k)}
                        onClick={() => togglePick(k)}
                      >
                        <Check size={14} />
                      </TileAction>
                      <TileAction
                        label={`Use ${f.name} as cover`}
                        on={isCover}
                        onClick={() => {
                          const r = refOf(f)
                          if (r)
                            void window.api
                              .collectionUpdate({ id: c.id, cover: r })
                              .then(() => after('Cover changed.'))
                        }}
                      >
                        <Star size={14} />
                      </TileAction>
                      <TileAction
                        label={`Remove ${f.name}`}
                        onClick={() => {
                          const r = refOf(f)
                          if (r)
                            void window.api
                              .collectionRemove(c.id, [r])
                              .then(() => after(`Removed ${f.name}.`))
                        }}
                      >
                        <X size={14} />
                      </TileAction>
                    </div>
                  </div>
                )
              })}
            </div>
            {files.length > shown && (
              <button
                type="button"
                className="df-button ev-more"
                onClick={() => setShown((n) => n + PAGE)}
              >
                Show more ({(files.length - shown).toLocaleString()} left)
              </button>
            )}
          </>
        )}
      </section>

      {dialog === 'rename' && (
        <DetailsDialog
          card={c}
          word={word}
          onCancel={() => setDialog(null)}
          onSave={async (patch) => {
            await window.api.collectionUpdate({ id: c.id, ...patch })
            setDialog(null)
            await onChanged()
          }}
        />
      )}
      {dialog === 'split' && (
        <NameDialog
          title={`New ${word} from ${itemsWord(picked.size)}`}
          onCancel={() => setDialog(null)}
          onSave={async (n) => {
            const id = await window.api.collectionSplit(c.id, pickedRefs(), n)
            setDialog(null)
            await after('Moved.')
            if (id) onOpen(id)
          }}
        />
      )}
      {dialog === 'merge' && (
        <PickDialog
          title={`Merge “${name}” with…`}
          hint={`Everything here moves into the one you pick, and this ${word} goes away.`}
          options={mergeTargets}
          onCancel={() => setDialog(null)}
          onPick={async (target) => {
            await window.api.collectionMerge(target.id, c.id)
            setDialog(null)
            await onChanged()
            onOpen(target.id)
          }}
        />
      )}
    </div>
  )
}

function TileAction({
  label,
  on,
  onClick,
  children
}: {
  label: string
  on?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`ev-tile-btn${on ? ' is-on' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={on}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {children}
    </button>
  )
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

function Modal({
  title,
  hint,
  onClose,
  children
}: {
  title: string
  hint?: string
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [onClose])
  return (
    <div className="ev-modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="ev-modal ev-modal-small glass-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="ev-modal-head">
          <div>
            <h2>{title}</h2>
            {hint && <p>{hint}</p>}
          </div>
          <button type="button" className="ev-icon-btn" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

/**
 * Name, place and dates. A suggestion's dates come from its files, so only a
 * collection the user made (or kept) offers a date range of its own.
 */
function DetailsDialog({
  card: c,
  word,
  onCancel,
  onSave
}: {
  card: CollectionCard
  word: string
  onCancel: () => void
  onSave: (patch: {
    name: string
    note: string | null
    startMs?: number | null
    endMs?: number | null
  }) => Promise<void>
}): React.JSX.Element {
  const [name, setName] = useState(c.name ?? '')
  const [place, setPlace] = useState(c.note ?? '')
  const datesEditable = c.origin !== 'auto'
  const [from, setFrom] = useState(toDateInput(datesEditable ? c.startMs : null))
  const [to, setTo] = useState(toDateInput(datesEditable ? c.endMs : null))
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      title={c.name ? 'Edit details' : `Name this ${word}`}
      hint={
        c.kind === 'place'
          ? 'DiskFrame does not look places up online, so the name is yours to give.'
          : undefined
      }
      onClose={onCancel}
    >
      <form
        className="ev-modal-body ev-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (busy) return
          setBusy(true)
          const dates = datesEditable
            ? { startMs: fromDateInput(from), endMs: fromDateInput(to) ?? fromDateInput(from) }
            : {}
          void onSave({ name: name.trim(), note: place.trim() || null, ...dates }).finally(() =>
            setBusy(false)
          )
        }}
      >
        <input
          className="ev-input"
          autoFocus
          maxLength={120}
          value={name}
          placeholder="Name"
          onChange={(e) => setName(e.target.value)}
          aria-label="Name"
        />
        <input
          className="ev-input"
          maxLength={200}
          value={place}
          placeholder="Place (optional)"
          onChange={(e) => setPlace(e.target.value)}
          aria-label="Place"
        />
        {datesEditable && (
          <div className="ev-dates">
            <label>
              <span className="ev-dim">From</span>
              <input
                className="ev-input"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label>
              <span className="ev-dim">To</span>
              <input
                className="ev-input"
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
          </div>
        )}
        <div className="ev-modal-foot">
          <button type="button" className="df-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="df-button df-button-primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  )
}

function NameDialog({
  title,
  hint,
  initial = '',
  onCancel,
  onSave
}: {
  title: string
  hint?: string
  initial?: string
  onCancel: () => void
  onSave: (name: string) => Promise<void>
}): React.JSX.Element {
  const [v, setV] = useState(initial)
  const [busy, setBusy] = useState(false)
  return (
    <Modal title={title} hint={hint} onClose={onCancel}>
      <form
        className="ev-modal-body ev-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (busy) return
          setBusy(true)
          void onSave(v.trim()).finally(() => setBusy(false))
        }}
      >
        <input
          className="ev-input"
          autoFocus
          maxLength={120}
          value={v}
          placeholder="Name"
          onChange={(e) => setV(e.target.value)}
          aria-label="Name"
        />
        <div className="ev-modal-foot">
          <button type="button" className="df-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="df-button df-button-primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  )
}

function PickDialog({
  title,
  hint,
  options,
  onCancel,
  onPick,
  footer
}: {
  title: string
  hint?: string
  options: CollectionCard[] | null
  onCancel: () => void
  onPick: (c: CollectionCard) => Promise<void>
  footer?: React.ReactNode
}): React.JSX.Element {
  return (
    <Modal title={title} hint={hint} onClose={onCancel}>
      <ul className="ev-modal-body ev-picklist">
        {(options ?? []).map((o) => (
          <li key={o.id}>
            <button type="button" onClick={() => void onPick(o)}>
              <KindIcon kind={o.kind} size={14} />
              <span className="ev-picklist-name">{displayName(o)}</span>
              <span className="ev-dim">
                {[o.status === 'suggested' ? 'suggested' : null, dates(o), itemsWord(o.count)]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </button>
          </li>
        ))}
        {options !== null && options.length === 0 && (
          <li className="ev-hint">Nothing to pick yet - make a new one below.</li>
        )}
      </ul>
      {footer}
    </Modal>
  )
}

function SettingsDialog({
  prefs,
  multiDrive,
  onClose,
  onSaved
}: {
  prefs: DiscoveryPrefs
  multiDrive: boolean
  onClose: () => void
  onSaved: () => Promise<void>
}): React.JSX.Element {
  const [cross, setCross] = useState(prefs.crossDrive)
  const [home, setHome] = useState(prefs.home)
  return (
    <Modal
      title="Finding places and trips"
      hint="Everything happens on this computer. No location, file name or picture is sent anywhere."
      onClose={onClose}
    >
      <div className="ev-modal-body ev-form">
        <label className="ev-check">
          <input type="checkbox" checked={cross} onChange={(e) => setCross(e.target.checked)} />
          <span>
            <strong>Combine drives</strong>
            <span className="ev-dim">
              Off (the default): each drive’s photos are looked at on their own. On: the photos on
              all the drives you are browsing together are looked at as one - for example phone
              photos on one drive and camera photos on another from the same trip. Every photo stays
              on its own drive either way.
              {!multiDrive && ' This only matters when browsing more than one drive (All Drives).'}
            </span>
          </span>
        </label>
        <div className="ev-check">
          <Home size={16} aria-hidden />
          <span>
            <strong>Home</strong>
            <span className="ev-dim">
              {home
                ? `Set at ${coordText(home.lat, home.lng)}. Trips are time spent far from here and from where you usually were at the time.`
                : 'Not set, and never guessed - your most-photographed place may be a college or a workplace. Trips are found from where you usually were at the time. To set it, open a place and choose “This is my home”.'}
            </span>
          </span>
          {home && (
            <button type="button" className="df-button" onClick={() => setHome(null)}>
              Clear
            </button>
          )}
        </div>
        <div className="ev-modal-foot">
          <button type="button" className="df-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="df-button df-button-primary"
            onClick={() =>
              void window.api.setDiscoveryPrefs({ crossDrive: cross, home }).then(onSaved)
            }
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * "Add to collection…" from the gallery: pick a Place, Trip or collection, or
 * make a new one. Files without GPS are as welcome as any.
 */
export function AddToCollectionDialog({
  drive,
  files,
  onClose,
  onDone
}: {
  drive: string
  files: ScannedFile[]
  onClose: () => void
  onDone: (msg: string) => void
}): React.JSX.Element {
  const [cards, setCards] = useState<CollectionCard[] | null>(null)
  const [creating, setCreating] = useState<CollectionKind | null>(null)
  useEffect(() => {
    let live = true
    void window.api.eventsList(drive).then((l) => live && setCards(l.cards))
    return () => {
      live = false
    }
  }, [drive])
  const refs = files.map(refOf).filter((r): r is FileRef => !!r)
  const what = files.length === 1 ? files[0].name : itemsWord(files.length)
  if (creating)
    return (
      <NameDialog
        title={`New ${KIND_WORD[creating].toLowerCase()} with ${what}`}
        onCancel={() => setCreating(null)}
        onSave={async (name) => {
          await window.api.collectionCreate({ kind: creating, name, refs })
          onDone(`Added ${what} to ${name || 'a new ' + KIND_WORD[creating].toLowerCase()}.`)
        }}
      />
    )
  return (
    <PickDialog
      title={`Add ${what} to…`}
      hint={
        refs.length < files.length
          ? 'Files indexed before drives were identified cannot be added.'
          : undefined
      }
      options={cards}
      onCancel={onClose}
      onPick={async (c) => {
        await window.api.collectionAdd(c.id, refs)
        onDone(`Added ${what} to ${displayName(c)}.`)
      }}
      footer={
        <div className="ev-modal-foot">
          {(['place', 'trip', 'custom'] as CollectionKind[]).map((k) => (
            <button key={k} type="button" className="df-button" onClick={() => setCreating(k)}>
              <Plus size={14} /> New {KIND_WORD[k].toLowerCase()}
            </button>
          ))}
        </div>
      }
    />
  )
}
