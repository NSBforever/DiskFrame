import React, { useCallback, useEffect, useRef } from 'react'
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

/** Left over from the removed drag-to-reorder feature. */
const STALE_ORDER_KEY = 'diskframe-dock-order'

/**
 * One glass capsule of equal-sized, labelled buttons in a fixed order.
 *
 * Click targets stay exactly where they are; only the red well behind the
 * selected section slides, positioned in CSS from its index. The pointer
 * highlight is written straight to the node as a CSS custom property, so
 * following the cursor costs no React render.
 */
function MagneticDock({ items }: { items: DockItemData[] }): React.JSX.Element {
  const reducedMotion = useReducedMotionPref()
  const dockRef = useRef<HTMLDivElement>(null)
  const raf = useRef(0)

  // Drop the preference the reorder feature used to write. Scoped to that one
  // key so every other stored setting (theme, tile size) is untouched.
  useEffect(() => {
    try {
      localStorage.removeItem(STALE_ORDER_KEY)
    } catch {
      /* nothing to clean up if storage is unavailable */
    }
  }, [])

  const handleMouseMove = useCallback(
    (e: React.MouseEvent): void => {
      if (reducedMotion || raf.current) return
      const { clientX, clientY } = e
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
    [reducedMotion]
  )

  const handleMouseLeave = useCallback((): void => {
    if (raf.current) cancelAnimationFrame(raf.current)
    raf.current = 0
    dockRef.current?.style.setProperty('--dock-glow', '0')
  }, [])

  useEffect(() => {
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current)
    }
  }, [])

  // Left/Right/Home/End move focus between sections, as a tablist does.
  // Stopped here so the gallery's own arrow-key navigation does not also act.
  const handleKeyDown = useCallback((e: React.KeyboardEvent): void => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
    if (!keys.includes(e.key)) return
    const buttons = [
      ...(dockRef.current?.querySelectorAll<HTMLButtonElement>('.app-dock-item') ?? [])
    ]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    e.preventDefault()
    e.stopPropagation()
    const last = buttons.length - 1
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? last
          : e.key === 'ArrowLeft'
            ? at === 0
              ? last
              : at - 1
            : at === last
              ? 0
              : at + 1
    buttons[next].focus()
  }, [])

  const activeIndex = items.findIndex((item) => item.isActive)

  return (
    <div
      ref={dockRef}
      className="app-dock"
      role="tablist"
      aria-label="Library sections"
      style={{ '--dock-active': activeIndex } as React.CSSProperties}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onKeyDown={handleKeyDown}
    >
      <span className="app-dock-sheen" aria-hidden="true" />
      {activeIndex >= 0 && <span className="app-dock-well" aria-hidden="true" />}
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          className={'app-dock-item' + (item.isActive ? ' is-active' : '')}
          title={item.label}
          aria-label={item.label}
          aria-selected={!!item.isActive}
          onClick={item.onClick}
        >
          <span className="app-dock-icon">{item.icon}</span>
          <span className="app-dock-label">{item.label}</span>
          {!!item.badge && (
            <span className="app-dock-badge">{item.badge > 99 ? '99+' : item.badge}</span>
          )}
        </button>
      ))}
    </div>
  )
}

export default React.memo(MagneticDock)
