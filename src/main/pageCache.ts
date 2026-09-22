/**
 * Eviction policy for the renderer's bounded page cache.
 *
 * Lives here rather than beside the hook that uses it so it can be exercised
 * by `node --test` without pulling in React, matching usageColor.ts.
 */

/**
 * The resident page furthest outside [first, last], or undefined when every
 * resident page is inside that window and none should be dropped.
 *
 * Eviction used to be insertion-ordered on the assumption that the oldest page
 * is the one furthest from the user. It is not: a burst of scrolling requests
 * pages faster than they arrive, and the earliest arrivals are first to go -
 * including the page the user just landed on, which then had nothing left to
 * re-request it and stayed blank.
 */
export function pickEvictionVictim(
  resident: Iterable<number>,
  first: number,
  last: number
): number | undefined {
  let victim: number | undefined
  let worst = 0
  for (const page of resident) {
    const distance = page < first ? first - page : page > last ? page - last : 0
    if (distance > worst) {
      worst = distance
      victim = page
    }
  }
  return victim
}
