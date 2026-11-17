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

/** A CSS cubic-bezier(x1, y1, x2, y2) as a function of time, 0..1. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const at = (a: number, b: number, s: number): number => 3 * a * s * (1 - s) * (1 - s) + 3 * b * s * s * (1 - s) + s * s * s
  return (t) => {
    if (t <= 0) return 0
    if (t >= 1) return 1
    // x(s) is monotonic for valid control points, so bisection always converges.
    let lo = 0
    let hi = 1
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (at(x1, x2, mid) < t) lo = mid
      else hi = mid
    }
    return at(y1, y2, (lo + hi) / 2)
  }
}

export interface FlightFrame {
  /** Where the visible picture is at this step. */
  box: Box
  /** transform of the clipping element, laid out at `rest`, origin 0 0. */
  outer: string
  /** transform of the picture inside it, origin 0 0. */
  inner: string
}

/**
 * One step of the viewer's flight, as two transforms.
 *
 * The flight element is laid out once, at `rest` (the picture's rectangle in
 * the viewer), and never changes size: the clipping element is moved and
 * scaled to `box`, and the picture inside is counter-scaled so it stays
 * undistorted and covers `box`, centred - which at a square tile is exactly
 * the tile's own crop, and at `rest` is the whole picture. Nothing here
 * touches layout, so the browser can run it without the main thread.
 */
export function flightFrame(box: Box, rest: Box): FlightFrame {
  const sx = box.w / rest.w
  const sy = box.h / rest.h
  const cover = Math.max(sx, sy)
  // The covering picture's offset inside `box`, in the clip's own (unscaled) units.
  const ox = (box.w - rest.w * cover) / 2 / sx
  const oy = (box.h - rest.h * cover) / 2 / sy
  const n = (v: number): string => (Math.abs(v) < 1e-6 ? '0' : v.toFixed(5))
  return {
    box,
    outer: `translate(${n(box.x - rest.x)}px, ${n(box.y - rest.y)}px) scale(${n(sx)}, ${n(sy)})`,
    inner: `translate(${n(ox)}px, ${n(oy)}px) scale(${n(cover / sx)}, ${n(cover / sy)})`
  }
}

/**
 * The flight from `from` to `to` as evenly spaced steps with the easing baked
 * in. The counter-scale is not linear in time, so the steps are sampled rather
 * than left to the browser to interpolate between two ends; played with linear
 * easing between steps they follow the eased rectangle to well under a pixel.
 */
export function flightFrames(from: Box, to: Box, rest: Box, ease: (t: number) => number, steps = 30): FlightFrame[] {
  const out: FlightFrame[] = []
  for (let i = 0; i <= steps; i++) {
    const e = ease(i / steps)
    const mix = (a: number, b: number): number => a + (b - a) * e
    out.push(flightFrame({ x: mix(from.x, to.x), y: mix(from.y, to.y), w: mix(from.w, to.w), h: mix(from.h, to.h) }, rest))
  }
  return out
}

/** Whether two rectangles differ by more than a pixel anywhere. */
export function boxesDiffer(a: Box, b: Box): boolean {
  return Math.abs(a.x - b.x) > 1 || Math.abs(a.y - b.y) > 1 || Math.abs(a.w - b.w) > 1 || Math.abs(a.h - b.h) > 1
}
