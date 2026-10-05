/**
 * Rectangles for the viewer's open/close transition. Pure, so the geometry is
 * tested with `node --test` (like usageColor.ts) and the renderer imports it.
 */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** The whole of a `w`x`h` picture, centred in `frame`, never enlarged past its
 *  natural size - exactly how the viewer lays out an <img> with max-width and
 *  max-height of 100%. */
export function containFit(size: { width: number; height: number }, frame: Box, allowUpscale = false): Box {
  if (!size.width || !size.height || frame.w <= 0 || frame.h <= 0) return { ...frame }
  let k = Math.min(frame.w / size.width, frame.h / size.height)
  if (!allowUpscale) k = Math.min(1, k)
  const w = size.width * k
  const h = size.height * k
  return { x: frame.x + (frame.w - w) / 2, y: frame.y + (frame.h - h) / 2, w, h }
}

/** Fraction of `b` that lies inside `view`, 0..1. */
export function visibleFraction(b: Box, view: Box): number {
  if (b.w <= 0 || b.h <= 0) return 0
  const ix = Math.max(0, Math.min(b.x + b.w, view.x + view.w) - Math.max(b.x, view.x))
  const iy = Math.max(0, Math.min(b.y + b.h, view.y + view.h) - Math.max(b.y, view.y))
  return (ix * iy) / (b.w * b.h)
}

/** Where the tile flies to before the media's real size is known: a centred
 *  square, the same shape as the thumbnail it is showing. */
export function provisionalBox(frame: Box): Box {
  const s = Math.min(frame.w, frame.h) * 0.8
  return { x: frame.x + (frame.w - s) / 2, y: frame.y + (frame.h - s) / 2, w: s, h: s }
}

/** Whether two rectangles differ by more than a pixel anywhere. */
export function boxesDiffer(a: Box, b: Box): boolean {
  return Math.abs(a.x - b.x) > 1 || Math.abs(a.y - b.y) > 1 || Math.abs(a.w - b.w) > 1 || Math.abs(a.h - b.h) > 1
}
