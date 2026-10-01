/**
 * First-use verification, against an ISOLATED catalogue and thumbnail cache.
 *
 * Runs inside the app (via scratch/cdp.js) that was launched with
 * --user-data-dir pointing at a disposable directory, so it is browsing a
 * genuinely empty library through the production code paths. It never touches
 * the real database or thumbnail cache, and it never scans a real drive.
 *
 * Checks, in order:
 *   1. no inheritance    - a fresh catalogue shows nothing for any connected
 *                          drive, and no favourites, trash or counts carried
 *                          over from the real library.
 *   2. responsiveness    - IPC round-trip latency sampled continuously while
 *                          discovery runs. This is the number that decides
 *                          whether the window says "Not Responding", so it is
 *                          measured, not inferred from query times.
 *   3. progressive       - real entries readable BEFORE discovery reports done.
 *   4. navigation        - paging and a filter change answered during discovery.
 *   5. cancellation      - stop works, and what was found is kept.
 *
 * window.__fixtureDrive / __fixtureVolumeExpected are set by the caller.
 */
;(async () => {
  const log = []
  const say = (step, data) => log.push({ step, ...data })
  const now = () => performance.now()

  // ── 1. No inheritance ──
  const drives = await new Promise((resolve) => {
    const off = window.api.onDrivesUpdated((d) => {
      off()
      resolve(d)
    })
    window.api.getDrives()
    setTimeout(() => {
      off()
      resolve([])
    }, 15000)
  })

  const perDrive = []
  for (const d of drives) {
    const letter = d.name.slice(0, 2).toUpperCase()
    const q = { drive: letter, nav: 'all', search: '', groupBy: 'day', order: 'default' }
    const s = await window.api.librarySummary(q)
    const favs = await window.api.favouritePaths()
    const trash = await window.api.getTrashCount(letter)
    perDrive.push({
      letter,
      summaryTotal: s.total,
      groups: s.groups.length,
      favourites: Array.isArray(favs) ? favs.length : favs,
      trash
    })
  }
  const counts = await window.api.getDriveFileCounts()
  say('no-inheritance', {
    perDrive,
    driveFileCounts: counts,
    // A fresh catalogue must show nothing at all. Anything non-zero here means
    // a new volume inherited another drive's data.
    clean:
      perDrive.every((p) => p.summaryTotal === 0 && p.groups === 0 && p.trash === 0 && p.favourites === 0) &&
      Object.values(counts).every((n) => n === 0)
  })

  // ── 2/3/4. Discovery: responsiveness, progressive results, navigation ──
  const drive = window.__fixtureDrive
  const q = { drive, nav: 'all', search: '', groupBy: 'day', order: 'default' }

  // Continuous IPC round-trip sampling. getTileSize is a trivial main-process
  // handler, so its latency is the main process's availability, not its work.
  const latencies = []
  let sampling = true
  const sampler = (async () => {
    while (sampling) {
      const t = now()
      try {
        await window.api.getTileSize()
      } catch {
        /* a failed probe still took whatever it took */
      }
      latencies.push(now() - t)
      await new Promise((r) => setTimeout(r, 100))
    }
  })()

  const progressSamples = []
  let completed = null
  const offProgress = window.api.onScanProgress((p) => {
    if (p.drive && p.drive !== drive) return
    progressSamples.push({ t: Math.round(now()), count: p.count })
  })
  const completePromise = new Promise((resolve) => {
    const off = window.api.onScanComplete((c) => {
      if (c.drive !== drive) return
      off()
      completed = { t: now(), count: c.count }
      resolve(c)
    })
    setTimeout(resolve, 120000)
  })

  const tScanStart = now()
  window.api.scanDrive(drive)

  // Poll the library while discovery runs: the first moment real entries are
  // readable is the number that matters for "first-time browsing".
  let firstEntriesAt = null
  let firstEntriesCount = 0
  const duringDiscovery = []
  const navDuringDiscovery = []
  for (let i = 0; i < 400; i++) {
    if (completed) break
    const s = await window.api.librarySummary(q)
    if (s.total > 0 && firstEntriesAt === null) {
      firstEntriesAt = now() - tScanStart
      firstEntriesCount = s.total
      // Navigation must work mid-discovery: ask for a page, and change filter.
      const tp = now()
      const page = await window.api.libraryPage(q, 0, 100)
      const tpage = now() - tp
      const tf = now()
      const photos = await window.api.librarySummary({ ...q, nav: 'photos' })
      const tfilter = now() - tf
      const tg = now()
      const months = await window.api.librarySummary({ ...q, groupBy: 'month' })
      const tgroup = now() - tg
      navDuringDiscovery.push({
        pageMs: Math.round(tpage),
        pageRows: page.rows.length,
        filterMs: Math.round(tfilter),
        photosTotal: photos.total,
        regroupMs: Math.round(tgroup),
        monthGroups: months.groups.length
      })
    }
    if (s.total > 0) duringDiscovery.push({ t: Math.round(now() - tScanStart), total: s.total })
    await new Promise((r) => setTimeout(r, 150))
  }

  await completePromise
  offProgress()
  sampling = false
  await sampler

  const finalSummary = await window.api.librarySummary(q)
  const sorted = [...latencies].sort((a, b) => a - b)
  const pct = (p) => (sorted.length ? Math.round(sorted[Math.floor((sorted.length - 1) * p)]) : null)

  say('discovery', {
    drive,
    scanCompleteMs: completed ? Math.round(completed.t - tScanStart) : 'timeout',
    scanCompleteCount: completed ? completed.count : null,
    firstEntriesMs: firstEntriesAt === null ? 'none before completion' : Math.round(firstEntriesAt),
    firstEntriesCount,
    // Proof the results were PROGRESSIVE: the library grew while discovery ran.
    growthWhileDiscovering: duringDiscovery.slice(0, 12),
    sawEntriesBeforeCompletion: firstEntriesAt !== null,
    finalTotal: finalSummary.total,
    finalGroups: finalSummary.groups.length,
    progressEvents: progressSamples.length
  })
  say('responsiveness-during-discovery', {
    ipcProbes: latencies.length,
    p50Ms: pct(0.5),
    p95Ms: pct(0.95),
    worstMs: sorted.length ? Math.round(sorted[sorted.length - 1]) : null,
    // Windows paints "Not Responding" after about 5s of no message pumping.
    neverNearNotResponding: sorted.length ? sorted[sorted.length - 1] < 5000 : false
  })

  // ── 5. The app's own output must not be indexed as user media ──
  //
  // The disposable tree deliberately contains the isolated userData directory,
  // so the walk passes right over the thumbnails this very scan generated. The
  // walk used to index them (only the watcher applied isGeneratedAsset), so
  // every photo and video appeared twice - once as itself, once as a tile
  // showing its own thumbnail.
  const mode = await window.api.getRuntimeMode()
  const udLower = mode.userDataPath.toLowerCase()
  const allGroups = finalSummary.groups
  let selfIndexed = 0
  let inspected = 0
  for (const g of allGroups.slice(0, 40)) {
    const rows = await window.api.libraryPage(q, g.offset, Math.min(g.count, 200))
    for (const r of rows.rows) {
      inspected++
      if (r.path.toLowerCase().startsWith(udLower)) selfIndexed++
    }
  }
  say('no-self-indexing', {
    userDataPath: mode.userDataPath,
    rowsInspected: inspected,
    rowsInsideUserData: selfIndexed,
    clean: selfIndexed === 0
  })

  // ── 6. Cancellation ──
  //
  // Discovery has to be stoppable, not just waitable, and stopping must keep
  // what was already found - those are files that were really there.
  const beforeCancel = (await window.api.librarySummary(q)).total
  let cancelProgress = 0
  const offCancelProgress = window.api.onScanProgress((p) => {
    if (!p.drive || p.drive === drive) cancelProgress = p.count
  })
  window.electron.ipcRenderer.send('rescan-drive', drive)
  // Let it get going, then stop it.
  await new Promise((r) => setTimeout(r, 1200))
  const tCancel = now()
  const cancelled = await window.api.cancelScan(drive)
  const cancelMs = now() - tCancel
  await new Promise((r) => setTimeout(r, 1500))
  offCancelProgress()
  const afterCancel = await window.api.librarySummary(q)
  // Responsiveness immediately after cancelling.
  const tProbe = now()
  await window.api.getTileSize()
  const probeAfterCancelMs = now() - tProbe

  say('cancellation', {
    cancelAckMs: Math.round(cancelMs),
    cancelled: cancelled.cancelled,
    sawProgressBeforeCancel: cancelProgress > 0,
    totalBeforeCancel: beforeCancel,
    totalAfterCancel: afterCancel.total,
    // Nothing already found may be lost by stopping.
    keptWhatWasFound: afterCancel.total >= beforeCancel,
    probeAfterCancelMs: Math.round(probeAfterCancelMs)
  })

  return JSON.stringify(log, null, 2)
})()
