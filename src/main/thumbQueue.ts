/**
 * Ordering for on-demand thumbnail work.
 *
 * Two tiers, because they answer different questions:
 *
 *   visible   tiles on screen (plus the small mount overscan). The user is
 *             looking at these right now and a placeholder here is the whole
 *             complaint.
 *   prefetch  a wider band above and below - files that are not mounted, so
 *             they cost no renderer image memory, but whose thumbnails will be
 *             wanted the moment the user scrolls.
 *
 * The tiers must not be one list. Appending a prefetch band to the same queue
 * that feeds visible work means the next scroll's prefetch request lands in
 * front of the current screen's un-generated tiles, which is exactly the
 * "slow formats never finish" failure the single queue already had once.
 *
 * Pure and dependency-free so `node --test` can exercise the ordering without
 * spawning sharp or ffmpeg.
 */

export interface ThumbQueueState {
  visible: string[]
  prefetch: string[]
}

export const EMPTY_QUEUE: ThumbQueueState = { visible: [], prefetch: [] }

/** Ceiling per tier. A caller asking for more than this is not describing
 *  anything a person is about to look at. */
export const MAX_VISIBLE = 300
export const MAX_PREFETCH = 900

/**
 * Folds a new request into the existing queue.
 *
 * - The new visible set goes to the front of the visible tier. Whatever was
 *   visible before and is still owed stays behind it rather than being dropped:
 *   the grid only re-requests when the visible set *changes*, so anything
 *   discarded here would never be asked for again.
 * - The prefetch tier is REPLACED. It describes where the user is heading, and
 *   a stale band is not worth generating. Anything in it that is also in the
 *   new visible set is promoted rather than duplicated.
 * - `exclude` drops paths already in flight or known to be unproducible.
 */
export function mergeThumbRequest(
  current: ThumbQueueState,
  request: { visible: string[]; prefetch: string[] },
  exclude: (path: string) => boolean
): ThumbQueueState {
  const seen = new Set<string>()
  const take = (paths: string[], limit: number, out: string[]): void => {
    for (const p of paths) {
      if (out.length >= limit) return
      if (seen.has(p) || exclude(p)) continue
      seen.add(p)
      out.push(p)
    }
  }

  const visible: string[] = []
  take(request.visible, MAX_VISIBLE, visible)
  // Still-owed work from a previous screen, kept behind the current one.
  take(current.visible, MAX_VISIBLE, visible)

  const prefetch: string[] = []
  take(request.prefetch, MAX_PREFETCH, prefetch)

  return { visible, prefetch }
}

/** The next path to generate, visible tier first. Mutates in place - this is a
 *  work queue, and the pump's workers share it. */
export function nextThumb(q: ThumbQueueState): string | undefined {
  return q.visible.shift() ?? q.prefetch.shift()
}

/** Total work outstanding. The drive-wide backfill stands aside while this is
 *  non-zero, so that both tiers beat it - a prefetch band is still about where
 *  this user is looking, which the backfill is not. */
export function queuedCount(q: ThumbQueueState): number {
  return q.visible.length + q.prefetch.length
}
