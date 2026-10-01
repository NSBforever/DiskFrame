/**
 * Decisions the renderer makes while a drive is still being discovered.
 *
 * Lives here, free of React and Electron, so `node --test` can exercise it -
 * same arrangement as pageCache.ts. The behaviour these encode is what the
 * freeze fix turns on, so it is worth being able to test without a 2 TB drive.
 */

export interface LibraryGroupLike {
  key: string
  count: number
  /** Index of this group's first row in the overall ordering. */
  offset: number
}

/**
 * What to do with a batch of newly discovered files.
 *
 * A first scan commits rows continuously, and the renderer re-reads the group
 * summary to surface them. Doing that on every progress event would spend the
 * main process's time re-running the summary; doing it while the user is reading
 * would re-anchor the grid under them. So:
 *
 *  - 'skip'  : too soon since the last read.
 *  - 'park'  : the user has scrolled into results they are reading. Offer a
 *              refresh instead of moving the gallery.
 *  - 'apply' : nothing to disturb (still empty, or still at the top). Read now.
 */
export function progressiveUpdateAction(input: {
  nowMs: number
  lastReadMs: number
  intervalMs: number
  /** The grid has asked for something past the first page. */
  scrolled: boolean
  /** The summary already reports rows on screen. */
  hasRows: boolean
}): 'apply' | 'park' | 'skip' {
  const { nowMs, lastReadMs, intervalMs, scrolled, hasRows } = input
  if (nowMs - lastReadMs < intervalMs) return 'skip'
  if (scrolled && hasRows) return 'park'
  return 'apply'
}

/**
 * The row range covered by selecting a group header, honouring shift-range.
 *
 * Groups come from the library summary, which carries each group's offset and
 * count in the current ordering - so a whole group, or a contiguous run of
 * them, is one range read rather than anything held in the renderer.
 *
 * Returns null when the key is not in the summary (a header from a previous
 * query, after a drive or filter change).
 */
export function groupSelectionRange(
  groups: LibraryGroupLike[],
  key: string,
  anchorKey: string | null,
  shift: boolean
): { start: number; count: number } | null {
  const idx = groups.findIndex((g) => g.key === key)
  if (idx === -1) return null

  const anchorIdx = shift && anchorKey !== null ? groups.findIndex((g) => g.key === anchorKey) : -1
  const from = anchorIdx === -1 ? idx : Math.min(anchorIdx, idx)
  const to = anchorIdx === -1 ? idx : Math.max(anchorIdx, idx)

  let count = 0
  for (let i = from; i <= to; i++) count += groups[i].count
  return { start: groups[from].offset, count }
}
