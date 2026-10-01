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

/**
 * Keeps every resident page from the same snapshot of the catalogue.
 *
 * Pages are read with LIMIT/OFFSET, so they are only consistent with each other
 * while the catalogue is not changing. Discovery commits every 500 files, which
 * means the renderer can hold page N read before a commit and page N+1 read
 * after it - and a file that moved across that boundary is then resident at two
 * indices and drawn twice. (src/main/paginationIntegrity.test.ts demonstrates
 * the drift directly: insert one newer row between two page reads and the second
 * page repeats a row from the first.)
 *
 * Every page response carries the catalogue version it was read at. When a page
 * arrives from a different version than the pages already held, those are from a
 * different snapshot: they are dropped, so the resident set is always
 * self-consistent and can never contain the same file twice. The grid re-asks
 * for what it needs, which is only ever a few pages.
 *
 * Returns the version the cache now holds.
 */
export function reconcileCacheVersion<T>(
  pages: Map<number, T>,
  held: string | null,
  incoming: string
): string {
  if (held !== null && held !== incoming) pages.clear()
  return incoming
}
