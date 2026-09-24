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
 * Nothing scales, moves or reorders: click targets stay exactly where they
 * are, which is the whole point of the capsule layout. The only pointer
 * response is a highlight written straight to the node as a CSS custom
 * property, so following the cursor costs no React render.
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

  return (
    <div
      ref={dockRef}
      className="app-dock"
      role="tablist"
      aria-label="Library sections"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <span className="app-dock-sheen" aria-hidden="true" />
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
