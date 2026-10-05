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
  /**
   * The rest of the open volume, worked through only when nothing on or near
   * the screen is owed (the pump also holds it back while the user is
   * scrolling). It used to be a separate backfill with its own two workers,
   * which put ten jobs on one external drive at once and queued its HEIC
   * decodes ahead of the tiles on screen.
   */
  background: string[]
}

export const EMPTY_QUEUE: ThumbQueueState = { visible: [], prefetch: [], background: [] }

/** Ceiling per tier. A caller asking for more than this is not describing
 *  anything a person is about to look at. */
export const MAX_VISIBLE = 300
export const MAX_PREFETCH = 900

/**
 * Folds a new request into the existing queue.
 *
 * A request that names a screen (non-empty visible) is where the user is now:
 *   1. its visible tiles,
 *   2. its prefetch band, nearest rows first,
 *   3. then whatever the previous screen still owed - kept rather than dropped,
 *      since the grid only re-requests when the visible set changes, but no
 *      longer ahead of the destination. After a fast scroll or a timeline jump
 *      the intermediate screens used to be generated before the band of the
 *      place the user actually stopped.
 * That leftover rides in the prefetch tier, so the next screen's request
 * replaces it: work two screens stale is dropped, not accumulated.
 *
 * A request with no visible paths says nothing about the screen, so the visible
 * tier is left as it is; only the band is replaced.
 *
 * `exclude` drops paths already in flight or known to be unproducible. The
 * background tier is untouched.
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

  const newScreen = request.visible.length > 0
  const visible: string[] = []
  take(request.visible, MAX_VISIBLE, visible)
  if (!newScreen) take(current.visible, MAX_VISIBLE, visible)

  const prefetch: string[] = []
  take(request.prefetch, MAX_PREFETCH, prefetch)
  if (newScreen) take(current.visible, MAX_PREFETCH, prefetch)

  return { visible, prefetch, background: current.background }
}

/**
 * The next path to generate, visible tier first.
 *
 * `accept` lets two worker pools drain this one queue by kind of work. Video
 * thumbnails are an ffmpeg subprocess; photo thumbnails run sharp inside this
 * process, on its libuv pool. They need different limits, but they must share
 * one priority order - two separate queues would let a prefetched photo be
 * generated ahead of a visible video.
 *
 * Mutates in place: this is a work queue and the pump's workers share it.
 */
export function nextThumb(
  q: ThumbQueueState,
  accept?: (path: string) => boolean,
  allowBackground = false,
  /** Only on-screen work: the caller is filling a slot held in reserve for it. */
  visibleOnly = false
): string | undefined {
  const tiers = visibleOnly ? [q.visible] : allowBackground ? [q.visible, q.prefetch, q.background] : [q.visible, q.prefetch]
  for (const tier of tiers) {
    const at = accept ? tier.findIndex(accept) : tier.length ? 0 : -1
    if (at !== -1) return tier.splice(at, 1)[0]
  }
  return undefined
}

/** Work outstanding on or near the screen. The background tier waits while
 *  this is non-zero - a prefetch band is still about where this user is
 *  looking, which the rest of the volume is not. */
export function queuedCount(q: ThumbQueueState): number {
  return q.visible.length + q.prefetch.length
}
