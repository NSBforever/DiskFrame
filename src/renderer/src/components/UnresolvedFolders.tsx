import React, { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, FolderSearch, X } from 'lucide-react'
import './UnresolvedFolders.css'

export interface UnresolvedRoot {
  root: string
  count: number
  sample: string
}

/**
 * The folders this drive's index expects that are not on the disk right now.
 *
 * Every one of these accounts for a block of files the gallery can only show
 * as unavailable, and one answer from the user fixes all of them at once. It
 * names the exact unresolved path rather than a count of broken tiles, because
 * "5,530 files under E:\College Memories" is something you can act on and
 * "5,530 files are missing" is not.
 */
export default function UnresolvedFolders({
  drive,
  onRelinked
}: {
  drive: string | null
  onRelinked: () => void
}): React.JSX.Element | null {
  const [roots, setRoots] = useState<UnresolvedRoot[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const refresh = useCallback(() => {
    if (!drive) {
      setRoots([])
      return
    }
    window.api
      .listUnresolvedRoots(drive)
      .then((r: { roots?: UnresolvedRoot[] }) => setRoots(r?.roots ?? []))
      .catch(() => setRoots([]))
  }, [drive])

  useEffect(() => {
    setDismissed(false)
    setNote(null)
    refresh()
  }, [drive, refresh])

  const locate = useCallback(
    async (root: string) => {
      setBusy(root)
      setNote(null)
      try {
        const res = await window.api.locateFolder(root)
        if (res?.saved) {
          setNote(
            `Relinked ${root} \u2192 ${res.target} (${res.found} of ${res.checked} sampled files matched).`
          )
          onRelinked()
          refresh()
        } else if (res?.cancelled) {
          setNote(null)
        } else {
          setNote(
            `That folder was not used: ${res?.reason ?? 'it does not hold the expected files'}. Nothing was changed.`
          )
        }
      } catch {
        setNote('Could not open the folder picker.')
      } finally {
        setBusy(null)
      }
    },
    [onRelinked, refresh]
  )

  if (!drive || dismissed || roots.length === 0) return null

  const total = roots.reduce((n, r) => n + r.count, 0)
  const shown = expanded ? roots : roots.slice(0, 3)

  return (
    <section className="unresolved glass-panel" aria-label="Folders that could not be found">
      <header className="unresolved-head">
        <AlertTriangle size={15} className="unresolved-icon" />
        <div className="unresolved-title">
          {roots.length} folder{roots.length === 1 ? '' : 's'} not found on {drive}
          <div className="unresolved-sub">
            {total.toLocaleString()} indexed file{total === 1 ? '' : 's'} are under them. The drive is
            connected — these folders are not at the paths they were indexed at.
          </div>
        </div>
        <button
          type="button"
          className="unresolved-x"
          aria-label="Hide this notice"
          onClick={() => setDismissed(true)}
        >
          <X size={14} />
        </button>
      </header>

      <ul className="unresolved-list">
        {shown.map((r) => (
          <li key={r.root} className="unresolved-row">
            <div className="unresolved-path" title={r.sample}>
              {r.root}
              <span className="unresolved-count">{r.count.toLocaleString()} files</span>
            </div>
            <button
              type="button"
              className="unresolved-btn"
              disabled={busy === r.root}
              onClick={() => locate(r.root)}
            >
              <FolderSearch size={13} />
              {busy === r.root ? 'Choosing…' : 'Locate folder'}
            </button>
          </li>
        ))}
      </ul>

      {roots.length > 3 && (
        <button type="button" className="unresolved-more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show fewer' : `Show ${roots.length - 3} more`}
        </button>
      )}

      {note && <div className="unresolved-note">{note}</div>}
    </section>
  )
}
