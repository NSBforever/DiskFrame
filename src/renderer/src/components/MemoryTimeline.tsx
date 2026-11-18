import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, MapPin, Plus, Repeat, X } from 'lucide-react'
import type { DayEvent, DayFile, LinkOp } from '../../../main/calendarTypes'
import { bumpCalendar, useDayEvents } from '../hooks/useCalendarDays'
import './MemoryTimeline.css'

/**
 * Google Calendar inside the gallery: quiet chips on a day's header, and a
 * side panel with that day's events and the photos and videos taken during
 * them. Nothing here is a separate calendar app - no month grids, no agenda.
 */

// ── Formatting ───────────────────────────────────────────────────────────────

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const fmtTime = (ms: number): string => timeFmt.format(ms)
function eventTime(e: DayEvent): string {
  return e.allDay ? 'All day' : `${fmtTime(e.startMs)} – ${fmtTime(e.endMs)}`
}
function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}
const filesWord = (n: number): string => (n === 1 ? '1 related file' : `${n} related files`)

// ── Header strip ─────────────────────────────────────────────────────────────

/**
 * Up to two events with files as chips, the rest as one muted "+N events".
 * Nothing at all for a day without events - the header stays as it was.
 */
export function DayEventStrip({ drive, day, hasEvents, onOpen }: { drive: string | null; day: string; hasEvents: boolean; onOpen: (day: string) => void }): React.JSX.Element | null {
  const events = useDayEvents(drive, day, hasEvents)
  if (!hasEvents || !events || events.length === 0) return null
  const withFiles = events.filter((e) => e.files.length > 0)
  const chips = withFiles.slice(0, 2)
  const rest = events.length - chips.length
  return (
    <div className="mt-strip" data-day={day}>
      {chips.map((e) => (
        <button
          key={e.eventId}
          type="button"
          className="mt-chip"
          title={`${e.summary} · ${eventTime(e)} · ${filesWord(e.files.length)}`}
          onClick={() => onOpen(day)}
        >
          <CalendarDays size={11} aria-hidden />
          {!e.allDay && <span className="mt-chip-time">{fmtTime(e.startMs)}</span>}
          <span className="mt-chip-title">{e.summary}</span>
          <span className="mt-chip-count">{e.files.length}</span>
        </button>
      ))}
      {rest > 0 && (
        <button type="button" className="mt-chip mt-chip-quiet" onClick={() => onOpen(day)} title="Show this day's events">
          {chips.length === 0 && <CalendarDays size={11} aria-hidden />}
          {chips.length > 0 ? `+${rest}` : rest} {rest === 1 ? 'event' : 'events'}
        </button>
      )}
    </div>
  )
}

// ── Day panel ────────────────────────────────────────────────────────────────

export interface DayPanelProps {
  drive: string | null
  day: string
  /** Set when opened from "Add to Event…": the file the user wants to place. */
  pickFor?: { path: string; name: string } | null
  onClose: () => void
  onOpenFile: (file: DayFile, list: DayFile[]) => void
  renderThumb: (file: DayFile, list: DayFile[], size: number) => React.ReactNode
}

interface UndoAction {
  label: string
  revert: () => Promise<unknown>
}

export function DayPanel({ drive, day, pickFor, onClose, onOpenFile, renderThumb }: DayPanelProps): React.JSX.Element {
  const events = useDayEvents(drive, day, true)
  // undefined = the user has not chosen yet: a day with exactly one event
  // with files opens with that event expanded. Derived, not set in an effect.
  const [chosen, setOpen] = useState<string | null | undefined>(undefined)
  const autoOpen = useMemo(() => {
    if (!events || pickFor) return null
    const withFiles = events.filter((e) => e.files.length > 0)
    return withFiles.length === 1 ? withFiles[0].eventId : null
  }, [events, pickFor])
  const open = chosen === undefined ? autoOpen : chosen
  const [undo, setUndo] = useState<UndoAction | null>(null)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => panelRef.current?.focus(), [])
  useEffect(() => () => void (undoTimer.current && clearTimeout(undoTimer.current)), [])
  // The button that was clicked often disappears (Keep, Undo); without this
  // focus fell to the page and the arrow keys stopped moving between events.
  const keepFocus = useCallback((): void => {
    requestAnimationFrame(() => {
      const p = panelRef.current
      if (p && !p.contains(document.activeElement)) p.focus()
    })
  }, [])

  const act = useCallback(
    async (e: DayEvent, f: { path: string; name: string }, op: LinkOp, revertOp: LinkOp, label: string): Promise<void> => {
      const ok = await window.api.calendarLink({ op, path: f.path, calendarId: e.calendarId, eventId: e.eventId })
      if (!ok) return
      bumpCalendar()
      keepFocus()
      if (undoTimer.current) clearTimeout(undoTimer.current)
      setUndo({
        label,
        revert: () => window.api.calendarLink({ op: revertOp, path: f.path, calendarId: e.calendarId, eventId: e.eventId }).then(bumpCalendar)
      })
      undoTimer.current = setTimeout(() => setUndo(null), 7000)
    },
    [keepFocus]
  )

  const order = useMemo(() => (events ?? []).map((e) => e.eventId), [events])
  const step = (dir: 1 | -1): void => {
    if (!order.length) return
    const i = open ? order.indexOf(open) : -1
    setOpen(order[(i + dir + order.length) % order.length])
  }

  const onKeyDown = (k: React.KeyboardEvent): void => {
    // A file opened from here shows in the viewer while focus is still on its
    // thumbnail in this panel: the viewer's keys (Esc, arrows) are the
    // viewer's. Esc used to close this panel and leave the viewer open.
    if (document.body.classList.contains('viewer-open')) return
    if (k.key === 'Escape') {
      k.stopPropagation()
      onClose()
    } else if (k.key === 'ArrowDown' || k.key === 'ArrowUp') {
      k.preventDefault()
      step(k.key === 'ArrowDown' ? 1 : -1)
    }
  }

  return (
    <aside
      ref={panelRef}
      className="glass-panel mt-panel"
      aria-label={`Events on ${dayLabel(day)}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-day-panel={day}
    >
      <header className="mt-panel-head">
        <div>
          <div className="mt-panel-title">{dayLabel(day)}</div>
          <div className="mt-panel-sub">
            {events === null ? 'Loading…' : events.length === 0 ? 'No events' : `${events.length} ${events.length === 1 ? 'event' : 'events'} from Google Calendar`}
          </div>
        </div>
        <button type="button" className="mt-icon-btn" aria-label="Close events" title="Close (Esc)" onClick={onClose}>
          <X size={16} />
        </button>
      </header>

      {pickFor && (
        <div className="mt-pick" role="status">
          Choose the event <strong>{pickFor.name}</strong> belongs to.
        </div>
      )}

      <div className="mt-panel-body">
        {events?.length === 0 && <div className="mt-empty">No calendar events on this day.</div>}
        {events?.map((e) => (
          <EventCard
            key={e.eventId}
            event={e}
            expanded={open === e.eventId}
            onToggle={() => setOpen(open === e.eventId ? null : e.eventId)}
            onStep={step}
            canStep={order.length > 1}
            pickFor={pickFor}
            onAct={act}
            onOpenFile={onOpenFile}
            renderThumb={renderThumb}
          />
        ))}
      </div>

      {undo && (
        <div className="mt-undo" role="status" aria-live="polite">
          <span>{undo.label}</span>
          <button
            type="button"
            className="df-button"
            onClick={() => {
              void undo.revert()
              setUndo(null)
              keepFocus()
            }}
          >
            Undo
          </button>
        </div>
      )}
    </aside>
  )
}

function EventCard({
  event: e,
  expanded,
  onToggle,
  onStep,
  canStep,
  pickFor,
  onAct,
  onOpenFile,
  renderThumb
}: {
  event: DayEvent
  expanded: boolean
  onToggle: () => void
  onStep: (dir: 1 | -1) => void
  canStep: boolean
  pickFor?: { path: string; name: string } | null
  onAct: (e: DayEvent, f: { path: string; name: string }, op: LinkOp, revertOp: LinkOp, label: string) => Promise<void>
  onOpenFile: (file: DayFile, list: DayFile[]) => void
  renderThumb: (file: DayFile, list: DayFile[], size: number) => React.ReactNode
}): React.JSX.Element {
  const files = e.files
  const already = pickFor ? files.find((f) => f.path === pickFor.path && f.status !== 'suggested') : undefined
  const bodyId = `mt-body-${e.eventId}`
  return (
    <section className={`mt-card${expanded ? ' is-open' : ''}${files.length === 0 ? ' is-empty' : ''}`} data-event={e.eventId}>
      <div className="mt-card-head">
        <div className="mt-card-when">{eventTime(e)}</div>
        <div className="mt-card-title">
          {e.summary}
          {e.recurring && <Repeat size={11} className="mt-card-repeat" aria-label="Repeats" />}
        </div>
        {e.location && (
          <div className="mt-card-where">
            <MapPin size={11} aria-hidden /> {e.location}
          </div>
        )}
      </div>

      {pickFor ? (
        <div className="mt-card-actions">
          {already ? (
            <span className="mt-muted">Already part of this event</span>
          ) : (
            <button type="button" className="df-button df-button-primary" onClick={() => void onAct(e, pickFor, 'manual', 'undo', `Added ${pickFor.name} to ${e.summary}`)}>
              <Plus size={12} aria-hidden /> Add here
            </button>
          )}
        </div>
      ) : files.length === 0 ? (
        <div className="mt-muted mt-card-none">No photos or videos from this event.</div>
      ) : (
        <>
          <button type="button" className="mt-card-toggle" aria-expanded={expanded} aria-controls={bodyId} onClick={onToggle}>
            <span>{filesWord(files.length)}</span>
            <ChevronDown size={14} className="mt-chevron" aria-hidden />
          </button>
          {!expanded && (
            <div className="mt-strip-thumbs">
              {files.slice(0, 5).map((f) => (
                <div key={f.path} className={`mt-thumb${f.status === 'suggested' ? ' is-suggested' : ''}`}>
                  {renderThumb(f, files, 56)}
                </div>
              ))}
              {files.length > 5 && (
                <button type="button" className="mt-more" onClick={onToggle} aria-label={`Show all ${files.length} files`}>
                  +{files.length - 5}
                </button>
              )}
            </div>
          )}
          {expanded && (
            <div id={bodyId} className="mt-timeline">
              {!e.allDay && <TimelineMark time={e.startMs} text={`${e.summary} started`} />}
              {files.map((f) => (
                <div key={f.path} className={`mt-row is-${f.status}`}>
                  <div className="mt-row-time">{fmtTime(Date.parse(f.date))}</div>
                  <button type="button" className="mt-row-thumb" onClick={() => onOpenFile(f, files)} aria-label={`Open ${f.name}`}>
                    {renderThumb(f, files, 44)}
                  </button>
                  <div className="mt-row-main">
                    <div className="mt-row-name" title={f.path}>
                      {f.name}
                    </div>
                    <div className="mt-row-status">{f.status === 'suggested' ? 'Suggested' : f.status === 'manual' ? 'Added by you' : 'Confirmed'}</div>
                  </div>
                  <div className="mt-row-actions">
                    {f.status === 'suggested' && (
                      <button type="button" className="mt-icon-btn" title="Keep in this event" aria-label={`Keep ${f.name} in ${e.summary}`} onClick={() => void onAct(e, f, 'confirm', 'undo', `Kept ${f.name}`)}>
                        <Check size={14} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="mt-icon-btn"
                      title={f.status === 'suggested' ? 'Not from this event' : 'Remove from this event'}
                      aria-label={`Remove ${f.name} from ${e.summary}`}
                      onClick={() =>
                        void (f.status === 'manual'
                          ? onAct(e, f, 'undo', 'manual', `Removed ${f.name}`)
                          : onAct(e, f, 'reject', f.status === 'confirmed' ? 'confirm' : 'undo', `Removed ${f.name}`))
                      }
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              ))}
              {!e.allDay && <TimelineMark time={e.endMs} text={`${e.summary} ended`} />}
              {canStep && (
                <div className="mt-card-step">
                  <button type="button" className="df-button df-button-quiet" onClick={() => onStep(-1)}>
                    <ChevronLeft size={12} aria-hidden /> Previous event
                  </button>
                  <button type="button" className="df-button df-button-quiet" onClick={() => onStep(1)}>
                    Next event <ChevronRight size={12} aria-hidden />
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}

function TimelineMark({ time, text }: { time: number; text: string }): React.JSX.Element {
  return (
    <div className="mt-row mt-mark">
      <div className="mt-row-time">{fmtTime(time)}</div>
      <div className="mt-mark-dot" aria-hidden />
      <div className="mt-row-main mt-muted">{text}</div>
    </div>
  )
}
