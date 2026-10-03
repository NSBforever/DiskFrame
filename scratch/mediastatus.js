/**
 * Does the app now tell the truth about a file it cannot paint?
 *
 * Runs inside the app. Read-only: asks about existing records and fetches
 * through the real media protocol. Writes nothing, deletes nothing.
 *
 * Four cases are checked against real records:
 *   gone        the reported Snips capture - original cleared by Windows,
 *               preview still on disk
 *   present     an ordinary readable file, which must still report ok
 *   retry       the same readable file with the Retry query string, which must
 *               resolve to the same bytes rather than 404
 *   offline     a path on a letter that is not mounted
 */
;(async () => {
  const out = {}
  const status = (p) => window.api.mediaStatus(p)
  const fetchStatus = async (url) => {
    try {
      const r = await fetch(url)
      return { httpStatus: r.status, bytes: r.ok ? (await r.arrayBuffer()).byteLength : 0 }
    } catch (e) {
      return { httpStatus: 'threw', error: String(e).slice(0, 80) }
    }
  }
  const toUrl = (p) => 'media:///' + p.split('\\').join('/')

  // ── the reported record: find it through the normal library read ──
  await new Promise((r) => {
    const off = window.api.onDriveOpened((d) => { if (d.drive !== 'C:') return; off(); r(d) })
    window.api.openDrive('C:')
    setTimeout(r, 30000)
  })
  const q = { drive: 'C:', nav: 'all', search: 'Screenshot', groupBy: 'day', order: 'default' }
  const s = await window.api.librarySummary(q)
  const page = await window.api.libraryPage(q, 0, 400)
  const snip = page.rows.find((r) => r.path.indexOf('TempState') !== -1 && r.path.indexOf('Snips') !== -1)
  out.searchFoundRows = page.rows.length
  out.summaryTotal = s.total

  if (snip) {
    out.reportedFile = {
      path: snip.path.slice(0, 120),
      hasCachedPreview: !!snip.thumb,
      status: await status(snip.path),
      mediaFetch: await fetchStatus(toUrl(snip.path)),
      previewFetch: snip.thumb ? await fetchStatus(toUrl(snip.thumb)) : null
    }
  } else {
    out.reportedFile = 'no TempState\\Snips row in the first 400 search results'
  }

  // ── an ordinary readable file must still be ok, and Retry must not break it ──
  const okRow = page.rows.find((r) => r.path.indexOf('TempState') === -1)
  if (okRow) {
    const st = await status(okRow.path)
    out.readableFile = {
      path: okRow.path.slice(-60),
      status: st,
      plain: await fetchStatus(toUrl(okRow.path)),
      withRetryQuery: await fetchStatus(toUrl(okRow.path) + '?retry=3')
    }
    out.retryResolvesSameFile =
      st.status === 'ok' &&
      out.readableFile.plain.httpStatus === 200 &&
      out.readableFile.withRetryQuery.httpStatus === 200 &&
      out.readableFile.plain.bytes === out.readableFile.withRetryQuery.bytes
  }

  // ── a letter that is not mounted must say so, not "missing" ──
  out.offlineLetter = await status('Z:\\nowhere\\nothing.jpg')

  return JSON.stringify(out, null, 2)
})()
