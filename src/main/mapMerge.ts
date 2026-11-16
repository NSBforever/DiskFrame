/**
 * Merging map places whose pins would overlap on screen.
 *
 * Places are SQL grid cells (see mapClustersSql), and each pin sits at the
 * average position of its cell's files. Two neighbouring cells can therefore
 * put their pins a few pixels apart - in the owner's library the 682-file
 * place was half hidden under an 18-file one. Cells cannot know about screen
 * pixels; the map can, so it merges here after every fetch.
 */

export interface PlaceLike {
  count: number
  lat: number
  lng: number
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
}

/**
 * Greedy merge, largest place first: a place whose pin box would overlap an
 * already-kept pin is folded into it (counts add, extents combine, position
 * becomes the count-weighted average). Repeats until nothing moves, because a
 * merged pin's new position can reach a third one. The kept place's other
 * fields (its thumbnail) win, so the biggest place keeps its picture.
 */
export function mergeOverlapping<T extends PlaceLike>(
  places: readonly T[],
  toPoint: (lat: number, lng: number) => { x: number; y: number },
  pin: { w: number; h: number }
): T[] {
  let kept: T[] = [...places].sort((a, b) => b.count - a.count).map((p) => ({ ...p }))
  for (let pass = 0; pass < places.length; pass++) {
    const next: T[] = []
    const pts: { x: number; y: number }[] = []
    let merged = false
    for (const p of kept) {
      const pt = toPoint(p.lat, p.lng)
      const at = pts.findIndex((q) => Math.abs(q.x - pt.x) < pin.w && Math.abs(q.y - pt.y) < pin.h)
      if (at < 0) {
        next.push(p)
        pts.push(pt)
        continue
      }
      const k = next[at]
      const n = k.count + p.count
      next[at] = {
        ...k,
        count: n,
        lat: (k.lat * k.count + p.lat * p.count) / n,
        lng: (k.lng * k.count + p.lng * p.count) / n,
        minLat: Math.min(k.minLat, p.minLat),
        maxLat: Math.max(k.maxLat, p.maxLat),
        minLng: Math.min(k.minLng, p.minLng),
        maxLng: Math.max(k.maxLng, p.maxLng)
      }
      pts[at] = toPoint(next[at].lat, next[at].lng)
      merged = true
    }
    kept = next
    if (!merged) break
  }
  return kept
}
