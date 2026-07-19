import { useState, useRef, useCallback, useEffect } from 'react'

export interface ZoomPanState {
  scale: number
  translateX: number
  translateY: number
}

export function useZoomPan(
  containerRef: React.RefObject<HTMLDivElement | null>,
  imageDimensions: { width: number; height: number } | null
) {
  const [state, setState] = useState<ZoomPanState>({ scale: 1, translateX: 0, translateY: 0 })
  const stateRef = useRef(state)
  stateRef.current = state

  const isDraggingRef = useRef(false)
  const lastMousePosRef = useRef({ x: 0, y: 0 })
  const velocityRef = useRef({ x: 0, y: 0 })
  const lastTimeRef = useRef(0)
  const rafRef = useRef<number | null>(null)

  const reset = useCallback(() => {
    setState({ scale: 1, translateX: 0, translateY: 0 })
    velocityRef.current = { x: 0, y: 0 }
  }, [])

  const getBounds = useCallback((scale: number) => {
    if (!containerRef.current || !imageDimensions) {
      return { minX: 0, maxX: 0, minY: 0, maxY: 0 }
    }
    const container = containerRef.current
    const cw = container.clientWidth
    const ch = container.clientHeight
    const iw = imageDimensions.width
    const ih = imageDimensions.height

    const scaleToFit = Math.min(cw / iw, ch / ih)
    const fitW = iw * scaleToFit
    const fitH = ih * scaleToFit

    const zoomedW = fitW * scale
    const zoomedH = fitH * scale

    let minX = 0, maxX = 0
    if (zoomedW > cw) {
      maxX = (zoomedW - cw) / 2
      minX = -maxX
    }

    let minY = 0, maxY = 0
    if (zoomedH > ch) {
      maxY = (zoomedH - ch) / 2
      minY = -maxY
    }

    return { minX, maxX, minY, maxY }
  }, [imageDimensions, containerRef])

  const clampTranslation = useCallback((scale: number, tx: number, ty: number) => {
    const { minX, maxX, minY, maxY } = getBounds(scale)
    return {
      x: Math.max(minX, Math.min(maxX, tx)),
      y: Math.max(minY, Math.min(maxY, ty))
    }
  }, [getBounds])

  const zoomTo = useCallback((newScale: number, clientX?: number, clientY?: number) => {
    const nextScale = Math.max(1, Math.min(8, newScale)) // Clamp minimum zoom to 1.0 (actual size or fit)
    const current = stateRef.current

    if (!clientX || !clientY || !containerRef.current) {
      // Zoom to center
      setState(prev => {
        const clamped = clampTranslation(nextScale, prev.translateX, prev.translateY)
        return { scale: nextScale, translateX: clamped.x, translateY: clamped.y }
      })
      return
    }

    const rect = containerRef.current.getBoundingClientRect()
    const containerX = clientX - rect.left
    const containerY = clientY - rect.top

    const ratio = nextScale / current.scale
    
    // Zoom to cursor coordinates logic
    const nextTx = containerX - (containerX - current.translateX) * ratio
    const nextTy = containerY - (containerY - current.translateY) * ratio

    const clamped = clampTranslation(nextScale, nextTx, nextTy)
    setState({ scale: nextScale, translateX: clamped.x, translateY: clamped.y })
  }, [clampTranslation, containerRef])

  const panBy = useCallback((dx: number, dy: number) => {
    setState(prev => {
      const nextTx = prev.translateX + dx
      const nextTy = prev.translateY + dy
      const clamped = clampTranslation(prev.scale, nextTx, nextTy)
      return { ...prev, translateX: clamped.x, translateY: clamped.y }
    })
  }, [clampTranslation])

  useEffect(() => {
    const updateInertia = (time: number) => {
      if (isDraggingRef.current) {
        lastTimeRef.current = time
        rafRef.current = requestAnimationFrame(updateInertia)
        return
      }

      if (!lastTimeRef.current) {
        lastTimeRef.current = time
      }
      const elapsed = time - lastTimeRef.current
      lastTimeRef.current = time

      let vx = velocityRef.current.x
      let vy = velocityRef.current.y

      if (Math.abs(vx) < 0.05 && Math.abs(vy) < 0.05) {
        velocityRef.current = { x: 0, y: 0 }
        rafRef.current = requestAnimationFrame(updateInertia)
        return
      }

      const friction = Math.pow(0.92, elapsed / 16)
      vx *= friction
      vy *= friction
      velocityRef.current = { x: vx, y: vy }

      const dx = vx * (elapsed / 16)
      const dy = vy * (elapsed / 16)

      panBy(dx, dy)

      rafRef.current = requestAnimationFrame(updateInertia)
    }

    rafRef.current = requestAnimationFrame(updateInertia)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [panBy])

  return {
    scale: state.scale,
    translateX: state.translateX,
    translateY: state.translateY,
    zoomTo,
    panBy,
    reset,
    isDraggingRef,
    lastMousePosRef,
    velocityRef,
    lastTimeRef
  }
}
