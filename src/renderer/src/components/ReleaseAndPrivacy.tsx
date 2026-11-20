import React, { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ShieldCheck, X } from 'lucide-react'
import type { PublishedRelease } from '../../../main/releaseHistory'
import { SettingsCard, SettingRow, SettingsSwitch } from './SettingsCard'
import './Events.css'

/**
 * 1.6.0: Update History, What's New after an update, and the privacy controls
 * for opt-in analytics. Release data is DiskFrame's public GitHub release list;
 * analytics never runs before the user says yes (see src/main/analytics.ts).
 */

type Privacy = Awaited<ReturnType<typeof window.api.privacyGet>>
const dateFmt = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'long',
  year: 'numeric'
})

function Dialog({
  title,
  onClose,
  children
}: {
  title: string
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
  // Portalled: inside a Settings card (backdrop-filter) a fixed overlay would be clipped to the card.
  return createPortal(
    <div
      className="ev-modal-back rp-back"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="ev-modal ev-modal-small rp-dialog glass-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="ev-modal-head">
          <h2>{title}</h2>
          <button type="button" className="ev-icon-btn" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="ev-modal-body">{children}</div>
      </div>
    </div>,
    document.body
  )
}

function ReleaseNotes({ r }: { r: PublishedRelease }): React.JSX.Element {
  return (
    <>
      {r.sections.map((s, i) => (
        <section key={i} className="rp-section">
          {s.title && <h4>{s.title}</h4>}
          <ul>
            {s.items.map((it, j) => (
              <li key={j}>{it}</li>
            ))}
          </ul>
        </section>
      ))}
      {r.sections.length === 0 && <p className="ev-dim">No notes for this version.</p>}
    </>
  )
}

/** Every published version, newest first, with its notes. */
export function UpdateHistoryDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [h, setH] = useState<Awaited<ReturnType<typeof window.api.releaseHistory>> | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    window.api.trackFeature('update_history_opened')
    window.api
      .releaseHistory()
      .then((v) => live && setH(v))
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [])
  return (
    <Dialog title="Update history" onClose={onClose}>
      {!h ? (
        <p className="ev-dim">
          {failed ? 'The release list could not be loaded. Try again later.' : 'Loading…'}
        </p>
      ) : (
        <>
          <p className="ev-dim rp-facts">
            Installed {h.installed}
            {h.latest ? ` · Latest ${h.latest}` : ''}
            {h.fromCache ? ' · offline, showing the saved list' : ''}
          </p>
          {h.releases.length === 0 && (
            <p className="ev-dim">
              The release list could not be loaded. Check the connection and try again.
            </p>
          )}
          {h.releases.map((r) => (
            <article key={r.version} className="rp-release">
              <header>
                <strong>{r.name}</strong>
                {r.version === h.installed && <span className="rp-badge">Installed</span>}
                <span className="ev-dim">{r.date ? dateFmt.format(new Date(r.date)) : ''}</span>
              </header>
              <ReleaseNotes r={r} />
            </article>
          ))}
        </>
      )}
    </Dialog>
  )
}

/** At startup: What's New if DiskFrame just updated, then the one-time consent question. Never both at once. */
export function StartupSheets(): React.JSX.Element | null {
  const [whatsNewDone, setWhatsNewDone] = useState(false)
  const done = useCallback(() => setWhatsNewDone(true), [])
  return whatsNewDone ? <ConsentPrompt /> : <WhatsNew onDone={done} />
}

/** Shown once, after DiskFrame has updated to a new version. */
function WhatsNew({ onDone }: { onDone: () => void }): React.JSX.Element | null {
  const [r, setR] = useState<PublishedRelease | null>(null)
  useEffect(() => {
    let live = true
    void window.api
      .whatsNew()
      .then((v) => live && (v ? setR(v) : onDone()))
      .catch(() => live && onDone())
    return () => {
      live = false
    }
  }, [onDone])
  if (!r) return null
  const close = (): void => {
    setR(null)
    onDone()
  }
  return (
    <Dialog title={`What's new in DiskFrame ${r.version}`} onClose={close}>
      <ReleaseNotes r={r} />
      <div className="ev-modal-foot">
        <button type="button" className="df-button df-button-primary" onClick={close}>
          Got it
        </button>
      </div>
    </Dialog>
  )
}

/** Asked once, and only in a build that can send anything at all. */
function ConsentPrompt(): React.JSX.Element | null {
  const [p, setP] = useState<Privacy | null>(null)
  useEffect(() => {
    let live = true
    window.api
      .privacyGet()
      .then((v) => live && setP(v))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  if (!p || !p.available || p.analytics !== null) return null
  // Hidden either way: an answer is stored only from the two buttons. Escape or a click
  // outside just closes it for now, and it is asked again on the next start.
  const answer = (yes: boolean): void => {
    setP(null)
    window.api.privacySet({ analytics: yes, crashes: yes }).catch(() => {})
  }
  return (
    <Dialog title="Help improve DiskFrame?" onClose={() => setP(null)}>
      <p>
        With your permission DiskFrame sends anonymous usage counts - which version you run, when it
        updates, which features are used - and short crash summaries. Each install is identified
        only by a random ID you can reset.
      </p>
      <p className="ev-dim">
        Never sent: file names, folders, photos, thumbnails, locations, faces or Calendar details.
        You can change this at any time in Settings → Privacy.
      </p>
      <div className="ev-modal-foot">
        <button type="button" className="df-button" onClick={() => answer(false)}>
          No thanks
        </button>
        <button type="button" className="df-button df-button-primary" onClick={() => answer(true)}>
          Allow
        </button>
      </div>
    </Dialog>
  )
}

/** Settings → Privacy. */
export function PrivacySettings(): React.JSX.Element {
  const [p, setP] = useState<Privacy | null>(null)
  useEffect(() => {
    let live = true
    window.api
      .privacyGet()
      .then((v) => live && setP(v))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  const set = (patch: { analytics?: boolean; crashes?: boolean; resetId?: boolean }): void =>
    void window.api
      .privacySet(patch)
      .then(setP)
      .catch(() => {})
  return (
    <SettingsCard
      id="privacy"
      icon={<ShieldCheck size={16} />}
      title="Privacy"
      description="Anonymous usage counts and crash summaries, only if you allow them. File names, folders, photos, locations and Calendar details are never sent."
    >
      {p && !p.available ? (
        <p className="settings-hint">This build does not send any usage data.</p>
      ) : (
        <>
          <SettingRow
            label="Share anonymous usage counts"
            htmlFor="settings-privacy-analytics"
            hint="Version, updates and which features are used."
          >
            <SettingsSwitch
              id="settings-privacy-analytics"
              checked={p?.analytics === true}
              onChange={(on) => set({ analytics: on })}
            />
          </SettingRow>
          <SettingRow
            label="Send crash summaries"
            htmlFor="settings-privacy-crashes"
            hint="Which part of DiskFrame stopped and why - never what you were viewing."
          >
            <SettingsSwitch
              id="settings-privacy-crashes"
              checked={p?.crashes === true}
              onChange={(on) => set({ crashes: on })}
            />
          </SettingRow>
          <SettingRow
            label="Analytics ID"
            hint={
              p?.hasId
                ? 'A random ID for this install. Resetting it makes this install look new.'
                : 'None - nothing has been shared.'
            }
          >
            <button
              type="button"
              className="df-button"
              disabled={!p?.hasId || !(p.analytics || p.crashes)}
              onClick={() => set({ resetId: true })}
            >
              Reset ID
            </button>
          </SettingRow>
        </>
      )}
    </SettingsCard>
  )
}
