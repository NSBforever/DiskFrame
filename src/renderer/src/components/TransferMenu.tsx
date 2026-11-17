import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRightLeft, HardDrive, FolderOpen } from 'lucide-react'
import './TransferMenu.css'

export interface TransferDrive {
  name: string
  free: number
  connectionType?: 'internal' | 'external' | 'unknown'
}

/**
 * Copy or move the selection to another drive.
 *
 * A drive row opens the folder picker on that drive, so the files land in a
 * folder the user chose (or just made) rather than loose in its root; the
 * folder's own letter decides the destination drive. "Another folder" opens
 * the picker anywhere, this drive included.
 *
 * The dialog is portalled to <body>. It used to be positioned inside the
 * header, whose glass (backdrop-filter) makes a stacking context of its own:
 * its z-index ranked only inside the header, so the gallery - the floating
 * month pill, even the tiles - painted over it and cut it off.
 */
export default function TransferMenu({
  count,
  drives,
  currentDrive,
  onTransfer
}: {
  count: number
  drives: TransferDrive[]
  currentDrive: string | null
  onTransfer: (mode: 'copy' | 'move', destDir: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'copy' | 'move'>('copy')
  const rootRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    firstRef.current?.focus()
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!rootRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const items = `${count.toLocaleString()} ${count === 1 ? 'item' : 'items'}`
  const pick = async (startIn?: string): Promise<void> => {
    const verb = mode === 'copy' ? 'copy' : 'move'
    const dir = await window.api.pickFolder({
      title: `Choose where to ${verb} ${items}`,
      startIn
    })
    if (!dir) return
    setOpen(false)
    onTransfer(mode, dir)
  }

  const others = drives.filter((d) => d.name !== currentDrive)

  return (
    <div className="transfer" ref={rootRef}>
      <button
        type="button"
        className="sel-action"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ArrowRightLeft size={14} aria-hidden="true" />
        Transfer
      </button>
      {open &&
        createPortal(
          <div className="transfer-backdrop">
            <div
              className="transfer-pop"
              ref={popRef}
              role="dialog"
              aria-modal="true"
              aria-label={`Transfer ${items}`}
            >
              <div className="transfer-head">Transfer {items}</div>
              <div className="transfer-mode" role="radiogroup" aria-label="Copy or move">
                {(['copy', 'move'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={mode === m}
                    className={mode === m ? 'is-on' : ''}
                    onClick={() => setMode(m)}
                  >
                    {m === 'copy' ? 'Copy' : 'Move'}
                  </button>
                ))}
              </div>
              <p className="transfer-note">
                {mode === 'copy'
                  ? 'The originals stay where they are.'
                  : 'Each original is removed only after its copy is complete.'}
              </p>
              <div className="transfer-list">
                {others.map((d, i) => (
                  <button
                    key={d.name}
                    ref={i === 0 ? firstRef : undefined}
                    type="button"
                    className="transfer-row"
                    onClick={() => void pick(`${d.name}\\`)}
                  >
                    <HardDrive size={16} aria-hidden="true" />
                    <span className="transfer-name">{d.name}</span>
                    <span className="transfer-meta">
                      {d.connectionType === 'external'
                        ? 'External · '
                        : d.connectionType === 'internal'
                          ? 'Internal · '
                          : ''}
                      {d.free.toLocaleString()} GB free
                    </span>
                  </button>
                ))}
                {others.length === 0 && (
                  <p className="transfer-empty">No other drive is connected.</p>
                )}
                <button
                  ref={others.length === 0 ? firstRef : undefined}
                  type="button"
                  className="transfer-row"
                  onClick={() => void pick()}
                >
                  <FolderOpen size={16} aria-hidden="true" />
                  <span className="transfer-name">Another folder…</span>
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
