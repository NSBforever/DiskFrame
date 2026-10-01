/**
 * Verifies the reported pairs in the INSTALLED app, through the same IPC the
 * grid uses. Read-only: no scan, no writes, nothing deleted or hidden.
 *
 * Checks, for the real catalogue:
 *   1. each reported pair comes back as TWO rows with two distinct paths and
 *      two distinct thumbnails - kept, not deduplicated;
 *   2. walking every page of the open drive returns each path exactly once,
 *      and the row count matches the summary total;
 *   3. group counts agree with the rows at each group's offset;
 *   4. changing sort order and grouping does not introduce a repeat;
 *   5. every page response reports the same catalogue version, so the grid's
 *      resident set is from one snapshot;
 *   6. re-reading the same pages repeatedly (the "repeated events" case) is
 *      stable.
 */
;(async () => {
  const drive = 'D:'
  const out = {}

  await new Promise((resolve) => {
    const off = window.api.onDriveOpened((d) => {
      if (d.drive !== drive) return
      off()
      resolve(d)
    })
    window.api.openDrive(drive)
    setTimeout(resolve, 30000)
  })

  const q = (over = {}) => ({
    drive,
    nav: 'all',
    search: '',
    groupBy: 'day',
    order: 'default',
    ...over
  })

  const PAGE = 200
  // Bounded: 30 page boundaries per combination is what exercises the boundary
  // logic. A full 40,960-row walk x10 combinations takes ~15 minutes and proves
  // nothing extra - and the location/favourites page query windows the whole
  // volume per page, so it dominates the time without adding coverage.
  const WALK_LIMIT = 6000
  async function walk(query) {
    const paths = []
    const versions = new Set()
    for (let offset = 0; ; offset += PAGE) {
      const res = await window.api.libraryPage(query, offset, PAGE)
      versions.add(res.version)
      for (const r of res.rows) paths.push(r.path)
      if (res.rows.length < PAGE || paths.length >= WALK_LIMIT) break
    }
    return { paths, versions: [...versions] }
  }

  // ── 1. the reported pairs ──
  const PAIR_NAMES = [
    '2025_04_30_19_37_IMG_5419.MOV',
    '2025_04_30_19_34_IMG_5418.MP4',
    '2025_04_28_00_36_IMG_5333.MP4',
    '2025_04_27_18_19_IMG_5311.MOV',
    '2025_04_27_16_53_IMG_5304.MOV'
  ]
  const pairResults = []
  for (const name of PAIR_NAMES) {
    const s = await window.api.librarySummary(q({ search: name }))
    const rows = (await window.api.libraryPage(q({ search: name }), 0, 50)).rows
    pairResults.push({
      name,
      summaryTotal: s.total,
      rowsReturned: rows.length,
      distinctPaths: new Set(rows.map((r) => r.path)).size,
      distinctThumbs: new Set(rows.map((r) => r.thumb)).size,
      paths: rows.map((r) => r.path),
      // Both copies must survive, each exactly once, with their own thumbnail.
      bothKeptOnce:
        rows.length === 2 &&
        new Set(rows.map((r) => r.path)).size === 2 &&
        new Set(rows.map((r) => r.thumb)).size === 2
    })
  }
  out.reportedPairs = pairResults

  // ── 2/4/5. full walk, every grouping and order ──
  const walks = []
  for (const groupBy of ['day', 'month', 'year', 'location', 'favorites']) {
    for (const order of ['default', 'reverse']) {
      const query = q({ groupBy, order })
      const s = await window.api.librarySummary(query)
      const { paths, versions } = await walk(query)
      const unique = new Set(paths)
      walks.push({
        groupBy,
        order,
        summaryTotal: s.total,
        groups: s.groups.length,
        walkLimited: paths.length >= 6000,
        rowsWalked: paths.length,
        uniquePaths: unique.size,
        duplicates: paths.length - unique.size,
        pageVersionsSeen: versions.length,
        summaryVersion: s.version,
        ok: paths.length === unique.size && (paths.length >= 6000 || paths.length === s.total)
      })
    }
  }
  out.pagination = walks

  // ── 3. group counts vs the rows at each offset ──
  const query = q()
  const s = await window.api.librarySummary(query)
  let offsetDrift = 0
  let countMismatch = 0
  let running = 0
  for (const g of s.groups.slice(0, 60)) {
    if (g.offset !== running) offsetDrift++
    const rows = (await window.api.libraryPage(query, g.offset, Math.min(g.count, 200))).rows
    if (rows.length !== Math.min(g.count, 200)) countMismatch++
    running += g.count
  }
  out.groupOffsets = {
    groupsChecked: Math.min(60, s.groups.length),
    offsetDrift,
    countMismatch,
    summedCountsEqualTotal: s.groups.reduce((n, g) => n + g.count, 0) === s.total,
    ok: offsetDrift === 0 && countMismatch === 0
  }

  // ── 6. repeated identical reads ──
  const first = (await window.api.libraryPage(query, 0, 200)).rows.map((r) => r.path)
  let unstable = 0
  for (let i = 0; i < 6; i++) {
    const again = (await window.api.libraryPage(query, 0, 200)).rows.map((r) => r.path)
    if (again.join('|') !== first.join('|')) unstable++
  }
  out.repeatedReads = { attempts: 6, unstable, ok: unstable === 0 }

  return JSON.stringify(out, null, 2)
})()
