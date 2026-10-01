/**
 * Verifies the two tiers in the running app, through the real sharp/ffmpeg path.
 *
 * Takes files the catalogue already knows about, clears their thumbnails so
 * they must genuinely be generated, then asks for them as one request with a
 * small visible set and a much larger prefetch band. Every visible file must
 * get its thumbnail before any band file does, and the band must then be
 * worked through rather than abandoned.
 *
 * This is the ordering that decides whether a tile the user is looking at waits
 * behind thousands of offscreen files, which is the complaint the two tiers
 * exist to answer.
 */
;(async () => {
  const drive = window.__fixtureDrive || 'C:'
  const q = { drive, nav: 'all', search: '', groupBy: 'day', order: 'default' }

  const summary = await window.api.librarySummary(q)
  if (summary.total < 60) {
    return JSON.stringify({ skipped: `only ${summary.total} files indexed; need 60+` }, null, 2)
  }

  // Rows from opposite ends of the ordering, so "visible" and "band" are
  // genuinely different files.
  const head = await window.api.libraryPage(q, 0, 20)
  const tail = await window.api.libraryPage(q, Math.max(0, summary.total - 60), 60)

  const visible = head.rows.map((r) => r.path).slice(0, 12)
  const band = tail.rows.map((r) => r.path).filter((p) => !visible.includes(p)).slice(0, 48)
  if (visible.length < 6 || band.length < 12) {
    return JSON.stringify({ skipped: 'not enough distinct rows', visible: visible.length, band: band.length }, null, 2)
  }

  // The caller empties the isolated thumbs/ directory first, so these are
  // generated for real (generateThumbForFile returns an existing thumb file
  // as-is, which would make the timings meaningless).

  const order = []
  const want = new Set([...visible, ...band])
  const off = window.api.onThumbReady((d) => {
    if (!want.has(d.filePath)) return
    want.delete(d.filePath)
    order.push({ path: d.filePath, tier: visible.includes(d.filePath) ? 'visible' : 'prefetch', at: Math.round(performance.now()) })
  })

  const t0 = performance.now()
  await window.api.prioritizeThumbnails({ visible, prefetch: band })

  // Wait until every visible file has landed, plus a grace period to see how
  // far into the band it got.
  const deadline = performance.now() + 90000
  while (performance.now() < deadline) {
    const visibleDone = order.filter((o) => o.tier === 'visible').length
    if (visibleDone >= visible.length && order.length > visible.length) break
    await new Promise((r) => setTimeout(r, 200))
  }
  off()

  const firstPrefetchIdx = order.findIndex((o) => o.tier === 'prefetch')
  const lastVisibleIdx = order.map((o) => o.tier).lastIndexOf('visible')
  const visibleDone = order.filter((o) => o.tier === 'visible').length
  const prefetchDone = order.filter((o) => o.tier === 'prefetch').length
  const visibleTimes = order.filter((o) => o.tier === 'visible').map((o) => o.at - Math.round(t0))

  return JSON.stringify(
    {
      requested: { visible: visible.length, prefetch: band.length },
      completed: { visible: visibleDone, prefetch: prefetchDone },
      // The assertion: no band file completes before the last visible one.
      // -1 for firstPrefetchIdx means the band had not started at all yet.
      everyVisibleBeforeAnyPrefetch: firstPrefetchIdx === -1 || firstPrefetchIdx > lastVisibleIdx,
      firstPrefetchIdx,
      lastVisibleIdx,
      lastVisibleThumbMs: visibleTimes.length ? Math.max(...visibleTimes) : null,
      // The band being worked through at all is the other half of the point:
      // scrolling into it should find pictures, not placeholders.
      prefetchProgressed: prefetchDone > 0,
      order: order.slice(0, 24)
    },
    null,
    2
  )
})()
