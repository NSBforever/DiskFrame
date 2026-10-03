/**
 * Next/Previous out of a video that has finished.
 *
 * The file on screen is read from the viewer's own path line, not the page
 * text - the gallery header is "C: · ALL" and the grid labels carry every
 * filename, so either would match whatever you looked for.
 */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const shown = () => {
    const m = document.body.innerText.match(/C:\\[^\n]*\.(?:mp4|mov|png)/i)
    return m ? m[0].split('\\').pop() : null
  }
  const out = { steps: [] }
  let duration = null
  let ended = null
  const off = window.api.onMpvPropertyChange(({ name, value }) => {
    if (name === 'duration') duration = value
    else if (name === 'ended') ended = value
  })

  const tiles = [...document.querySelectorAll('img')].filter((e) => e.src.indexOf('thumbs') !== -1)
  const tile = tiles[Number(window.__clipIndex)]
  if (!tile) { off(); return JSON.stringify({ error: 'no tile' }) }
  const r = tile.getBoundingClientRect()
  const x = r.left + r.width / 2, y = r.top + r.height / 2
  const el = document.elementFromPoint(x, y)
  for (const k of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
    el.dispatchEvent(new MouseEvent(k, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window, detail: 1 }))
  for (let i = 0; i < 40 && duration === null; i++) await sleep(300)
  await sleep(600)
  out.steps.push({ step: 'opened', file: shown(), duration })

  // Let it finish, so navigation is tested from the ended state specifically.
  for (let i = 0; i < 40 && ended !== true; i++) await sleep(400)
  await sleep(800)
  out.steps.push({ step: 'finished', file: shown(), ended })
  const atEnd = shown()

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  await sleep(2600)
  out.steps.push({ step: 'next', file: shown() })
  const next = shown()

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  await sleep(2600)
  out.steps.push({ step: 'previous', file: shown() })
  const back = shown()

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await sleep(1500)
  const closedFile = shown()

  off()
  out.endedBeforeNavigating = out.steps[1].ended === true
  out.nextOpenedADifferentFile = !!next && next !== atEnd
  out.previousCameBack = back === atEnd
  out.escapeClosed = closedFile === null
  return JSON.stringify(out, null, 2)
})()
