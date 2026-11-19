import React, { useCallback, useEffect, useState } from 'react'
import { HardDrive, Layers, Unplug, X } from 'lucide-react'
import type { DriveScope } from '../../../main/driveScope'
import './Events.css'
import './AllDrives.css'

/**
 * All Drives: browse the files already indexed on several drives as one
 * library. Nothing is copied or merged; each file stays on its own drive and
 * the choice of drives is remembered by each drive's identity, not its letter.
 */

type ScopeInfo = Awaited<ReturnType<typeof window.api.driveScope>>
type ScopeVolume = ScopeInfo['volumes'][number]

function driveName(v: Pick<ScopeVolume, 'label' | 'letter' | 'mountedLetter'>): string {
  const letter = v.mountedLetter ?? v.letter
  const label = (v.label ?? '').trim()
  if (label && label.length > 3) return letter ? `${label} (${letter})` : label
  return letter ? `Local Disk (${letter})` : 'Drive'
}

/** The stored selection and every indexed drive, refreshed when drives come and go. */
function useDriveScope(): { info: ScopeInfo | null; save: (s: DriveScope) => Promise<void> } {
  const [info, setInfo] = useState<ScopeInfo | null>(null)
  useEffect(() => {
    let live = true
    const load = (): void => void window.api.driveScope().then((i) => live && setInfo(i))
    load()
    const off = window.api.onDrivesUpdated(load)
    return () => {
      live = false
      off()
    }
  }, [])
  const save = useCallback(async (s: DriveScope) => setInfo(await window.api.setDriveScope(s)), [])
  return { info, save }
}

function scopeSummary(info: ScopeInfo | null): {
  included: ScopeVolume[]
  offline: number
  files: number
  text: string
} {
  const vols = info?.volumes ?? []
  const included = vols.filter((v) => v.included)
  const offline = included.filter((v) => !v.mountedLetter).length
  const files = included.reduce((n, v) => n + v.count, 0)
  const plural = (n: number): string => `drive${n === 1 ? '' : 's'}`
  const text =
    info?.scope.mode === 'all'
      ? `All ${vols.length} ${plural(vols.length)}`
      : `${included.length} of ${vols.length} ${plural(vols.length)}`
  return { included, offline, files, text }
}

/** The first card on the drive page. */
export function AllDrivesCard({ onOpen }: { onOpen: () => void }): React.JSX.Element | null {
  const { info, save } = useDriveScope()
  const [choosing, setChoosing] = useState(false)
  if (!info || info.volumes.length === 0) return null
  const s = scopeSummary(info)
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className="drive-card all-drives-card"
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onOpen()
          }
        }}
        aria-label={`All Drives: ${s.text}, ${s.files.toLocaleString()} files`}
      >
        <div className="drive-card-top">
          <Layers className="drive-icon" size={26} color="#e5e5e5" />
          <span className="drive-badge-row">
            <span className="drive-badge drive-badge-media">Combined</span>
          </span>
        </div>
        <div className="drive-name">All Drives</div>
        <div className="drive-space">
          {s.text}
          {s.offline > 0 && ` · ${s.offline} not connected`}
        </div>
        <div className="all-drives-letters" aria-hidden>
          {s.included.map((v) => (
            // A disconnected drive by its name: its old letter may belong to another drive now.
            <span
              key={v.volumeId}
              className={`all-drives-letter${v.mountedLetter ? '' : ' is-offline'}`}
              title={v.mountedLetter ? driveName(v) : 'Not connected'}
            >
              {v.mountedLetter ?? (v.label?.trim() || v.letter || '?')}
            </span>
          ))}
        </div>
        <div className="drive-filecount all-drives-foot">
          <span>{s.files.toLocaleString()} files indexed</span>
          <button
            type="button"
            className="all-drives-choose"
            onClick={(e) => {
              e.stopPropagation()
              setChoosing(true)
            }}
          >
            Choose drives…
          </button>
        </div>
      </div>
      {choosing && (
        <DriveScopeDialog
          info={info}
          onClose={() => setChoosing(false)}
          onSave={async (sc) => {
            await save(sc)
            setChoosing(false)
          }}
        />
      )}
    </>
  )
}

/** Shown in the gallery header while All Drives is open: which drives are in it, and a way to change that. */
export function DriveScopeChip({ onChanged }: { onChanged: () => void }): React.JSX.Element | null {
  const { info, save } = useDriveScope()
  const [choosing, setChoosing] = useState(false)
  if (!info) return null
  const s = scopeSummary(info)
  return (
    <>
      <button
        type="button"
        className="all-drives-chip"
        title={s.included
          .map((v) => `${driveName(v)}${v.mountedLetter ? '' : ' - not connected'}`)
          .join('\n')}
        onClick={() => setChoosing(true)}
      >
        <Layers size={12} /> All Drives · {s.text}
        {s.offline > 0 && (
          <span className="all-drives-chip-off" aria-label={`${s.offline} not connected`}>
            <Unplug size={11} /> {s.offline}
          </span>
        )}
      </button>
      {choosing && (
        <DriveScopeDialog
          info={info}
          onClose={() => setChoosing(false)}
          onSave={async (sc) => {
            await save(sc)
            setChoosing(false)
            onChanged()
          }}
        />
      )}
    </>
  )
}

export function DriveScopeDialog({
  info,
  onClose,
  onSave
}: {
  info: ScopeInfo
  onClose: () => void
  onSave: (s: DriveScope) => Promise<void>
}): React.JSX.Element {
  const all = info.volumes.map((v) => v.volumeId)
  const [mode, setMode] = useState<DriveScope['mode']>(info.scope.mode)
  const [chosen, setChosen] = useState(
    () => new Set(info.volumes.filter((v) => v.included).map((v) => v.volumeId))
  )
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
  const toggle = (id: string): void => {
    const base = mode === 'all' ? new Set(all) : new Set(chosen)
    if (base.has(id)) base.delete(id)
    else base.add(id)
    setMode('some')
    setChosen(base)
  }
  return (
    <div className="ev-modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="ev-modal ev-modal-small glass-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Drives in All Drives"
      >
        <div className="ev-modal-head">
          <div>
            <h2>Drives in All Drives</h2>
            <p className="ev-dim">
              Their indexed photos and videos are shown together, newest first. Nothing is copied;
              each file stays on its own drive.
            </p>
          </div>
          <button type="button" className="ev-icon-btn" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="ev-modal-body ev-form">
          <label className="ev-check">
            <input
              type="checkbox"
              checked={mode === 'all'}
              onChange={(e) => {
                setMode(e.target.checked ? 'all' : 'some')
                setChosen(new Set(all))
              }}
            />
            <span>
              <strong>Every drive</strong>
              <span className="ev-dim">Including drives you index later.</span>
            </span>
          </label>
          <ul className="all-drives-list">
            {info.volumes.map((v) => (
              <li key={v.volumeId}>
                <label className="ev-check">
                  <input
                    type="checkbox"
                    checked={mode === 'all' || chosen.has(v.volumeId)}
                    onChange={() => toggle(v.volumeId)}
                  />
                  <span>
                    <strong>
                      <HardDrive size={13} aria-hidden /> {driveName(v)}
                    </strong>
                    <span className="ev-dim">
                      {v.count.toLocaleString()} files ·{' '}
                      {v.mountedLetter
                        ? 'connected'
                        : `not connected${v.letter ? ` (last seen as ${v.letter})` : ''} - its files stay listed but cannot be opened`}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="ev-modal-foot">
            <button type="button" className="df-button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="df-button df-button-primary"
              disabled={mode === 'some' && chosen.size === 0}
              onClick={() =>
                void onSave(
                  mode === 'all' ? { mode: 'all' } : { mode: 'some', volumeIds: [...chosen] }
                )
              }
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
