/**
 * Thumbnail performance in the running app, against an ISOLATED catalogue and
 * thumbnail cache on a disposable fixture. Touches no real drive and no real
 * cache.
 *
 * Measures, separately:
 *   cold      first generation of a bounded set
 *   warm      the same set with the thumbnails already on disk
 *   scroll    slow, fast, and an immediate direction reversal
 *   jump      a distant timeline jump, then a return to the earlier rows
 *   failures  reported apart from successes
 */
;(async () => {
  const drive = 'C:'
  const q = (o = {}) => ({ drive, nav: 'all', search: '', groupBy: 'day', order: 'default', ...o })
  const out = {}
  const now = () => performance.now()

  // Opening the drive is what primes the volume identity the summary is keyed
  // by; without it the summary honestly returns nothing. It also schedules the
  // drive-wide backfill a few seconds later, which is realistic - that pass is
  // supposed to yield to viewport work, and these timings include it doing so.
  await new Promise((r) => {
    const off = window.api.onDriveOpened((x) => { if (x.drive !== drive) return; off(); r(x) })
    window.api.openDrive(drive)
    setTimeout(r, 30000)
  })

  const summary = await window.api.librarySummary(q())
  out.catalogue = { total: summary.total, groups: summary.groups.length }
  if (summary.total < 40) return JSON.stringify({ error: 'fixture too small', ...out }, null, 2)

  const page = await window.api.libraryPage(q(), 0, Math.min(summary.total, 300))
  const rows = page.rows
  const videos = rows.filter((r) => /\.(mp4|mov)$/i.test(r.path))
  const photos = rows.filter((r) => /\.(jpg|jpeg|png|webp)$/i.test(r.path))
  out.sample = { rows: rows.length, videos: videos.length, photos: photos.length }

  /** Asks for a set and waits until every path has answered, timing each arrival. */
  async function fill(paths, label) {
    const pending = new Set(paths)
    const arrivals = []
    const t0 = now()
    let firstAt = null
    const off = window.api.onThumbReady((d) => {
      if (!pending.has(d.filePath)) return
      pending.delete(d.filePath)
      const at = now() - t0
      if (firstAt === null) firstAt = at
      arrivals.push({ at, failed: d.thumbPath && d.thumbPath.startsWith('!') })
    })
    await window.api.prioritizeThumbnails({ visible: paths, prefetch: [] })
    const deadline = now() + 180000
    while (pending.size > 0 && now() < deadline) await new Promise((r) => setTimeout(r, 50))
    off()
    const ok = arrivals.filter((a) => !a.failed)
    const bad = arrivals.filter((a) => a.failed)
    const times = ok.map((a) => a.at).sort((x, y) => x - y)
    return {
      label,
      requested: paths.length,
      answered: arrivals.length,
      succeeded: ok.length,
      failed: bad.length,
      unanswered: pending.size,
      firstThumbMs: firstAt === null ? null : Math.round(firstAt),
      p50Ms: times.length ? Math.round(times[Math.floor(times.length / 2)]) : null,
      viewportFilledMs: times.length ? Math.round(times[times.length - 1]) : null,
      meanPerFileMs: times.length ? Math.round(times[times.length - 1] / times.length) : null
    }
  }

  // ── cold: a bounded viewport-sized set, nothing cached ──
  const viewport = rows.slice(0, 30).map((r) => r.path)
  out.coldViewport = await fill(viewport, 'cold 30 tiles')
  // ── warm: identical request, now cached on disk ──
  out.warmViewport = await fill(viewport, 'warm 30 tiles (same set)')
  // ── cold video only, the reported symptom ──
  const vidSet = videos.slice(0, 12).map((r) => r.path)
  if (vidSet.length) out.coldVideoOnly = await fill(vidSet, 'cold video only')

  // ── scrolling patterns: successive viewports, measuring responsiveness ──
  async function scrollPattern(label, offsets) {
    const probes = []
    const t0 = now()
    for (const off of offsets) {
      const slice = rows.slice(off, off + 30).map((r) => r.path)
      if (!slice.length) continue
      const tp = now()
      await window.api.prioritizeThumbnails({ visible: slice, prefetch: [] })
      probes.push(now() - tp)
      await new Promise((r) => setTimeout(r, 120))
    }
    return {
      label,
      viewports: probes.length,
      requestAckMeanMs: probes.length ? Math.round(probes.reduce((a, b) => a + b, 0) / probes.length) : null,
      requestAckWorstMs: probes.length ? Math.round(Math.max(...probes)) : null,
      totalMs: Math.round(now() - t0)
    }
  }
  out.slowScroll = await scrollPattern('slow scroll', [0, 15, 30, 45, 60])
  out.fastScroll = await scrollPattern('fast scroll', [0, 60, 120, 180, 240])
  out.reversal = await scrollPattern('immediate reversal', [120, 150, 120, 90, 120])
  out.distantJump = await scrollPattern('distant jump then return', [0, 260, 0])

  return JSON.stringify(out, null, 2)
})()
