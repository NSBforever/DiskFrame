import React, { useEffect, useRef, useState } from 'react'
import { CalendarDays, CalendarOff } from 'lucide-react'
import type { CalendarStatus } from '../../../main/calendarTypes'
import { calendarCard, calendarStatusLine } from '../../../main/calendarView'
import { SettingsCard, SettingRow, SettingsSwitch, SettingsSlider } from './SettingsCard'

/** The Google Calendar card in Settings. Everything it shows comes from the
 *  main process's status; it never sees a token. Which of the five card
 *  states a status is, and its chip, is decided in main/calendarView.ts. */
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
  const card = s ? calendarCard(s) : null
  const kind = card?.kind
  const hasAccount = kind === 'connected' || kind === 'expired' || kind === 'failed'
  const busy = state === 'connecting' || state === 'syncing'

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
    <SettingsCard
      id="calendar"
      icon={<CalendarDays size={16} />}
      title="Google Calendar"
      description="Shows your events beside the photos and videos taken during them. Read-only: DiskFrame never changes your calendar, and nothing about your files is sent to Google."
      chip={card ? { label: card.chip, tone: card.tone } : undefined}
      className={`calendar-card${kind === 'unavailable' ? ' is-unavailable' : ''}`}
    >
      {kind === 'unavailable' && s ? (
        // Nothing to press: a build without a Google client cannot connect, so
        // no button is drawn that looks like it might.
        <div className="settings-notice" role="status" data-calendar-state={state}>
          <CalendarOff size={18} aria-hidden="true" className="settings-notice-icon" />
          <div>
            <div className="settings-notice-title">{calendarStatusLine(s, now)}</div>
            <div className="settings-hint">
              There is nothing to connect here. Your library and photos are not affected.
            </div>
          </div>
        </div>
      ) : (
        <div className="settings-row settings-row--stack">
          <div className="settings-row-head settings-row-head--wrap">
            <div
              className={`settings-status${card && card.tone !== 'neutral' && card.tone !== 'ok' ? ` is-${card.tone}` : ''}`}
              role="status"
              aria-live="polite"
              data-calendar-state={state ?? ''}
            >
              {s ? calendarStatusLine(s, now) : ' '}
            </div>
            <div className="settings-actions">
              {kind === 'disconnected' && (
                <button
                  type="button"
                  className="df-button df-button-primary"
                  disabled={!card?.canConnect}
                  onClick={() => void window.api.calendarConnect().then(setS)}
                >
                  {state === 'connecting' ? 'Connecting…' : 'Connect Google Calendar'}
                </button>
              )}
              {kind === 'expired' && (
                <button
                  type="button"
                  className="df-button df-button-primary"
                  onClick={() => void window.api.calendarConnect().then(setS)}
                >
                  Reconnect
                </button>
              )}
              {hasAccount && kind !== 'expired' && (
                <button
                  type="button"
                  className="df-button"
                  disabled={busy}
                  onClick={() => void window.api.calendarSyncNow().then(setS)}
                >
                  {state === 'syncing' ? 'Syncing…' : kind === 'failed' ? 'Try Again' : 'Sync Now'}
                </button>
              )}
              {hasAccount && (
                <button
                  type="button"
                  className={`df-button${confirming ? ' df-button-primary' : ' df-button-quiet'}`}
                  disabled={busy}
                  onClick={disconnect}
                >
                  {confirming ? 'Confirm Disconnect' : 'Disconnect'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {hasAccount && s && (
        <>
          <SettingRow
            label="Sync automatically"
            htmlFor="settings-calendar-autosync"
            hint="Every 30 minutes while DiskFrame is open. Saved events stay available offline."
          >
            <SettingsSwitch
              id="settings-calendar-autosync"
              checked={s.autoSync}
              onChange={(on) => void window.api.calendarSetPrefs({ autoSync: on }).then(setS)}
            />
          </SettingRow>
          <div className="settings-row settings-row--stack">
            <div className="settings-row-head">
              <label htmlFor="settings-calendar-buffer" className="settings-label">
                Time around an event
              </label>
              <span className="settings-value" aria-hidden="true">
                {s.bufferMin} min
              </span>
            </div>
            <SettingsSlider
              id="settings-calendar-buffer"
              min={0}
              max={120}
              step={5}
              value={s.bufferMin}
              aria-valuetext={`${s.bufferMin} minutes`}
              onChange={(e) => setS({ ...s, bufferMin: Number(e.target.value) })}
              onPointerUp={(e) => void window.api.calendarSetPrefs({ bufferMin: Number((e.target as HTMLInputElement).value) }).then(setS)}
              onKeyUp={(e) => void window.api.calendarSetPrefs({ bufferMin: Number((e.target as HTMLInputElement).value) }).then(setS)}
            />
            <div className="settings-hint">Photos and videos taken this long before or after an event can be suggested for it.</div>
          </div>
          <p className="settings-footnote">
            Disconnect removes the sign-in and the saved events from this PC. Files you confirmed
            for an event stay linked, so reconnecting brings them back.
          </p>
        </>
      )}
    </SettingsCard>
  )
}
