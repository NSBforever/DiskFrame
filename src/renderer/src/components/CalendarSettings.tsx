import React, { useEffect, useRef, useState } from 'react'
import type { CalendarStatus } from '../../../main/calendarTypes'

function ago(iso: string | null, now: number): string {
  if (!iso) return 'not yet'
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString()
}

function statusLine(s: CalendarStatus, now: number): string {
  switch (s.state) {
    case 'unconfigured':
      return s.message ?? 'Not available in this build.'
    case 'disconnected':
      return s.message ? `Not connected. ${s.message}` : 'Not connected.'
    case 'connecting':
      return s.message ?? 'Waiting for Google…'
    case 'syncing':
      return 'Syncing…'
    case 'connected':
      return `Connected${s.email ? ` as ${s.email}` : ''}. Last synced ${ago(s.lastSyncAt, now)} · ${s.eventCount.toLocaleString()} events saved.`
    default:
      return `${s.message ?? ''} Last synced ${ago(s.lastSyncAt, now)}.`.trim()
  }
}

/** The Google Calendar card in Settings. Everything it shows comes from the
 *  main process's status; it never sees a token. */
export function CalendarSettings(): React.JSX.Element {
  const [s, setS] = useState<CalendarStatus | null>(null)
  const [now, setNow] = useState(Date.now)
  const [confirming, setConfirming] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    window.api.calendarStatus().then(setS).catch(() => {})
    const off = window.api.onCalendarStatus(setS)
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => {
      off()
      clearInterval(t)
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    }
  }, [])

  const state = s?.state
  const hasAccount = state === 'connected' || state === 'syncing' || state === 'offline' || state === 'error' || state === 'expired'
  const busy = state === 'connecting' || state === 'syncing'
  const isProblem = state === 'expired' || state === 'error'

  const disconnect = (): void => {
    if (!confirming) {
      setConfirming(true)
      confirmTimer.current = setTimeout(() => setConfirming(false), 4000)
      return
    }
    setConfirming(false)
    void window.api.calendarDisconnect().then(setS)
  }

  return (
    <section className="glass-panel settings-card calendar-card" aria-labelledby="calendar-heading">
      <h3 id="calendar-heading" className="settings-heading">
        Google Calendar
      </h3>
      <div className="settings-field">
        <div className="settings-hint">
          Shows your calendar events beside the photos and videos taken during them. Read-only: DiskFrame never changes your
          calendar, and nothing about your files is ever sent to Google.
        </div>
        <div className="settings-field-head">
          <div className={`settings-status${isProblem ? ' update-notice-error' : ''}`} role="status" aria-live="polite" data-calendar-state={state ?? ''}>
            {s ? statusLine(s, now) : ' '}
          </div>
          <div className="settings-actions">
            {(state === 'disconnected' || state === 'unconfigured' || state === 'connecting') && (
              <button
                type="button"
                className="df-button df-button-primary"
                disabled={state !== 'disconnected'}
                onClick={() => void window.api.calendarConnect().then(setS)}
              >
                {state === 'connecting' ? 'Connecting…' : 'Connect Google Calendar'}
              </button>
            )}
            {state === 'expired' && (
              <button type="button" className="df-button df-button-primary" onClick={() => void window.api.calendarConnect().then(setS)}>
                Reconnect
              </button>
            )}
            {hasAccount && state !== 'expired' && (
              <button type="button" className="df-button" disabled={busy} onClick={() => void window.api.calendarSyncNow().then(setS)}>
                {state === 'syncing' ? 'Syncing…' : 'Sync Now'}
              </button>
            )}
            {hasAccount && (
              <button type="button" className={`df-button${confirming ? ' df-button-primary' : ' df-button-quiet'}`} disabled={busy} onClick={disconnect}>
                {confirming ? 'Confirm Disconnect' : 'Disconnect'}
              </button>
            )}
          </div>
        </div>
      </div>

      {hasAccount && s && (
        <>
          <div className="settings-field">
            <div className="settings-field-head">
              <label htmlFor="settings-calendar-autosync" className="settings-label">
                Sync automatically
              </label>
              <input
                id="settings-calendar-autosync"
                className="settings-switch"
                type="checkbox"
                checked={s.autoSync}
                onChange={(e) => void window.api.calendarSetPrefs({ autoSync: e.target.checked }).then(setS)}
              />
            </div>
            <div className="settings-hint">Every 30 minutes while DiskFrame is open. Saved events stay available offline.</div>
          </div>
          <div className="settings-field">
            <div className="settings-field-head">
              <label htmlFor="settings-calendar-buffer" className="settings-label">
                Time around an event
              </label>
              <span className="settings-value">{s.bufferMin} min</span>
            </div>
            <input
              id="settings-calendar-buffer"
              className="settings-slider"
              type="range"
              min="0"
              max="120"
              step="5"
              value={s.bufferMin}
              onChange={(e) => setS({ ...s, bufferMin: Number(e.target.value) })}
              onPointerUp={(e) => void window.api.calendarSetPrefs({ bufferMin: Number((e.target as HTMLInputElement).value) }).then(setS)}
              onKeyUp={(e) => void window.api.calendarSetPrefs({ bufferMin: Number((e.target as HTMLInputElement).value) }).then(setS)}
            />
            <div className="settings-hint">Photos and videos taken this long before or after an event can be suggested for it.</div>
          </div>
          <div className="settings-hint">
            Disconnect removes the sign-in and the saved events from this PC. Files you confirmed for an event stay linked, so
            reconnecting brings them back.
          </div>
        </>
      )}
    </section>
  )
}
