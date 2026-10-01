/**
 * Measures what a user actually waits for when opening a drive, from inside the
 * running app.
 *
 * `openDrive` is exactly what clicking a drive card sends, so this measures the
 * same path without needing a click. The three numbers are deliberately
 * separate, because they are three different waits:
 *
 *   identity   openDrive -> drive-opened: resolving which volume is at this
 *              letter and counting its records.
 *   summary    the group summary: how the grid knows its shape. This is what
 *              used to be answered before identity was primed and then never
 *              re-asked, which is how "0 files" ended up beside "1,007 groupings".
 *   firstPage  the first 200 rows: the first real entries on screen.
 *
 * Printed as JSON. Expression form, for scratch/cdp.js.
 */
;(async () => {
  const drive = window.__measureDrive || 'D:'
  const t0 = performance.now()

  const opened = await new Promise((resolve) => {
    const off = window.api.onDriveOpened((d) => {
      if (d.drive !== drive) return
      off()
      resolve({ ...d, at: performance.now() })
    })
    window.api.openDrive(drive)
    setTimeout(() => {
      off()
      resolve(null)
    }, 60000)
  })
  const tIdentity = opened ? opened.at - t0 : null

  const q = { drive, nav: 'all', search: '', groupBy: 'day', order: 'default' }

  const tS = performance.now()
  const summary = await window.api.librarySummary(q)
  const tSummary = performance.now() - tS

  const tP = performance.now()
  const page = await window.api.libraryPage(q, 0, 200)
  const tFirstPage = performance.now() - tP

  return JSON.stringify(
    {
      drive,
      identityMs: tIdentity === null ? 'timeout' : Math.round(tIdentity),
      indexedRecords: opened ? opened.indexed : null,
      needsInitialScan: opened ? opened.needsInitialScan : null,
      identityUnresolved: opened ? opened.identityUnresolved : null,
      summaryMs: Math.round(tSummary),
      summaryTotal: summary.total,
      summaryGroups: summary.groups.length,
      firstPageMs: Math.round(tFirstPage),
      firstPageRows: page.rows.length,
      timeToFirstEntriesMs: Math.round((tIdentity || 0) + tSummary + tFirstPage)
    },
    null,
    2
  )
})()
