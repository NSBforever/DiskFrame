/**
 * What the user actually waits for when opening and browsing the large
 * external SSD, measured from inside the running app against the REAL
 * catalogue. Read-only: openDrive reads the cached index and never scans.
 *
 * The three numbers that matter are measured separately because they have
 * different causes:
 *
 *   ipcLatency   round-trip to a trivial main-process handler, sampled every
 *                80ms throughout. This IS main-process availability - Windows
 *                paints "Not Responding" when the window stops pumping
 *                messages, so a 3s round trip here is a 3s freeze whatever the
 *                query times say.
 *   longTasks    renderer main-thread blocks >50ms, from PerformanceObserver.
 *                A frozen interface can be the renderer's fault alone.
 *   phases       identity -> summary -> first page -> scrolled viewports.
 *
 * window.__probeDrive picks the drive.
 */
;(async () => {
  const drive = window.__probeDrive || 'D:'
  const q = (o = {}) => ({ drive, nav: 'all', search: '', groupBy: 'day', order: 'default', ...o })
  const now = () => performance.now()
  const out = { drive }

  // ── renderer long tasks, for the whole run ──
  const longTasks = []
  let po = null
  try {
    po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) longTasks.push({ at: Math.round(e.startTime), ms: Math.round(e.duration) })
    })
    po.observe({ entryTypes: ['longtask'] })
  } catch {
    /* no longtask support */
  }

  // ── continuous main-process availability sampling ──
  const lat = []
  let sampling = true
  const sampler = (async () => {
    while (sampling) {
      const t = now()
      try {
        await window.api.getTileSize()
      } catch {
        /* a failed probe still took what it took */
      }
      lat.push({ at: Math.round(t), ms: now() - t })
      await new Promise((r) => setTimeout(r, 80))
    }
  })()
  const slice = (from, to) => lat.filter((s) => s.at >= from && s.at <= to).map((s) => s.ms)
  const pct = (a, p) => {
    if (!a.length) return null
    const s = [...a].sort((x, y) => x - y)
    return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))])
  }
  const stat = (a) => ({ n: a.length, p50: pct(a, 0.5), p95: pct(a, 0.95), worst: a.length ? Math.round(Math.max(...a)) : null })

  // ── phase 1: open the drive (cached index only) ──
  const t0 = now()
  const opened = await new Promise((r) => {
    const off = window.api.onDriveOpened((d) => {
      if (d.drive !== drive) return
      off()
      r({ ...d, at: now() })
    })
    window.api.openDrive(drive)
    setTimeout(() => { off(); r(null) }, 60000)
  })
  out.open = {
    identityMs: opened ? Math.round(opened.at - t0) : 'timeout',
    indexedRecords: opened ? opened.indexed : null,
    identityUnresolved: opened ? opened.identityUnresolved : null
  }

  // ── phase 2: the grid's shape ──
  let t = now()
  const summary = await window.api.librarySummary(q())
  out.summaryMs = Math.round(now() - t)
  out.summary = { total: summary.total, groups: summary.groups.length }

  // ── phase 3: first real entries on screen ──
  t = now()
  const page = await window.api.libraryPage(q(), 0, 200)
  out.firstPageMs = Math.round(now() - t)
  out.firstPageRows = page.rows.length
  out.timeToFirstEntriesMs = Math.round(now() - t0)
  const tAfterOpen = now()
  out.duringOpen = stat(slice(0, tAfterOpen))

  if (page.rows.length === 0) {
    sampling = false; await sampler; if (po) po.disconnect()
    out.longTasks = longTasks.length
    return JSON.stringify(out, null, 2)
  }

  // ── phase 4: the first 3 seconds after opening, when the drive-wide
  //    thumbnail backfill is scheduled to start ──
  const tBackfillWindow = now()
  await new Promise((r) => setTimeout(r, 6000))
  out.afterBackfillStarts = stat(slice(tBackfillWindow, now()))

  // ── phase 5: scrolling. Ask for successive viewports the way the grid does. ──
  const all = []
  for (let off = 0; off < Math.min(summary.total, 1200); off += 200) {
    const p = await window.api.libraryPage(q(), off, 200)
    all.push(...p.rows.map((r) => r.path))
    if (p.rows.length < 200) break
  }
  out.sampledRows = all.length

  const scroll = async (label, offsets) => {
    const tS = now()
    const acks = []
    for (const o of offsets) {
      const visible = all.slice(o, o + 40)
      const prefetch = all.slice(Math.max(0, o - 180), o).concat(all.slice(o + 40, o + 220))
      if (!visible.length) continue
      const tA = now()
      await window.api.prioritizeThumbnails({ visible, prefetch })
      acks.push(now() - tA)
      // page fetch for the new window, as the grid does
      const tP = now()
      await window.api.libraryPage(q(), o, 200)
      acks.push(now() - tP)
      await new Promise((r) => setTimeout(r, 150))
    }
    return { label, requests: acks.length, ackP50: pct(acks, 0.5), ackWorst: acks.length ? Math.round(Math.max(...acks)) : null, ipc: stat(slice(tS, now())), totalMs: Math.round(now() - tS) }
  }
  out.slowScroll = await scroll('slow', [0, 40, 80, 120, 160])
  out.fastScroll = await scroll('fast', [0, 200, 400, 600, 800])
  out.reversal = await scroll('reverse', [400, 440, 400, 360, 400])

  // ── phase 6: switching away and back, with work still running ──
  const tSwitch = now()
  window.api.openDrive('C:')
  await window.api.librarySummary(q({ drive: 'C:' }))
  await window.api.libraryPage(q({ drive: 'C:' }), 0, 200)
  window.api.openDrive(drive)
  await window.api.librarySummary(q())
  out.switchDrivesMs = Math.round(now() - tSwitch)
  out.duringSwitch = stat(slice(tSwitch, now()))

  sampling = false
  await sampler
  if (po) po.disconnect()

  out.ipcOverall = stat(lat.map((s) => s.ms))
  out.neverNearNotResponding = out.ipcOverall.worst !== null && out.ipcOverall.worst < 5000
  longTasks.sort((a, b) => b.ms - a.ms)
  out.longTasks = { count: longTasks.length, totalBlockedMs: longTasks.reduce((s, x) => s + x.ms, 0), worst: longTasks.slice(0, 8) }
  out.memory = performance.memory ? { usedMB: Math.round(performance.memory.usedJSHeapSize / 1048576), limitMB: Math.round(performance.memory.jsHeapSizeLimit / 1048576) } : null
  return JSON.stringify(out, null, 2)
})()
