import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useReducedMotionPref } from '../hooks/useReducedMotionPref'
import './MagneticDock.css'

export interface DockItemData {
  id: string
  label: string
  icon: React.ReactNode
  onClick: () => void
  isActive?: boolean
  badge?: number
}

const ORDER_KEY = 'diskframe-dock-order'
/** Pointer travel before a press becomes a drag, so a click never reorders. */
const DRAG_THRESHOLD = 6

function readOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function writeOrder(ids: string[]): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(ids))
  } catch {
    /* an order we cannot persist is still usable for this session */
  }
}

/**
 * One glass capsule of equal-sized, labelled buttons, reorderable by dragging.
 *
 * Appearance is unchanged: nothing scales or moves on hover, so click targets
 * stay exactly where they are. (It replaced a macOS-style magnifier that scaled
 * icons 1.4x, moved neighbours, and re-rendered the dock on every pointer tick;
 * the pointer highlight is a CSS custom property written straight to the node.)
 *
 * A click activates a section. A press only becomes a drag once the pointer
 * travels DRAG_THRESHOLD, and a drag suppresses the click that would otherwise
 * follow - so reordering can never open a section by accident. Escape cancels
 * and restores the previous order. Ctrl+Left/Right reorders from the keyboard.
 */
function MagneticDock({ items }: { items: DockItemData[] }): React.JSX.Element {
  const reducedMotion = useReducedMotionPref()
  const dockRef = useRef<HTMLDivElement>(null)
  const raf = useRef(0)

  const [order, setOrder] = useState<string[]>(readOrder)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [announcement, setAnnouncement] = useState('')

  const press = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null)
  const orderBeforeDrag = useRef<string[]>([])

  // Saved order first, then anything new appended - so adding a dock item in a
  // later version does not discard the order the user chose.
  const ordered = useMemo(() => {
    const byId = new Map(items.map((i) => [i.id, i]))
    const out: DockItemData[] = []
    for (const id of order) {
      const hit = byId.get(id)
      if (hit) {
        out.push(hit)
        byId.delete(id)
      }
    }
    for (const rest of items) if (byId.has(rest.id)) out.push(rest)
    return out
  }, [items, order])

  const commit = useCallback((ids: string[]) => {
    setOrder(ids)
    writeOrder(ids)
  }, [])

  const move = useCallback(
    (id: string, delta: number) => {
      const ids = ordered.map((i) => i.id)
      const from = ids.indexOf(id)
      const to = Math.max(0, Math.min(ids.length - 1, from + delta))
      if (from < 0 || from === to) return
      ids.splice(to, 0, ids.splice(from, 1)[0])
      commit(ids)
      const label = ordered.find((i) => i.id === id)?.label ?? id
      setAnnouncement(label + ' moved to position ' + (to + 1) + ' of ' + ids.length)
    },
    [ordered, commit]
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent): void => {
      const { clientX, clientY } = e
      const p = press.current

      if (p && !p.moved && Math.hypot(clientX - p.x, clientY - p.y) > DRAG_THRESHOLD) {
        p.moved = true
        orderBeforeDrag.current = ordered.map((i) => i.id)
        setDragId(p.id)
      }

      if (p?.moved) {
        // Which gap the dragged item would land in.
        const buttons = Array.from(
          dockRef.current?.querySelectorAll<HTMLElement>('.app-dock-item') ?? []
        )
        let idx = buttons.length
        for (let i = 0; i < buttons.length; i++) {
          const r = buttons[i].getBoundingClientRect()
          if (clientX < r.left + r.width / 2) {
            idx = i
            break
          }
        }
        setDropIndex(idx)
        return
      }

      if (reducedMotion || raf.current) return
      raf.current = requestAnimationFrame(() => {
        raf.current = 0
        const el = dockRef.current
        if (!el) return
        const r = el.getBoundingClientRect()
        el.style.setProperty('--dock-mx', clientX - r.left + 'px')
        el.style.setProperty('--dock-my', clientY - r.top + 'px')
        el.style.setProperty('--dock-glow', '1')
      })
    },
    [reducedMotion, ordered]
  )

  const endDrag = useCallback(
    (apply: boolean) => {
      const p = press.current
      const wasDrag = !!p?.moved
      if (!wasDrag) {
        press.current = null
        setDragId(null)
        setDropIndex(null)
        return
      }
      if (apply && dropIndex != null && p) {
        const ids = ordered.map((i) => i.id)
        const from = ids.indexOf(p.id)
        let to = dropIndex
        if (from < to) to -= 1
        if (from >= 0 && from !== to) {
          ids.splice(to, 0, ids.splice(from, 1)[0])
          commit(ids)
          const label = ordered.find((i) => i.id === p.id)?.label ?? p.id
          setAnnouncement(label + ' moved to position ' + (to + 1))
        }
      } else if (!apply && orderBeforeDrag.current.length) {
        commit(orderBeforeDrag.current)
      }
      setDragId(null)
      setDropIndex(null)
      // Cleared after the click event so onClick can still see `moved`.
      setTimeout(() => {
        press.current = null
      }, 0)
    },
    [dropIndex, ordered, commit]
  )

  // Escape cancels a drag in progress and puts the order back.
  useEffect(() => {
    if (!dragId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        endDrag(false)
      }
    }
    const onUp = (): void => endDrag(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragId, endDrag])

  const handleMouseLeave = useCallback((): void => {
    if (raf.current) cancelAnimationFrame(raf.current)
    raf.current = 0
    dockRef.current?.style.setProperty('--dock-glow', '0')
  }, [])

  return (
    <div
      ref={dockRef}
      className={'app-dock' + (dragId ? ' is-dragging' : '')}
      role="tablist"
      aria-label="Library sections"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <span className="app-dock-sheen" aria-hidden="true" />
      {ordered.map((item, i) => (
        <React.Fragment key={item.id}>
          {dragId && dropIndex === i && <span className="app-dock-drop" aria-hidden="true" />}
          <button
            type="button"
            role="tab"
            className={
              'app-dock-item' +
              (item.isActive ? ' is-active' : '') +
              (dragId === item.id ? ' is-dragged' : '')
            }
            title={item.label + ' — drag to reorder, Ctrl+Arrow to move'}
            aria-label={item.label}
            aria-selected={!!item.isActive}
            onMouseDown={(e) => {
              if (e.button !== 0) return
              press.current = { id: item.id, x: e.clientX, y: e.clientY, moved: false }
            }}
            onClick={(e) => {
              // A drag must never also activate the section it was dragging.
              if (press.current?.moved || dragId) {
                e.preventDefault()
                return
              }
              item.onClick()
            }}
            onKeyDown={(e) => {
              // Keyboard-only reordering, so this is not mouse-exclusive.
              if (!e.ctrlKey) return
              if (e.key === 'ArrowLeft') {
                e.preventDefault()
                move(item.id, -1)
              } else if (e.key === 'ArrowRight') {
                e.preventDefault()
                move(item.id, 1)
              }
            }}
          >
            <span className="app-dock-icon">{item.icon}</span>
            <span className="app-dock-label">{item.label}</span>
            {!!item.badge && (
              <span className="app-dock-badge">{item.badge > 99 ? '99+' : item.badge}</span>
            )}
          </button>
        </React.Fragment>
      ))}
      {dragId && dropIndex === ordered.length && (
        <span className="app-dock-drop" aria-hidden="true" />
      )}
      <span className="app-dock-sr" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  )
}

export default React.memo(MagneticDock)
