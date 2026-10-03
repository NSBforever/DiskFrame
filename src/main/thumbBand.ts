/**
 * The order a prefetch band is worked through.
 *
 * The band is 30 tile rows above and 30 below the mounted range. Those 60 rows
 * are not equal: the row just off the bottom edge is about to be on screen, and
 * the row 30 up is only a guess. Handing them over in index order means a
 * downward scroll waits while thumbnails are generated for rows behind it.
 *
 * So candidates are ranked by how far they are from the viewport, with the
 * direction of travel given a discount - near rows first, and ahead before
 * behind at the same distance. Neither direction is ever excluded: a reversal
 * must not have to wait for a queue to drain, which is why the trailing side is
 * discounted rather than dropped.
 *
 * This decides order only. What is actually visible is a separate, higher tier
 * (see thumbQueue.ts) and nothing here can delay it.
 *
 * Pure, so `node --test` can check the ordering without a grid.
 */

export type ScrollDirection = 'down' | 'up' | 'none'

export interface BandCandidate {
  /** Global row index in the current library ordering. */
  index: number
  path: string
}

/**
 * How much nearer a candidate in the direction of travel is treated as being.
 * 0.5 means the leading side is preferred up to twice the distance of the
 * trailing side - a clear bias without ever starving the other direction.
 */
export const DIRECTION_DISCOUNT = 0.5

/**
 * Candidates ordered best-first.
 *
 * `first`/`last` are the mounted (visible) index range. Candidates inside it are
 * dropped: those belong to the visible tier, and queueing them here as well
 * would be the duplicate request the band exists to avoid.
 */
export function orderBand(
  candidates: BandCandidate[],
  first: number,
  last: number,
  direction: ScrollDirection
): string[] {
  const scored: { path: string; score: number; index: number }[] = []
  for (const c of candidates) {
    if (c.index >= first && c.index <= last) continue
    const ahead = c.index > last
    const distance = ahead ? c.index - last : first - c.index
    const leading =
      (direction === 'down' && ahead) || (direction === 'up' && !ahead)
    scored.push({
      path: c.path,
      index: c.index,
      score: distance * (leading ? DIRECTION_DISCOUNT : 1)
    })
  }
  // Index breaks ties so the order is total and does not wobble between
  // recalculations - an unstable order means re-requesting the same work in a
  // different sequence on every scroll event.
  scored.sort((a, b) => a.score - b.score || a.index - b.index)
  return scored.map((s) => s.path)
}
