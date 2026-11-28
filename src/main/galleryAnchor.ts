/**
 * Keeping the user's place when the gallery is rearranged (grouping, view
 * order or sort).
 *
 * Before the change the grid records what is at the top of the viewport: the
 * file, its date, and how far below the top edge its tile sits. The library
 * worker answers "where is that file now?" in the same read that produces the
 * new summary, so the new layout and the place to show arrive together and
 * can be applied before the first paint. When the file is not in the new
 * result (or was never read - a skeleton tile), the group nearest its date
 * stands in.
 *
 * Pure, and under src/main so the main-process test runner covers it; the
 * renderer imports it directly, as it does compactCells and pageCache.
 */

export interface GalleryAnchor {
  /** The file at the top-left of the viewport, when its row was resident. */
  path: string | null
  volumeId: string | null
  /** Its date (UTC ISO), or the date of the group it sat in. */
  date: string | null
  /** Pixels from the top of the viewport to the top of that tile (may be negative). */
  offsetPx: number
  /**
   * 'file' brings the same file back to the same height: a regrouping or a
   * reversed view order. 'group' shows the top of the group the file is now
   * in: a new sort reorders that group, so its first files are the point.
   */
  mode: 'file' | 'group'
}

export interface AnchorGroup {
  count: number
  offset: number
  minDate: string | null
  maxDate: string | null
}

/** Group holding absolute row `row`, by offset (groups are laid out in order). */
export function groupIndexOfRow(groups: readonly AnchorGroup[], row: number): number {
  let lo = 0
  let hi = groups.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (groups[mid].offset <= row) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

const time = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN)

/** The group whose date range holds `date`, else the one whose range ends nearest to it. */
export function nearestGroupByDate(groups: readonly AnchorGroup[], date: string | null): number {
  const t = time(date)
  if (!Number.isFinite(t)) return -1
  let best = -1
  let bestGap = Infinity
  for (let i = 0; i < groups.length; i++) {
    const lo = time(groups[i].minDate)
    const hi = time(groups[i].maxDate)
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue
    const gap = t < lo ? lo - t : t > hi ? t - hi : 0
    if (gap < bestGap) {
      best = i
      bestGap = gap
      if (gap === 0) break
    }
  }
  return best
}

/**
 * The row to bring into view in the new arrangement, and the group it is in.
 * `foundIndex` is the worker's answer for the anchor file (-1 or null when it
 * is not in the result). Null when there is nothing to anchor to.
 */
export function resolveAnchorRow(
  groups: readonly AnchorGroup[],
  anchor: Pick<GalleryAnchor, 'date' | 'mode'>,
  foundIndex: number | null
): { row: number; groupIndex: number; exact: boolean } | null {
  if (groups.length === 0) return null
  const last = groups[groups.length - 1]
  const total = last.offset + last.count
  if (foundIndex !== null && foundIndex >= 0 && foundIndex < total) {
    const gi = groupIndexOfRow(groups, foundIndex)
    if (gi >= 0) return { row: anchor.mode === 'group' ? groups[gi].offset : foundIndex, groupIndex: gi, exact: anchor.mode === 'file' }
  }
  const gi = nearestGroupByDate(groups, anchor.date)
  if (gi < 0) return null
  return { row: groups[gi].offset, groupIndex: gi, exact: false }
}

/**
 * The anchor as received over IPC: bounded strings or nothing. It only ever
 * selects which existing row to look up, but it crosses a trust boundary.
 */
export function normalizeAnchor(raw: unknown): { path: string; volumeId: string | null } | null {
  const a = raw as { path?: unknown; volumeId?: unknown } | null | undefined
  if (!a || typeof a !== 'object' || typeof a.path !== 'string' || !a.path || a.path.length > 4096) return null
  const v = a.volumeId
  if (v !== null && v !== undefined && (typeof v !== 'string' || v.length > 512)) return null
  return { path: a.path, volumeId: typeof v === 'string' ? v : null }
}
