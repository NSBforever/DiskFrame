/**
 * End-of-playback against a real video on the external SSD, through the
 * installed build.
 *
 * The clip is seeked to just before its end rather than played in full: what
 * is being tested is the state AFTER the last frame, and a phone video is
 * minutes long. Nothing is written - this plays a file and closes it.
 *
 * window.__ext picks the container ('.mov' or '.mp4').
 */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const ext = (window.__ext || '.mov').toLowerCase()
  const out = { ext, steps: [] }

  const st = { timePos: null, pause: null, ended: null, duration: null, volume: null }
  const off = window.api.onMpvPropertyChange(({ name, value }) => {
    if (name === 'time-pos') st.timePos = value
    else if (name === 'pause') st.pause = value
    else if (name === 'ended') st.ended = value
    else if (name === 'duration') st.duration = value
    else if (name === 'volume') st.volume = value
  })
  const snap = (step) => {
    const s = {
      step,
      ended: st.ended,
      pause: st.pause,
      timePos: typeof st.timePos === 'number' ? Math.round(st.timePos * 10) / 10 : st.timePos
    }
    out.steps.push(s)
    return s
  }

  // Find a real video of this container in the open drive, through the grid.
  await new Promise((r) => {
    const o = window.api.onDriveOpened((d) => { if (d.drive !== 'D:') return; o(); r() })
    window.api.openDrive('D:')
    setTimeout(r, 30000)
  })
  const q = { drive: 'D:', nav: 'videos', search: '', groupBy: 'day', order: 'default' }
  const page = await window.api.libraryPage(q, 0, 400)
  const row = page.rows.find((r) => r.path.toLowerCase().endsWith(ext))
  if (!row) { off(); return JSON.stringify({ error: 'no ' + ext + ' in the first 400 videos' }) }
  out.file = row.name
  out.sizeMB = Math.round(row.size / 1048576)

  // Start it the way the viewer does.
  await window.api.playMpv(row.path, { left: 100, top: 100, width: 640, height: 360 })
  for (let i = 0; i < 60 && st.duration === null; i++) await sleep(250)
  if (st.duration === null) { off(); return JSON.stringify({ error: 'mpv reported no duration', file: out.file }) }
  out.durationSecs = Math.round(st.duration)
  snap('playing')

  // Jump to just before the end rather than waiting out a phone video.
  window.api.sendMpvCommand('seek', [Math.max(0, st.duration - 2), 'absolute'])
  for (let i = 0; i < 60 && st.ended !== true; i++) await sleep(300)
  await sleep(1000)
  const atEnd = snap('after it finishes')
  out.reachedEnd = atEnd.ended === true

  // The command the Play button sends.
  window.api.sendMpvCommand('set_property', ['pause', false])
  await sleep(2000)
  const replay = snap('after pressing Play')
  out.playReplays = replay.ended === false && replay.pause === false &&
    typeof replay.timePos === 'number' && replay.timePos < st.duration - 2

  // Back to the end, then seek backwards out of it.
  window.api.sendMpvCommand('seek', [Math.max(0, st.duration - 2), 'absolute'])
  for (let i = 0; i < 60 && st.ended !== true; i++) await sleep(300)
  await sleep(1000)
  snap('finished again')
  window.api.sendMpvCommand('seek', [Math.max(0, st.duration / 2), 'absolute'])
  await sleep(2000)
  const seeked = snap('after seeking backwards from the end')
  out.seekBackResumes = seeked.ended === false && seeked.pause === false

  window.api.sendMpvCommand('set_property', ['volume', 37])
  await sleep(800)
  out.volumeStillWorks = st.volume === 37

  window.api.closeMpv()
  await sleep(800)
  off()
  return JSON.stringify(out, null, 2)
})()
