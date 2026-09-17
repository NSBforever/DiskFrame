import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
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

const ICON_SIZE = 44
const MAX_SCALE = 1.4
const MAGNETIC_DISTANCE = 110

export default function MagneticDock({ items }: { items: DockItemData[] }): React.JSX.Element {
  const reducedMotion = useReducedMotionPref()
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  // Cached horizontal centers, in page coordinates - measured once on mount/
  // resize, never inside the mousemove handler (that's the layout-thrash bug
  // to avoid: no getBoundingClientRect() per pointer tick).
  const centers = useRef<number[]>([])
  const [scales, setScales] = useState<number[]>(() => items.map(() => 1))
  const raf = useRef(0)

  const measure = useCallback(() => {
    centers.current = itemRefs.current.map(el => {
      if (!el) return Infinity
      const rect = el.getBoundingClientRect()
      return rect.left + rect.width / 2
    })
  }, [])

  useLayoutEffect(() => {
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure, items.length])

  const handleMouseMove = (e: React.MouseEvent): void => {
    if (reducedMotion || raf.current) return
    const clientX = e.clientX
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      setScales(
        centers.current.map(c => {
          const d = Math.abs(clientX - c)
          return d >= MAGNETIC_DISTANCE ? 1 : 1 + (MAX_SCALE - 1) * (1 - d / MAGNETIC_DISTANCE)
        })
      )
    })
  }
  const handleMouseLeave = (): void => {
    if (raf.current) cancelAnimationFrame(raf.current)
    raf.current = 0
    setScales(items.map(() => 1))
  }

  return (
    <div className="magnetic-dock" onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave}>
      {items.map((item, i) => (
        <button
          key={item.id}
          ref={el => { itemRefs.current[i] = el }}
          type="button"
          className={'dock-item' + (item.isActive ? ' is-active' : '')}
          title={item.label}
          aria-label={item.label}
          aria-current={item.isActive ? 'page' : undefined}
          onClick={item.onClick}
          style={{
            width: ICON_SIZE,
            height: ICON_SIZE,
            transform: reducedMotion ? undefined : `scale(${scales[i] ?? 1}) translateY(${((scales[i] ?? 1) - 1) * -8}px)`
          }}
        >
          <span className="dock-item-glow" aria-hidden="true" />
          <span className="dock-item-icon">{item.icon}</span>
          {!!item.badge && <span className="dock-item-badge">{item.badge > 99 ? '99+' : item.badge}</span>}
          <span className="dock-item-tooltip">{item.label}</span>
        </button>
      ))}
    </div>
  )
}
