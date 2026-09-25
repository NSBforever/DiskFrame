/**
 * Cell arithmetic for the gallery grid.
 *
 * Files with no visual preview share a cell four at a time, so a group of
 * files no longer maps one-to-one onto laid-out cells. Both sides of that
 * mapping live here, as pure functions, because the grid has to reserve exact
 * space for a group before any of its rows have been read - the whole point of
 * the virtualised layout is that it never needs the files to place them.
 *
 * Lives under src/main so the main-process test runner can cover it; the
 * renderer imports it directly, as it already does for the page cache.
 */

/** How many previewless files share one cell. */
export const COMPACT_PER_CELL = 4

export interface CellGroup {
  /** Total files in the group. */
  count: number
  /** How many of them are previewless. Clamped to `count`. */
  compactCount: number
}

/** Files in the group that keep a full tile to themselves. */
export function mediaCountOf(g: CellGroup): number {
  const compact = Math.max(0, Math.min(Math.floor(g.compactCount) || 0, g.count))
  return g.count - compact
}

/** Laid-out cells for a group: one per previewable file, one per four others. */
export function cellCountOf(g: CellGroup): number {
  const media = mediaCountOf(g)
  const compact = g.count - media
  return media + Math.ceil(compact / COMPACT_PER_CELL)
}

/**
 * The rows one cell stands for, as an offset into the group.
 *
 * Relies on the page query returning each group's previewable files first and
 * its compact ones after: cell N is then a fixed range that can be computed
 * without reading a single row.
 */
export function cellSpan(g: CellGroup, cell: number): { start: number; count: number } {
  const media = mediaCountOf(g)
  if (cell < media) return { start: cell, count: 1 }
  const k = cell - media
  const start = media + k * COMPACT_PER_CELL
  const remaining = g.count - start
  return { start, count: Math.max(0, Math.min(COMPACT_PER_CELL, remaining)) }
}
