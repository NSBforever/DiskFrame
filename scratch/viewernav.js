/**
 * Does the viewer stay usable around a file it cannot paint?
 *
 * Opens the gallery's own list, steps through it with Next/Previous, and
 * checks that a missing original is reported honestly while a readable one
 * beside it still displays - and that Close works from either.
 *
 * Drives the real UI (clicks and key events), so it exercises the same code a
 * person does. Read-only: it opens and navigates, nothing else.
 */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const text = () => document.body.innerText
  const fire = (key) => {
    for (const t of [document, window]) t.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  }
  const state = () => ({
    viewerOpen: /FIT \d+%/.test(text()),
    failureShown: text().indexOf('Original unavailable') !== -1 || text().indexOf('Could not be displayed') !== -1,
    genericMessage: text().indexOf('Failed to load image') !== -1,
    title: (document.body.innerText.match(/^[A-Z0-9][^\n]*\n/m) || [''])[0].trim().slice(0, 50),
    showingPhoto: [...document.querySelectorAll('img')].some((i) => i.src.indexOf('media:///') === 0 && i.src.indexOf('thumbs') === -1)
  })

  const out = { steps: [] }

  // Open the first tile in the current grid.
  const img = [...document.querySelectorAll('img')].find((e) => e.src.indexOf('thumbs') !== -1)
  if (!img) return JSON.stringify({ error: 'no tiles in the grid' })
  const r = img.getBoundingClientRect()
  const x = r.left + r.width / 2, y = r.top + r.height / 2
  const target = document.elementFromPoint(x, y)
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
    target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window, detail: 1 }))
  await sleep(1200)
  out.steps.push({ step: 'open first tile', ...state() })

  // Walk forward, then back, which is what a person does after hitting a
  // file that will not paint.
  for (let i = 0; i < 5; i++) {
    fire('ArrowRight')
    await sleep(900)
    out.steps.push({ step: 'next ' + (i + 1), ...state() })
  }
  for (let i = 0; i < 3; i++) {
    fire('ArrowLeft')
    await sleep(900)
    out.steps.push({ step: 'prev ' + (i + 1), ...state() })
  }

  fire('Escape')
  await sleep(900)
  out.steps.push({ step: 'escape', ...state() })

  out.navigationAlwaysWorked = out.steps.slice(0, -1).every((s) => s.viewerOpen)
  out.closedCleanly = out.steps[out.steps.length - 1].viewerOpen === false
  out.neverShowedGenericMessage = out.steps.every((s) => !s.genericMessage)
  out.someFileDisplayed = out.steps.some((s) => s.showingPhoto)
  return JSON.stringify(out, null, 2)
})()
