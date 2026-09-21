/**
 * Capacity-bar colour ramp. Kept here as the single source of truth so it can
 * be tested directly; DriveSelectGrid imports nothing else from this file.
 */
const USAGE_COLOR_STOPS: [number, [number, number, number]][] = [
  [0, [34, 197, 94]],     // green
  [35, [74, 201, 78]],    // still green
  [50, [150, 205, 60]],   // yellow-green
  [65, [225, 205, 60]],   // yellow
  [80, [240, 150, 45]],   // orange
  [95, [225, 45, 45]],    // red
  [100, [214, 30, 40]]    // deep red
]

export function usageColor(pct: number): string {
  const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0))
  for (let i = 0; i < USAGE_COLOR_STOPS.length - 1; i++) {
    const [p0, c0] = USAGE_COLOR_STOPS[i]
    const [p1, c1] = USAGE_COLOR_STOPS[i + 1]
    if (p >= p0 && p <= p1) {
      const t = p1 === p0 ? 0 : (p - p0) / (p1 - p0)
      const ch = (a: number, b: number): number => Math.round(a + (b - a) * t)
      return `rgb(${ch(c0[0], c1[0])}, ${ch(c0[1], c1[1])}, ${ch(c0[2], c1[2])})`
    }
  }
  const last = USAGE_COLOR_STOPS[USAGE_COLOR_STOPS.length - 1][1]
  return `rgb(${last[0]}, ${last[1]}, ${last[2]})`
}

