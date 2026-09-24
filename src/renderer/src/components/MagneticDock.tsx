import React, { useCallback, useRef } from 'react'
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

/**
 * One glass capsule of equal-sized, labelled buttons.
 *
 * Replaces a macOS-style magnifier that scaled icons up to 1.4x on hover: that
 * moved neighbouring icons, grew click targets under the pointer, and pushed
 * labels and badges over each other - and it drove the scale of every item
 * through React state on every pointer tick, re-rendering the dock ~60 times a
 * second. The pointer highlight is now a CSS custom property written straight
 * to the DOM node, so following the cursor costs no React render at all, and
 * nothing ever changes size or position.
 */
function MagneticDock({ items }: { items: DockItemData[] }): React.JSX.Element {
  const reducedMotion = useReducedMotionPref()
  const dockRef = useRef<HTMLDivElement>(null)
  const raf = useRef(0)

  const handleMouseMove = useCallback(
    (e: React.MouseEvent): void => {
      if (reducedMotion || raf.current) return
      const { clientX, clientY } = e
      raf.current = requestAnimationFrame(() => {
        raf.current = 0
        const el = dockRef.current
        if (!el) return
        const r = el.getBoundingClientRect()
        el.style.setProperty('--dock-mx', `${clientX - r.left}px`)
        el.style.setProperty('--dock-my', `${clientY - r.top}px`)
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
