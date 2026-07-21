import { useEffect, useRef, useState } from 'react'

export interface GestureProps {
  containerRef: React.RefObject<HTMLDivElement | null>
  scale: number
  zoomTo: (scale: number, clientX?: number, clientY?: number) => void
  panBy: (dx: number, dy: number) => void
  reset: () => void
  isDraggingRef: React.MutableRefObject<boolean>
  lastMousePosRef: React.MutableRefObject<{ x: number; y: number }>
  velocityRef: React.MutableRefObject<{ x: number; y: number }>
  lastTimeRef: React.MutableRefObject<number>
  onNext: () => void
  onPrev: () => void
}

export function useGestures({
  containerRef,
  scale,
  zoomTo,
  panBy,
  isDraggingRef,
  lastMousePosRef,
  velocityRef,
  lastTimeRef,
  onNext,
  onPrev
}: GestureProps) {
  const [swipeOffset, setSwipeOffset] = useState(0)
  const swipeOffsetRef = useRef(0)
  swipeOffsetRef.current = swipeOffset

  const touchStartDistRef = useRef<number | null>(null)
  const touchStartScaleRef = useRef(1)
  const touchCenterRef = useRef({ x: 0, y: 0 })

  const trackpadSwipeAccumRef = useRef(0)
  const lastTrackpadSwipeTimeRef = useRef(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()

      if (e.ctrlKey) {
        // Trackpad pinch-to-zoom
        const zoomFactor = 1 - e.deltaY * 0.007
        const nextScale = scale * zoomFactor
        zoomTo(nextScale, e.clientX, e.clientY)
      } else {
        if (scale > 1) {
          // Pan when zoomed
          panBy(-e.deltaX * 0.6, -e.deltaY * 0.6)
        } else {
          // Trackpad swipe to navigate
          const now = Date.now()
          if (now - lastTrackpadSwipeTimeRef.current > 500) {
            trackpadSwipeAccumRef.current += e.deltaX
            if (trackpadSwipeAccumRef.current > 120) {
              onNext()
              trackpadSwipeAccumRef.current = 0
              lastTrackpadSwipeTimeRef.current = now
            } else if (trackpadSwipeAccumRef.current < -120) {
              onPrev()
              trackpadSwipeAccumRef.current = 0
              lastTrackpadSwipeTimeRef.current = now
            }
          }
        }
      }
    }

    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', handleWheel)
    }
  }, [containerRef, scale, zoomTo, panBy, onNext, onPrev])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    let dragStartPos = { x: 0, y: 0 }
    let dragStartTime = 0

    const handlePointerDown = (e: PointerEvent) => {
      if (e.button === 2) return

      // Prevent gestures / pointer capturing on buttons, inputs, selects, or toolbar/video custom controls
      const target = e.target as HTMLElement
      if (
        target.closest('button') ||
        target.closest('input') ||
        target.closest('select') ||
        target.closest('.media-viewer-controls') ||
        target.closest('.slide-nav-btn') ||
        target.closest('[data-no-drag]')
      ) {
        return
      }

      el.setPointerCapture(e.pointerId)
      isDraggingRef.current = true
      dragStartPos = { x: e.clientX, y: e.clientY }
      lastMousePosRef.current = { x: e.clientX, y: e.clientY }
      dragStartTime = performance.now()
      velocityRef.current = { x: 0, y: 0 }
      lastTimeRef.current = dragStartTime
    }

    const handlePointerMove = (e: PointerEvent) => {
      if (!isDraggingRef.current) return

      const now = performance.now()
      const dt = now - lastTimeRef.current
      const dx = e.clientX - lastMousePosRef.current.x
      const dy = e.clientY - lastMousePosRef.current.y

      if (scale > 1) {
        panBy(dx, dy)
        if (dt > 0) {
          velocityRef.current = {
            x: (dx / dt) * 16,
            y: (dy / dt) * 16
          }
        }
      } else {
        const totalDx = e.clientX - dragStartPos.x
        setSwipeOffset(totalDx)
      }

      lastMousePosRef.current = { x: e.clientX, y: e.clientY }
      lastTimeRef.current = now
    }

    const handlePointerUp = (e: PointerEvent) => {
      if (!isDraggingRef.current) return
      isDraggingRef.current = false
      el.releasePointerCapture(e.pointerId)

      if (scale === 1) {
        const threshold = 100
        const currentOffset = swipeOffsetRef.current
        if (currentOffset > threshold) {
          onPrev()
        } else if (currentOffset < -threshold) {
          onNext()
        }
        animateSnapBack()
      }
    }

    const animateSnapBack = () => {
      let start: number | null = null
      const initialOffset = swipeOffsetRef.current
      if (initialOffset === 0) return

      const snap = (timestamp: number) => {
        if (!start) start = timestamp
        const progress = Math.min((timestamp - start) / 200, 1)
        const ease = 1 - (1 - progress) * (1 - progress)
        const nextOffset = initialOffset * (1 - ease)

        if (isDraggingRef.current) return

        setSwipeOffset(nextOffset)
        if (progress < 1) {
          requestAnimationFrame(snap)
        } else {
          setSwipeOffset(0)
        }
      }
      requestAnimationFrame(snap)
    }

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const t1 = e.touches[0]
        const t2 = e.touches[1]
        const dx = t1.clientX - t2.clientX
        const dy = t1.clientY - t2.clientY
        touchStartDistRef.current = Math.sqrt(dx * dx + dy * dy)
        touchStartScaleRef.current = scale
        touchCenterRef.current = {
          x: (t1.clientX + t2.clientX) / 2,
          y: (t1.clientY + t2.clientY) / 2
        }
        isDraggingRef.current = false
      }
    }

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && touchStartDistRef.current !== null) {
        e.preventDefault()
        const t1 = e.touches[0]
        const t2 = e.touches[1]
        const dx = t1.clientX - t2.clientX
        const dy = t1.clientY - t2.clientY
        const dist = Math.sqrt(dx * dx + dy * dy)
        const ratio = dist / touchStartDistRef.current
        const targetScale = touchStartScaleRef.current * ratio

        zoomTo(targetScale, touchCenterRef.current.x, touchCenterRef.current.y)
      }
    }

    const handleTouchEnd = () => {
      touchStartDistRef.current = null
    }

    el.addEventListener('pointerdown', handlePointerDown)
    el.addEventListener('pointermove', handlePointerMove)
    el.addEventListener('pointerup', handlePointerUp)
    el.addEventListener('pointercancel', handlePointerUp)

    el.addEventListener('touchstart', handleTouchStart, { passive: true })
    el.addEventListener('touchmove', handleTouchMove, { passive: false })
    el.addEventListener('touchend', handleTouchEnd, { passive: true })

    return () => {
      el.removeEventListener('pointerdown', handlePointerDown)
      el.removeEventListener('pointermove', handlePointerMove)
      el.removeEventListener('pointerup', handlePointerUp)
      el.removeEventListener('pointercancel', handlePointerUp)

      el.removeEventListener('touchstart', handleTouchStart)
      el.removeEventListener('touchmove', handleTouchMove)
      el.removeEventListener('touchend', handleTouchEnd)
    }
  }, [containerRef, scale, panBy, zoomTo, onNext, onPrev, isDraggingRef, lastMousePosRef, velocityRef, lastTimeRef])

  return {
    swipeOffset,
    setSwipeOffset
  }
}
export default useGestures
