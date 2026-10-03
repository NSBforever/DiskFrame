/**
 * Where thumbnail latency actually goes.
 *
 * "Tiles stay as placeholders" has several very different causes - the request
 * sat in a queue, the decoder was slow, the file cannot be decoded at all, or it
 * was generated and never delivered - and they need opposite fixes. One number
 * for "thumbnail time" cannot tell them apart, so each stage is timed on its own:
 *
 *   wait     enqueued -> picked up by a generation slot. High means the queue is
 *            the bottleneck, not the decoder.
 *   lookup   resolving the path and checking availability before any work.
 *   cacheHit a thumbnail already existed on disk; no generation at all.
 *   generate ffmpeg/sharp actually producing the image.
 *   deliver  handing the result to the renderer.
 *
 * Successes and failures are kept apart: averaging a 130ms undecodable stub into
 * a 300ms real decode flatters both and explains neither.
 *
 * Pure accumulator - no timers, no I/O - so `node --test` can check the maths.
 */

export interface StageSample {
  waitMs: number
  lookupMs: number
  generateMs: number
  deliverMs: number
  cacheHit: boolean
  failed: boolean
  video: boolean
}

export interface StageTotals {
  count: number
  waitMs: number
  lookupMs: number
  generateMs: number
  deliverMs: number
}

const empty = (): StageTotals => ({ count: 0, waitMs: 0, lookupMs: 0, generateMs: 0, deliverMs: 0 })

export class ThumbStageStats {
  private ok = empty()
  private failed = empty()
  private cacheHits = empty()
  private videoOk = empty()
  /** Worst single wait seen, which is what a user actually notices. */
  private maxWaitMs = 0
  private maxGenerateMs = 0

  add(s: StageSample): void {
    const into = s.failed ? this.failed : s.cacheHit ? this.cacheHits : this.ok
    into.count++
    into.waitMs += s.waitMs
    into.lookupMs += s.lookupMs
    into.generateMs += s.generateMs
    into.deliverMs += s.deliverMs
    if (!s.failed && !s.cacheHit && s.video) {
      this.videoOk.count++
      this.videoOk.generateMs += s.generateMs
      this.videoOk.waitMs += s.waitMs
    }
    if (s.waitMs > this.maxWaitMs) this.maxWaitMs = s.waitMs
    if (s.generateMs > this.maxGenerateMs) this.maxGenerateMs = s.generateMs
  }

  get total(): number {
    return this.ok.count + this.failed.count + this.cacheHits.count
  }

  /** One line per category, or null when nothing has happened yet. */
  report(): string | null {
    if (this.total === 0) return null
    const mean = (t: StageTotals, k: keyof StageTotals): string =>
      t.count === 0 ? '-' : Math.round((t[k] as number) / t.count) + 'ms'
    const line = (label: string, t: StageTotals): string =>
      `${label}=${t.count}` +
      (t.count === 0
        ? ''
        : ` (wait ${mean(t, 'waitMs')}, lookup ${mean(t, 'lookupMs')}, gen ${mean(t, 'generateMs')}, deliver ${mean(t, 'deliverMs')})`)
    return [
      line('generated', this.ok),
      line('cached', this.cacheHits),
      line('failed', this.failed),
      this.videoOk.count > 0
        ? `video-gen=${this.videoOk.count} (gen ${mean(this.videoOk, 'generateMs')})`
        : 'video-gen=0',
      `worst wait ${Math.round(this.maxWaitMs)}ms, worst gen ${Math.round(this.maxGenerateMs)}ms`
    ].join(' | ')
  }

  reset(): void {
    this.ok = empty()
    this.failed = empty()
    this.cacheHits = empty()
    this.videoOk = empty()
    this.maxWaitMs = 0
    this.maxGenerateMs = 0
  }
}
