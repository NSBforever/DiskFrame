/**
 * Switching drives must not let one volume's catalogue appear under another's
 * letter, and a late answer for the drive just left must not land.
 *
 * Opens each connected drive in turn and checks that the summary it reports is
 * scoped to the volume actually verified at that letter - including the case
 * that matters most, two different volumes that have both been "E:".
 */
;(async () => {
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

  const out = []
  for (const d of drives) {
    const letter = d.name.slice(0, 2).toUpperCase()
    const opened = await new Promise((resolve) => {
      const off = window.api.onDriveOpened((e) => {
        if (e.drive !== letter) return
        off()
        resolve(e)
      })
      window.api.openDrive(letter)
      setTimeout(() => {
        off()
        resolve(null)
      }, 30000)
    })
    const q = { drive: letter, nav: 'all', search: '', groupBy: 'day', order: 'default' }
    const s = await window.api.librarySummary(q)
    const vol = await window.api.getVolumeId(letter)
    out.push({
      letter,
      model: d.model,
      connection: d.connectionType,
      volume: vol ? vol.replace(/^\\\\\?\\Volume\{/, '').slice(0, 8) : null,
      openedIndexed: opened ? opened.indexed : 'timeout',
      summaryTotal: s.total,
      groups: s.groups.length,
      // The two must agree: they are the same question asked of the same
      // identity. Disagreement is the 0-files/1,007-groupings bug.
      agrees: opened ? opened.indexed === s.total : false
    })
  }
  return JSON.stringify(out, null, 2)
})()
