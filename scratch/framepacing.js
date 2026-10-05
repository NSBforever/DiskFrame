/** Frame pacing during open and close, with nothing but rAF timestamps read -
 *  so the measurement does not itself force layout every frame. */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const re = new RegExp(window.__match || '\\.(jpe?g|png)$', 'i')
  const tile = [...document.querySelectorAll('[data-tile]')].find((t) => re.test(t.dataset.tile))
  if (!tile) return 'no tile'
  const t0Ref = { t: 0 }
  const pace = (ms) => new Promise((resolve) => {
    const ts = []
    const t0 = performance.now()
    t0Ref.t = t0
    const step = (t) => { ts.push(t); if (t - t0 < ms) requestAnimationFrame(step); else resolve(ts) }
    requestAnimationFrame(step)
  })
  const summarise = (ts) => {
    const d = ts.slice(1).map((t, i) => t - ts[i])
    d.sort((a, b) => a - b)
    return { firstFrameAfterMs: +(ts[0] - t0Ref.t).toFixed(1), frames: ts.length, medianMs: +d[Math.floor(d.length / 2)].toFixed(1), p95Ms: +d[Math.floor(d.length * 0.95)].toFixed(1), worstMs: +d[d.length - 1].toFixed(1), over33ms: d.filter((x) => x > 33.4).length }
  }
  const r = tile.getBoundingClientRect()
  const o = { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10, button: 0 }
  const p = pace(500)
  tile.dispatchEvent(new MouseEvent('mousedown', o))
  tile.dispatchEvent(new MouseEvent('mouseup', o))
  const open = summarise(await p)
  await sleep(600)
  const c = pace(450)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  const close = summarise(await c)
  await sleep(300)
  return JSON.stringify({ file: tile.dataset.tile.split(String.fromCharCode(92)).pop(), open, close })
})()
