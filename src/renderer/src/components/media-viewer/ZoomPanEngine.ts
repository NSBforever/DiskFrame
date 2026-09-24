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

  /**
   * Screen pixels per image pixel when the image is fitted.
   *
   * Capped at 1: fitting must never upscale, which keeps "Fit" and "100%"
   * identical for an image smaller than the viewport and matches what the CSS
   * actually renders (object-fit: contain under max-width/height: 100%).
   * `scale` throughout this hook is a multiplier ON TOP of this, so scale === 1
   * means fitted - which is exactly why the toolbar must not print it as 100%.
   */
  const getFitScale = useCallback(() => {
    if (!containerRef.current || !imageDimensions) return 1
    const { clientWidth: cw, clientHeight: ch } = containerRef.current
    const { width: iw, height: ih } = imageDimensions
    if (!iw || !ih || !cw || !ch) return 1
    return Math.min(1, Math.min(cw / iw, ch / ih))
  }, [imageDimensions, containerRef])

  const getBounds = useCallback((scale: number) => {
    if (!containerRef.current || !imageDimensions) {
      return { minX: 0, maxX: 0, minY: 0, maxY: 0 }
    }
    const container = containerRef.current
    const cw = container.clientWidth
    const ch = container.clientHeight
    const iw = imageDimensions.width
    const ih = imageDimensions.height

    const scaleToFit = Math.min(1, Math.min(cw / iw, ch / ih))
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

    // Anchor measured from the container's CENTRE, because the image is
    // centred and transformed with transform-origin: center. Measuring from
    // the top-left (as this did) offsets every zoom by half the viewport, so
    // the detail under the pointer slid away as you zoomed. The rect is read
    // live, so a narrowed container (Info panel open) is accounted for.
    const rect = containerRef.current.getBoundingClientRect()
    const anchorX = clientX - rect.left - rect.width / 2
    const anchorY = clientY - rect.top - rect.height / 2

    const ratio = nextScale / current.scale

    // Keep the image point under the anchor fixed:
    //   t' = a - (a - t) * ratio
    const nextTx = anchorX - (anchorX - current.translateX) * ratio
    const nextTy = anchorY - (anchorY - current.translateY) * ratio

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

  /**
   * Inertia after a drag. Runs ONLY while there is motion to spend.
   *
   * This used to reschedule itself unconditionally for the whole life of the
   * viewer, so an idle open photo still woke the renderer every frame forever.
   * It now stops when velocity dies and is restarted by the drag that creates
   * new velocity, which is also what stops rapid zoom gestures queueing frames
   * behind an already-running loop.
   */
  const startInertia = useCallback(() => {
    if (rafRef.current !== null) return
    lastTimeRef.current = 0
    const step = (time: number) => {
      if (isDraggingRef.current) {
        lastTimeRef.current = time
        rafRef.current = requestAnimationFrame(step)
        return
      }
      if (!lastTimeRef.current) lastTimeRef.current = time
      const elapsed = time - lastTimeRef.current
      lastTimeRef.current = time

      let vx = velocityRef.current.x
      let vy = velocityRef.current.y
      if (Math.abs(vx) < 0.05 && Math.abs(vy) < 0.05) {
        velocityRef.current = { x: 0, y: 0 }
        rafRef.current = null
        return
      }

      const friction = Math.pow(0.92, elapsed / 16)
      vx *= friction
      vy *= friction
      velocityRef.current = { x: vx, y: vy }
      panBy(vx * (elapsed / 16), vy * (elapsed / 16))
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
  }, [panBy])

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  /**
   * Re-clamp after the viewport changes (window resize, Info panel opening).
   * Scale is a multiplier over fit, so a fitted image stays fitted for free;
   * this only pulls a panned, zoomed image back inside the new bounds instead
   * of leaving it stranded outside them.
   */
  const clampToBounds = useCallback(() => {
    setState((prev) => {
      const clamped = clampTranslation(prev.scale, prev.translateX, prev.translateY)
      if (clamped.x === prev.translateX && clamped.y === prev.translateY) return prev
      return { ...prev, translateX: clamped.x, translateY: clamped.y }
    })
  }, [clampTranslation])

  return {
    scale: state.scale,
    translateX: state.translateX,
    translateY: state.translateY,
    zoomTo,
    panBy,
    reset,
    getFitScale,
    clampToBounds,
    startInertia,
    isDraggingRef,
    lastMousePosRef,
    velocityRef,
    lastTimeRef
  }
}
