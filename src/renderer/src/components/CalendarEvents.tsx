import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, ImagePlus, MapPin, Repeat, X } from 'lucide-react'
import type { DayFile, EventCard, EventDetail, LinkOp, OtherEvent } from '../../../main/calendarTypes'
import { mediaUrl } from '../../../main/mediaUrl'
import { bumpCalendar, useCover, useEventDetail } from '../hooks/useCalendarEvents'
import './Events.css'

/**
 * Google Calendar events inside the Events section (Events.tsx): the cover
 * card, the events-without-photos list and the event page, as released in
 * 1.4.0. Which files belong to an event is decided in the main process by the
 * Stage 7 matcher plus the user's own decisions; this file only shows them.
 */

export type RenderTile = (file: DayFile, list: DayFile[], size: number) => React.ReactNode
export type EventRef = { calendarId: string; eventId: string }

// ── Formatting ───────────────────────────────────────────────────────────────

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
const shortDay = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

function whenText(e: { allDay: boolean; startMs: number; endMs: number }, withTime: boolean): string {
  // All-day ends are midnight AFTER the last day.
  const last = e.allDay ? e.endMs - 1 : e.endMs
  const sameDay = new Date(e.startMs).toDateString() === new Date(last).toDateString()
  if (!sameDay) return `${shortDay.format(e.startMs)} – ${dayFmt.format(last)}`
  const day = dayFmt.format(e.startMs)
  if (e.allDay || !withTime) return day
  return `${day} · ${timeFmt.format(e.startMs)} – ${timeFmt.format(e.endMs)}`
}
const photosWord = (n: number): string => (n === 1 ? '1 photo' : `${n} photos`)
function coordText(g: { lat: number; lng: number }): string {
  const f = (v: number, pos: string, neg: string): string => `${Math.abs(v).toFixed(3)}° ${v >= 0 ? pos : neg}`
  return `${f(g.lat, 'N', 'S')}, ${f(g.lng, 'E', 'W')}`
}

/**
 * Gallery tiles get their thumbnails from the grid's viewport pump; Events has
 * no grid, so it asks for the ones it shows (same prioritised queue) and
 * fills them in as they arrive. Returns the files with thumbnails patched in -
 * one array, used for both the tiles and the viewer's list, so opening a
 * photo still finds it by identity.
 */
function useLiveThumbs(files: DayFile[] | null): DayFile[] {
  const [made, setMade] = useState<Record<string, string>>({})
  const missing = useMemo(() => (files ?? []).filter((f) => !f.thumb).map((f) => f.path), [files])
  const missingKey = missing.join('\u0000')
  useEffect(() => {
    if (!missing.length) return
    const want = new Set(missing)
    const off = window.api.onThumbReady((d) => {
      if (want.has(d.filePath)) setMade((m) => ({ ...m, [d.filePath]: d.thumbPath }))
    })
    void window.api.prioritizeThumbnails({ visible: missing.slice(0, 120), prefetch: missing.slice(120) })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps -- missingKey names the set
  }, [missingKey])
  return useMemo(() => (files ?? []).map((f) => (!f.thumb && made[f.path] ? { ...f, thumb: made[f.path] } : f)), [files, made])
}

export function StatusPill({ state, lastSyncAt }: { state: string | undefined; lastSyncAt: string | null }): React.JSX.Element | null {
  if (!state || state === 'unconfigured' || state === 'disconnected') return null
  const text =
    state === 'syncing'
      ? 'Syncing…'
      : state === 'offline'
        ? 'Offline · showing saved events'
        : state === 'expired'
          ? 'Sign in again in Settings'
          : state === 'error'
            ? 'Last sync failed · showing saved events'
            : lastSyncAt
              ? `Synced ${new Date(lastSyncAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
              : 'Connected'
  return (
    <div className={`ev-pill${state === 'expired' || state === 'error' || state === 'offline' ? ' is-warn' : ''}`} role="status">
      {text}
    </div>
  )
}

export function CoverCard({ card: c, featured, onOpen }: { card: EventCard; featured: boolean; onOpen: () => void }): React.JSX.Element {
  const src = useCover(c.cover)
  const [loaded, setLoaded] = useState(false)
  return (
    <button
      type="button"
      className={`ev-card${featured ? ' is-featured' : ''}`}
      onClick={onOpen}
      aria-label={`${c.summary}, ${whenText(c, false)}${c.location ? `, ${c.location}` : ''}, ${photosWord(c.confirmed + c.suggested)}`}
      data-event={c.eventId}
    >
      {src && <img className={`ev-card-img${loaded ? ' is-loaded' : ''}`} src={mediaUrl(src)} alt="" loading="lazy" decoding="async" onLoad={() => setLoaded(true)} />}
      <span className="ev-card-shade" aria-hidden />
      <span className="ev-card-count">{photosWord(c.confirmed + c.suggested)}</span>
      <span className="ev-card-text">
        <span className="ev-card-title">
          {c.summary}
          {c.recurring && <Repeat size={14} className="ev-card-repeat" aria-hidden />}
        </span>
        <span className="ev-card-when">{whenText(c, false)}</span>
        {c.location && (
          <span className="ev-card-where">
            <MapPin size={12} aria-hidden /> {c.location}
          </span>
        )}
        {c.suggested > 0 && <span className="ev-card-new">{c.suggested} suggested</span>}
      </span>
    </button>
  )
}

export function OtherEvents({ events, onOpen }: { events: OtherEvent[]; onOpen: (ev: EventRef) => void }): React.JSX.Element {
  return (
    <details className="ev-others">
      <summary>
        Other calendar events <span>{events.length} without photos</span>
      </summary>
      <ul className="ev-others-list glass-panel">
        {events.map((e) => (
          <li key={e.eventId}>
            <button type="button" onClick={() => onOpen(e)}>
              <span className="ev-others-when">{whenText(e, false)}</span>
              <span className="ev-others-title">{e.summary}</span>
              {e.location && <span className="ev-others-where">{e.location}</span>}
            </button>
          </li>
        ))}
      </ul>
    </details>
  )
}

// ── Event page ───────────────────────────────────────────────────────────────

interface UndoAction {
  label: string
  revert: () => Promise<unknown>
}

export function EventPage({ drive, ev, onBack, renderTile }: { drive: string | null; ev: EventRef; onBack: () => void; renderTile: RenderTile }): React.JSX.Element {
  const detail = useEventDetail(drive, ev)
  const [undo, setUndo] = useState<UndoAction | null>(null)
  const [picking, setPicking] = useState(false)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (undoTimer.current && clearTimeout(undoTimer.current)), [])

  // Esc goes back - unless the viewer or the picker has it.
  useEffect(() => {
    const onKey = (k: KeyboardEvent): void => {
      if (k.key !== 'Escape' || picking || document.body.classList.contains('viewer-open')) return
      onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack, picking])

  const act = useCallback(
    async (files: { path: string; name: string }[], op: LinkOp, revertOp: LinkOp, label: string): Promise<void> => {
      let done = 0
      for (const f of files) if (await window.api.calendarLink({ op, path: f.path, calendarId: ev.calendarId, eventId: ev.eventId })) done++
      if (!done) return
      bumpCalendar()
      if (undoTimer.current) clearTimeout(undoTimer.current)
      setUndo({
        label,
        revert: async () => {
          for (const f of files) await window.api.calendarLink({ op: revertOp, path: f.path, calendarId: ev.calendarId, eventId: ev.eventId })
          bumpCalendar()
        }
      })
      undoTimer.current = setTimeout(() => setUndo(null), 8000)
    },
    [ev]
  )

  const all = useLiveThumbs(detail?.files ?? null)
  const inEvent = all.filter((f) => f.status !== 'suggested')
  const suggested = all.filter((f) => f.status === 'suggested')

  return (
    <div className="ev-page ev-detail" data-event-page={ev.eventId}>
      <button type="button" className="ev-back" onClick={onBack}>
        <ArrowLeft size={14} aria-hidden /> Events
      </button>
      {detail === null ? (
        <div className="ev-skel ev-skel-hero" aria-busy="true" />
      ) : (
        <>
          <Hero detail={detail} />
          <div className="ev-actions">
            <button type="button" className="df-button" onClick={() => setPicking(true)}>
              <ImagePlus size={13} aria-hidden /> Add photos
            </button>
            {suggested.length > 1 && (
              <button type="button" className="df-button" onClick={() => void act(suggested, 'confirm', 'undo', `Kept ${photosWord(suggested.length)}`)}>
                <Check size={13} aria-hidden /> Keep all suggestions
              </button>
            )}
          </div>

          <FileSection
            title="In this event"
            empty={suggested.length ? 'Nothing confirmed yet. Keep the suggestions that belong here.' : 'No photos yet. Use Add photos to choose some from this day.'}
            files={inEvent}
            list={all}
            renderTile={renderTile}
            actions={(f) => (
              <TileAction
                label="Remove from this event"
                onClick={() =>
                  void (f.status === 'manual' ? act([f], 'undo', 'manual', `Removed ${f.name}`) : act([f], 'reject', 'confirm', `Removed ${f.name}`))
                }
              >
                <X size={14} />
              </TileAction>
            )}
          />
          {suggested.length > 0 && (
            <FileSection
              title="Suggested"
              hint="Taken during or close to this event, by the time recorded in the photo. Not part of the event until you keep them."
              files={suggested}
              list={all}
              renderTile={renderTile}
              suggested
              actions={(f) => (
                <>
                  <TileAction label="Keep in this event" onClick={() => void act([f], 'confirm', 'undo', `Kept ${f.name}`)}>
                    <Check size={14} />
                  </TileAction>
                  <TileAction label="Not from this event" onClick={() => void act([f], 'reject', 'undo', `Removed ${f.name}`)}>
                    <X size={14} />
                  </TileAction>
                </>
              )}
            />
          )}
        </>
      )}

      {picking && drive && (
        <Picker
          drive={drive}
          ev={ev}
          title={detail?.summary ?? ''}
          renderTile={renderTile}
          onClose={() => setPicking(false)}
          onAdd={(files) => {
            setPicking(false)
            void act(files, 'manual', 'undo', `Added ${photosWord(files.length)}`)
          }}
        />
      )}

      {undo && (
        <div className="ev-undo glass-panel" role="status" aria-live="polite">
          <span>{undo.label}</span>
          <button
            type="button"
            className="df-button"
            onClick={() => {
              void undo.revert()
              setUndo(null)
            }}
          >
            Undo
          </button>
        </div>
      )}
    </div>
  )
}

function Hero({ detail: d }: { detail: EventDetail }): React.JSX.Element {
  const src = useCover(d.cover)
  return (
    <section className={`ev-hero${src ? '' : ' is-plain'}`} aria-label={d.summary}>
      {src && <img className="ev-hero-img" src={mediaUrl(src)} alt="" decoding="async" />}
      <span className="ev-card-shade" aria-hidden />
      <div className="ev-hero-text">
        <h1 className="ev-hero-title">
          {d.summary}
          {d.recurring && <Repeat size={16} className="ev-card-repeat" aria-label="Repeats" />}
        </h1>
        <div className="ev-hero-when">{whenText(d, true)}</div>
        {d.location ? (
          <div className="ev-hero-where">
            <MapPin size={13} aria-hidden /> {d.location}
          </div>
        ) : (
          d.gps && (
            <div className="ev-hero-where" title="The average position recorded in this event's photos">
              <MapPin size={13} aria-hidden /> {coordText(d.gps)} <span className="ev-dim">· from photo GPS</span>
            </div>
          )
        )}
      </div>
    </section>
  )
}

function FileSection({
  title,
  hint,
  empty,
  files,
  list,
  renderTile,
  actions,
  suggested
}: {
  title: string
  hint?: string
  empty?: string
  files: DayFile[]
  list: DayFile[]
  renderTile: RenderTile
  actions: (f: DayFile) => React.ReactNode
  suggested?: boolean
}): React.JSX.Element {
  return (
    <section className="ev-files" aria-label={title}>
      <div className="ev-files-head">
        <h2>{title}</h2>
        <span className="ev-dim">{files.length}</span>
      </div>
      {hint && <p className="ev-hint">{hint}</p>}
      {files.length === 0 ? (
        <p className="ev-hint">{empty}</p>
      ) : (
        <div className="ev-tiles">
          {files.map((f) => (
            <div key={f.path} className={`ev-tile${suggested ? ' is-suggested' : ''}`} data-file={f.name}>
              {renderTile(f, list, 168)}
              <div className="ev-tile-actions">{actions(f)}</div>
              {f.status === 'manual' && <span className="ev-tile-badge">Added</span>}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function TileAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      type="button"
      className="ev-tile-btn"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {children}
    </button>
  )
}

// ── Add photos ───────────────────────────────────────────────────────────────

function Picker({
  drive,
  ev,
  title,
  renderTile,
  onClose,
  onAdd
}: {
  drive: string
  ev: EventRef
  title: string
  renderTile: RenderTile
  onClose: () => void
  onAdd: (files: DayFile[]) => void
}): React.JSX.Element {
  const [raw, setFiles] = useState<DayFile[] | null>(null)
  const live = useLiveThumbs(raw)
  const files = raw === null ? null : live
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let alive = true
    window.api
      .calendarEventCandidates(drive, ev.calendarId, ev.eventId)
      .then((f) => alive && setFiles(f))
      .catch(() => alive && setFiles([]))
    dialog.current?.focus()
    return () => {
      alive = false
    }
  }, [drive, ev])
  const toggle = (p: string): void =>
    setChosen((s) => {
      const n = new Set(s)
      if (n.has(p)) n.delete(p)
      else n.add(p)
      return n
    })
  return (
    <div className="ev-modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialog}
        className="ev-modal glass-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Add photos to ${title}`}
        tabIndex={-1}
        onKeyDown={(k) => {
          if (k.key === 'Escape') {
            k.stopPropagation()
            onClose()
          }
        }}
      >
        <header className="ev-modal-head">
          <div>
            <h2>Add photos</h2>
            <p className="ev-dim">From the day of {title || 'this event'}</p>
          </div>
          <button type="button" className="ev-icon-btn" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="ev-modal-body">
          {files === null ? (
            <p className="ev-hint">Loading…</p>
          ) : files.length === 0 ? (
            <p className="ev-hint">No other photos or videos from this day on this drive.</p>
          ) : (
            <div className="ev-tiles ev-tiles-pick">
              {files.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  className={`ev-pick${chosen.has(f.path) ? ' is-on' : ''}`}
                  aria-pressed={chosen.has(f.path)}
                  aria-label={`${f.name}, ${timeFmt.format(Date.parse(f.date))}`}
                  onClick={() => toggle(f.path)}
                >
                  <span className="ev-pick-img">
                    {f.thumb ? <img src={mediaUrl(f.thumb)} alt="" loading="lazy" decoding="async" /> : renderTile(f, files, 120)}
                  </span>
                  <span className="ev-pick-time">{timeFmt.format(Date.parse(f.date))}</span>
                  {chosen.has(f.path) && (
                    <span className="ev-pick-check" aria-hidden>
                      <Check size={12} strokeWidth={3} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <footer className="ev-modal-foot">
          <button type="button" className="df-button df-button-quiet" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="df-button df-button-primary"
            disabled={chosen.size === 0}
            onClick={() => onAdd((files ?? []).filter((f) => chosen.has(f.path)))}
          >
            {chosen.size ? `Add ${photosWord(chosen.size)}` : 'Add'}
          </button>
        </footer>
      </div>
    </div>
  )
}
