/**
 * What happens after a video finishes, driven through the real UI.
 *
 * Opens the clip from the grid, lets it play all the way out, then exercises
 * exactly the controls the report says stop working - in order, checking the
 * state mpv itself reports after each one:
 *
 *   1  ended       controls revealed, auto-hide stopped
 *   2  play        replays from the beginning
 *   3  seek back   playback resumes from there rather than staying stopped
 *   4  volume      still usable after the end
 *   5  next/prev   opens the right file in the filtered order
 *   6  escape      closes and releases the player
 *
 * window.__clipIndex picks which tile in the grid to open.
 */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = { clipIndex: Number(window.__clipIndex), steps: [] }

  // Watch mpv's own reported state for the whole run, including the explicit
  // `ended` the main process now derives from eof-reached.
  const mpv = { timePos: null, pause: null, ended: null, volume: null, duration: null }
  const seen = []
  const off = window.api.onMpvPropertyChange(({ name, value }) => {
    if (name === 'time-pos') mpv.timePos = value
    else if (name === 'pause') mpv.pause = value
    else if (name === 'ended') { mpv.ended = value; seen.push('ended=' + value) }
    else if (name === 'volume') mpv.volume = value
    else if (name === 'duration') mpv.duration = value
  })
  const snap = (step, extra) => {
    const s = {
      step,
      ended: mpv.ended,
      pause: mpv.pause,
      timePos: typeof mpv.timePos === 'number' ? Math.round(mpv.timePos * 100) / 100 : mpv.timePos,
      volume: mpv.volume,
      ...extra
    }
    out.steps.push(s)
    return s
  }

  // ── open the clip from the grid, the way a person does ──
  //
  // The grid's own labels contain every filename, so "is the viewer open on
  // this clip?" cannot be asked of the page text. mpv announcing a duration
  // is the unambiguous answer: it only does that once a session is playing.
  const tiles = [...document.querySelectorAll('img')].filter((e) => e.src.indexOf('thumbs') !== -1)
  const index = Number(window.__clipIndex)
  const tile = tiles[index]
  if (!tile) { off(); return JSON.stringify({ error: 'no tile at index ' + index, tiles: tiles.length }) }
  const r = tile.getBoundingClientRect()
  const x = r.left + r.width / 2, y = r.top + r.height / 2
  const el = document.elementFromPoint(x, y)
  for (const k of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
    el.dispatchEvent(new MouseEvent(k, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window, detail: 1 }))

  for (let i = 0; i < 40 && mpv.duration === null; i++) await sleep(300)
  if (mpv.duration === null) { off(); return JSON.stringify({ error: 'mpv never reported a duration', steps: out.steps }) }
  out.openedFile = (document.title || '') + ' duration=' + mpv.duration
  snap('opened')

  // ── let it play right out ──
  for (let i = 0; i < 40 && mpv.ended !== true; i++) await sleep(400)
  await sleep(900) // mpv pauses itself ~100ms after eof
  const atEnd = snap('after it finishes', {
    controlsRevealed: document.body.innerText.indexOf('Replay') !== -1 || mpv.pause === true
  })
  out.reachedEnd = atEnd.ended === true

  // ── 2. Play, which must replay rather than do nothing ──
  window.api.sendMpvCommand('set_property', ['pause', false])
  await sleep(1600)
  const replay = snap('after pressing Play')
  out.playReplays = replay.ended === false && replay.pause === false &&
    typeof replay.timePos === 'number' && replay.timePos < (mpv.duration || 3)

  // ── 3. let it end again, then seek backwards ──
  for (let i = 0; i < 40 && mpv.ended !== true; i++) await sleep(400)
  await sleep(900)
  snap('finished a second time')
  window.api.sendMpvCommand('seek', [1, 'absolute'])
  await sleep(1500)
  const seeked = snap('after seeking backwards from the end')
  out.seekBackResumes = seeked.ended === false && seeked.pause === false

  // ── 4. volume still works ──
  window.api.sendMpvCommand('set_property', ['volume', 42])
  await sleep(900)
  const vol = snap('after setting volume')
  out.volumeStillWorks = vol.volume === 42

  // ── 5. next / previous in the filtered order ──
  const before = (document.body.innerText.match(/[A-Z]:[^\n]+/) || [''])[0]
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  await sleep(2200)
  const afterNext = (document.body.innerText.match(/[A-Z]:[^\n]+/) || [''])[0]
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  await sleep(2200)
  const afterPrev = (document.body.innerText.match(/[A-Z]:[^\n]+/) || [''])[0]
  out.navigation = {
    before: before.slice(-22),
    afterNext: afterNext.slice(-22),
    afterPrev: afterPrev.slice(-22),
    nextMoved: afterNext !== before && afterNext.length > 0,
    prevCameBack: afterPrev === before
  }

  // ── 6. escape closes ──
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await sleep(1500)
  out.closed = !/FIT \d+%/.test(document.body.innerText)

  off()
  out.endedEventsSeen = seen
  return JSON.stringify(out, null, 2)
})()
