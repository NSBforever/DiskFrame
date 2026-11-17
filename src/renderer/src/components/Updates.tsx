import { useCallback, useEffect, useState } from 'react'
import {
  parseSnooze,
  shouldAnnounce,
  statusLine,
  SNOOZE_MS,
  type UpdateMode,
  type UpdateState
} from '../../../main/updateState'
import GlassSelect from './GlassSelect'
import './Updates.css'

/**
 * The update notice and the Updates card in Settings. Both read the one state
 * the main process pushes (main/updater.ts); what to show and when is decided
 * by the tested rules in main/updateState.ts, not here.
 */

const SNOOZE_KEY = 'df-update-snooze'

/** The newer version's notes, collapsed, as plain text (never injected as HTML). */
function ReleaseNotes({ version, notes, open }: { version?: string; notes?: string; open?: boolean }): React.JSX.Element | null {
  if (!notes) return null
  return (
    <details className="update-notes" open={open}>
      <summary>What&apos;s new{version ? ` in ${version}` : ''}</summary>
      <div className="update-notes-text">{notes}</div>
    </details>
  )
}

function readSnooze(): ReturnType<typeof parseSnooze> {
  try {
    return parseSnooze(localStorage.getItem(SNOOZE_KEY))
  } catch {
    return null
  }
}

/** The pushed state, and when it arrived - the clock the snooze is read against. */
function useUpdateState(): { state: UpdateState | null; at: number } {
  const [value, setValue] = useState<{ state: UpdateState | null; at: number }>({ state: null, at: 0 })
  useEffect(() => {
    let live = true
    const take = (state: UpdateState): void => setValue({ state, at: Date.now() })
    window.api.getUpdateState?.().then((s) => live && take(s)).catch(() => {})
    const off = window.api.onUpdateState?.(take)
    return () => {
      live = false
      off?.()
    }
  }, [])
  return value
}

/** Restart into the downloaded version; says why not when a transfer is running. */
function useInstall(): { install: () => void; refused: string | null } {
  const [refused, setRefused] = useState<string | null>(null)
  const install = useCallback((): void => {
    setRefused(null)
    void window.api.installUpdate().then((r) => {
      if (r.ok) return
      setRefused(r.reason === 'busy' ? 'A file transfer is running. Install once it has finished.' : 'The update could not be installed from this build.')
    })
  }, [])
  return { install, refused }
}

/**
 * Bottom-left notice. `busy` is a file transfer or an open viewer: nothing is
 * shown over either, and the notice appears once it is over.
 */
export function UpdateNotice({ busy }: { busy: boolean }): React.JSX.Element | null {
  const { state, at } = useUpdateState()
  // "Not now" for this session: one version, so a newer one is announced again.
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [snooze, setSnooze] = useState(readSnooze)
  const { install, refused } = useInstall()

  if (!state || !state.version) return null
  if (!shouldAnnounce(state, { busy, snooze, now: at, dismissed: dismissed === state.version })) return null

  const { phase, version, currentVersion, canInstall } = state
  const later = (): void => {
    if (phase === 'available') {
      const s = { version, until: Date.now() + SNOOZE_MS }
      try {
        localStorage.setItem(SNOOZE_KEY, JSON.stringify(s))
      } catch {
        /* a private profile: the notice simply returns next launch */
      }
      setSnooze(s)
    }
    setDismissed(version)
  }
  // The portable exe cannot replace itself: its download is the release page.
  const download = (): void => void (canInstall ? window.api.downloadUpdate() : window.api.openReleaseNotes())
  const percent = Math.round(state.percent ?? 0)

  return (
    <div className="glass-panel update-notice" role="status" aria-live="polite">
      <div className="update-notice-title">
        {phase === 'ready' ? `DiskFrame ${version} is ready to install` : `DiskFrame ${version} is available`}
      </div>
      <div className="update-notice-text">Your current version: {currentVersion}</div>
      {phase === 'available' && !state.notes && <div className="update-notice-text">Discover the latest improvements and fixes.</div>}
      {phase !== 'error' && <ReleaseNotes version={version} notes={state.notes} open={phase === 'available'} />}
      {phase === 'downloading' && (
        <>
          <div className="update-notice-text">Downloading in the background… {percent}%</div>
          <div className="update-notice-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <div style={{ transform: `scaleX(${percent / 100})` }} />
          </div>
        </>
      )}
      {phase === 'ready' && (
        <div className="update-notice-text">Downloaded and verified. It installs when you close DiskFrame, or now.</div>
      )}
      {phase === 'error' && <div className="update-notice-text update-notice-error">Could not download the update: {state.error}</div>}
      {refused && <div className="update-notice-text update-notice-error">{refused}</div>}
      <div className="update-notice-actions">
        {phase === 'available' && (
          <button type="button" className="df-button df-button-primary" onClick={download}>
            Update Now
          </button>
        )}
        {phase === 'error' && (
          <button type="button" className="df-button df-button-primary" onClick={download}>
            Try Again
          </button>
        )}
        {phase === 'ready' && (
          <button type="button" className="df-button df-button-primary" onClick={install}>
            Restart and Install
          </button>
        )}
        <button type="button" className="df-button" onClick={() => void window.api.openReleaseNotes()}>
          View Release Notes
        </button>
        <button type="button" className="df-button df-button-quiet" onClick={later}>
          {phase === 'available' ? 'Remind Me Later' : phase === 'downloading' ? 'Hide' : 'Later'}
        </button>
      </div>
    </div>
  )
}

const MODES: { value: UpdateMode; label: string }[] = [
  { value: 'auto', label: 'Download and install automatically' },
  { value: 'notify', label: 'Tell me when one is available' },
  { value: 'off', label: 'Do not check' }
]

/** The Updates card in Settings: the mode, what the last check found, and a manual check. */
export function UpdateSettings(): React.JSX.Element {
  const { state } = useUpdateState()
  const [mode, setMode] = useState<UpdateMode>('auto')
  const { install, refused } = useInstall()
  // "Checked 5 minutes ago" is relative to now; re-read it while the page is open.
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    window.api.getUpdateMode?.().then(setMode).catch(() => {})
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  const phase = state?.phase
  const working = phase === 'checking' || phase === 'downloading'
  return (
    <section className="glass-panel settings-card" aria-labelledby="updates-heading">
      <h3 id="updates-heading" className="settings-heading">
        Updates
      </h3>
      <div className="settings-field">
        <div className="settings-field-head">
          <span className="settings-label">New versions</span>
          <GlassSelect
            label="New versions"
            value={mode}
            options={MODES}
            onChange={(next) => {
              setMode(next)
              void window.api.setUpdateMode(next)
            }}
          />
        </div>
        <div className="settings-hint">
          DiskFrame checks its GitHub releases a little after it starts and every few hours. A download is
          verified before it is installed. Nothing about your files is sent.
        </div>
        <div className="settings-field-head">
          <div className="settings-status" role="status" aria-live="polite">
            {state ? statusLine(state, now) : ' '}
          </div>
          <div className="settings-actions">
            {phase === 'available' && (
              <button
                type="button"
                className="df-button df-button-primary"
                onClick={() => void (state?.canInstall ? window.api.downloadUpdate() : window.api.openReleaseNotes())}
              >
                Update Now
              </button>
            )}
            {phase === 'error' && state?.version && (
              <button type="button" className="df-button df-button-primary" onClick={() => void window.api.downloadUpdate()}>
                Try Again
              </button>
            )}
            {phase === 'ready' && (
              <button type="button" className="df-button df-button-primary" onClick={install}>
                Restart and Install
              </button>
            )}
            {state?.version && (
              <button type="button" className="df-button" onClick={() => void window.api.openReleaseNotes()}>
                View Release Notes
              </button>
            )}
            <button
              type="button"
              className="df-button"
              disabled={!state || working || phase === 'ready' || phase === 'unsupported'}
              onClick={() => {
                setNow(Date.now())
                void window.api.checkForUpdates().then(() => setNow(Date.now()))
              }}
            >
              {phase === 'checking' ? 'Checking…' : 'Check for Updates'}
            </button>
          </div>
        </div>
        {refused && <div className="settings-hint update-notice-error">{refused}</div>}
        {state?.version && phase !== 'current' && <ReleaseNotes version={state.version} notes={state.notes} />}
        {state && !state.canInstall && phase !== 'unsupported' && (
          <div className="settings-hint">
            This is the portable version, which cannot replace itself. Update Now opens the release page.
          </div>
        )}
      </div>
    </section>
  )
}
