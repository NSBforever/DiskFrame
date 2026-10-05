/** Interruptions: close during the opening flight, Next during the opening
 *  flight, and reduced motion. Each must leave a clean state - no stray flight
 *  element, no stuck invisible viewer. */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const flightEl = () => [...document.querySelectorAll('[aria-hidden="true"]')].find((e) => e.style.position === 'fixed' && e.style.zIndex === '1200')
  const viewerUp = () => !!document.querySelector('.media-viewer-back-btn')
  const anyViewer = () => !!document.querySelector('[data-viewer-media]') || viewerUp() || !!flightEl()
  const open = (i) => {
    const t = [...document.querySelectorAll('[data-tile]')].filter((x) => /\.jpe?g$/i.test(x.dataset.tile))[i]
    const r = t.getBoundingClientRect()
    const o = { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10, button: 0 }
    t.dispatchEvent(new MouseEvent('mousedown', o)); t.dispatchEvent(new MouseEvent('mouseup', o))
    return t.dataset.tile
  }
  const esc = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  const out = {}

  // 1. Escape 120ms into the opening flight.
  open(0); await sleep(120)
  out.closeMidOpen_flightPresent = !!flightEl()
  esc(); await sleep(700)
  out.closeMidOpen_clean = !anyViewer()

  // 2. Five rapid open/close cycles.
  for (let i = 0; i < 5; i++) { open(i % 2); await sleep(60); esc(); await sleep(60) }
  await sleep(900)
  out.rapid_clean = !anyViewer()

  // 3. Next while the flight is still in the air.
  const first = open(1); await sleep(100)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  await sleep(700)
  out.nextMidOpen = { viewerUp: viewerUp(), flightGone: !flightEl(), stageVisible: (() => { const m = document.querySelector('[data-viewer-media]'); if (!m) return null; let o = 1; for (let e = m; e && e !== document.body; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o })() }
  esc(); await sleep(700)
  out.nextMidOpen_closedClean = !anyViewer()
  void first
  return JSON.stringify(out)
})()
