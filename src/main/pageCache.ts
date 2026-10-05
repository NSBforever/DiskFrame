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
export interface GroupShape {
  key: string
  count: number
  compactCount: number
  offset: number
}

/**
 * Takes rows out of the resident pages at once, and moves everything after
 * them up, the way the next query will.
 *
 * Trashing a file used to change nothing in the renderer itself: the tile
 * shrank for 350ms, sprang back to full size, and only disappeared once a
 * whole-drive re-read had round-tripped through the main process - which on a
 * real library, with the renderer busy, took over a second and sometimes did
 * not visibly happen at all. This makes the removal the renderer's own
 * immediate fact; the re-read that follows only confirms it.
 *
 * Group counts and offsets are adjusted for the removed rows that are resident
 * (the only ones whose position is known), and a group left empty is dropped.
 * Rows of a removed path that is not resident are simply not here to remove;
 * the follow-up re-read accounts for them.
 */
export function removeResidentRows<R extends { path: string; ext: string }, G extends GroupShape>(
  pages: Map<number, R[]>,
  pageSize: number,
  groups: G[],
  paths: Set<string>,
  isCompact: (ext: string) => boolean
): { pages: Map<number, R[]>; groups: G[]; removed: number } {
  const removedAt: number[] = []
  const removedRows: R[] = []
  for (const [p, rows] of pages) {
    rows.forEach((r, i) => {
      if (r && paths.has(r.path)) {
        removedAt.push(p * pageSize + i)
        removedRows.push(r)
      }
    })
  }
  if (removedAt.length === 0) return { pages, groups, removed: 0 }
  const order = removedAt.map((_, i) => i).sort((a, b) => removedAt[a] - removedAt[b])
  const sorted = order.map((i) => removedAt[i])
  // How many removed indices lie strictly before an index.
  const before = (index: number): number => {
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sorted[mid] < index) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  const nextGroups = groups.map((g) => ({ ...g }))
  for (const i of order) {
    const at = removedAt[i]
    const g = nextGroups.find((x) => at >= x.offset && at < x.offset + x.count)
    if (!g) continue
    g.count -= 1
    if (isCompact(removedRows[i].ext)) g.compactCount = Math.max(0, g.compactCount - 1)
  }
  // Offsets are recomputed from the original ones, so they stay exact even
  // for groups that had no resident rows at all.
  for (const g of nextGroups) g.offset -= before(g.offset)

  const nextPages = new Map<number, R[]>()
  for (const [p, rows] of pages) {
    rows.forEach((r, i) => {
      if (!r || paths.has(r.path)) return
      const old = p * pageSize + i
      const idx = old - before(old)
      const np = Math.floor(idx / pageSize)
      let page = nextPages.get(np)
      if (!page) nextPages.set(np, (page = []))
      page[idx - np * pageSize] = r
    })
  }
  return { pages: nextPages, groups: nextGroups.filter((g) => g.count > 0), removed: removedAt.length }
}

export function reconcileCacheVersion<T>(
  pages: Map<number, T>,
  held: string | null,
  incoming: string
): string {
  if (held !== null && held !== incoming) pages.clear()
  return incoming
}
