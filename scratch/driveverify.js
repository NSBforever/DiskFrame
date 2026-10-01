/**
 * Verifies drive presentation and catalogue state in the INSTALLED app.
 *
 * Read-only: no scan, no reindex, no cache clearing, no writes.
 *
 * Answers, from the running process:
 *   - which build, which database, diagnostic mode or not;
 *   - which drives it presents, with the volume identity it resolved for each;
 *   - the catalogue count each card would show, and whether that matches the
 *     volume actually verified at that letter;
 *   - which catalogues exist for volumes that are NOT currently connected, so a
 *     saved catalogue cannot be mistaken for a connected drive.
 */
;(async () => {
  const mode = await window.api.getRuntimeMode()

  const drives = await new Promise((resolve) => {
    const off = window.api.onDrivesUpdated((d) => {
      off()
      resolve(d)
    })
    window.api.getDrives()
    setTimeout(() => {
      off()
      resolve([])
    }, 20000)
  })

  // Exactly what the drive-select grid asks for.
  const counts = await window.api.getDriveFileCounts()

  const cards = []
  for (const d of drives) {
    const letter = d.name.slice(0, 2).toUpperCase()
    const liveVolume = await window.api.getVolumeId(letter)
    const count = counts[letter]
    const summary = await window.api.librarySummary({
      drive: letter,
      nav: 'all',
      search: '',
      groupBy: 'day',
      order: 'default'
    })
    cards.push({
      letter,
      label: d.label ?? d.name,
      model: d.model,
      connection: d.connectionType,
      media: d.mediaType,
      totalGB: d.total,
      usedGB: d.used,
      freeGB: d.free,
      enumeratedVolumeId: d.volumeId,
      liveVolumeId: liveVolume ? liveVolume.slice(11, 19) : null,
      identityUnverified: d.identityUnverified === true,
      cardWouldShow:
        d.identityUnverified === true
          ? 'Drive could not be verified'
          : count === undefined
            ? '(count missing)'
            : count > 0
              ? `${count.toLocaleString()} files indexed`
              : 'Not indexed yet',
      driveFileCount: count,
      librarySummaryTotal: summary.total,
      // The card's count and the library's own total answer the same question
      // about the same volume. They must agree.
      countsAgree: count === summary.total
    })
  }

  const availability = await window.api.driveAvailability()

  return JSON.stringify(
    {
      build: {
        commit: mode.buildCommit,
        appVersion: mode.appVersion,
        userDataPath: mode.userDataPath,
        isDefaultUserData: mode.isDefaultUserData,
        diagnosticMode: mode.safeMode
      },
      presentedDrives: drives.map((d) => d.name.slice(0, 2).toUpperCase()),
      cards,
      // Catalogues held for volumes, with whether that volume is connected now.
      // A saved catalogue for a disconnected drive must not appear as a drive.
      catalogues: availability,
      connectedLettersPresented: drives.map((d) => d.name.slice(0, 2).toUpperCase()).sort()
    },
    null,
    2
  )
})()
