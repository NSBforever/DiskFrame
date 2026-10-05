/**
 * The viewer's open/close transition, measured per animation frame in a
 * running build. Reads geometry, not pixels: where the flight starts, where it
 * lands, whether the picture is ever drawn twice (flight and stage both
 * visible), and whether the gallery's scroll position survives.
 *
 * window.__kind = 'photo' | 'video' picks the tile. window.__scroll scrolls the
 * grid first. Isolated or real catalogue both fine: this only opens files.
 */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const frame = () => new Promise((r) => requestAnimationFrame(r))
  const kind = window.__kind || 'photo'
  const re = window.__match ? new RegExp(window.__match, 'i') : kind === 'video' ? /\.(mp4|mov)$/i : /\.(jpe?g|png)$/i
  const scroller = document.querySelector('.pg-scroller')
  if (window.__scroll && scroller) {
    scroller.scrollTop = window.__scroll
    await sleep(700)
  }

  const visible = (el) => { const r = el.getBoundingClientRect(); return r.top >= 60 && r.bottom <= innerHeight - 120 }
  let tile = [...document.querySelectorAll('[data-tile]')].find((t) => re.test(t.dataset.tile) && visible(t))
  if (!tile) {
    const any = [...document.querySelectorAll('[data-tile]')].find((t) => re.test(t.dataset.tile))
    if (any) {
      any.scrollIntoView({ block: 'center' })
      await sleep(800)
      tile = [...document.querySelectorAll('[data-tile]')].find((t) => re.test(t.dataset.tile) && visible(t))
    }
  }
  if (!tile) return JSON.stringify({ error: 'no visible ' + kind + ' tile' })
  const scrollBefore = scroller ? scroller.scrollTop : null
  const path = tile.dataset.tile
  const tr = tile.getBoundingClientRect()
  const R = (r) => r && { x: Math.round(r.left ?? r.x), y: Math.round(r.top ?? r.y), w: Math.round(r.width ?? r.w), h: Math.round(r.height ?? r.h) }
  const flightEl = () => [...document.querySelectorAll('[aria-hidden="true"]')].find((e) => e.style.position === 'fixed' && e.style.zIndex === '1200')
  const media = () => document.querySelector('[data-viewer-media]')
  // Effective opacity of the viewer's own picture: every ancestor's, multiplied.
  const stageOpacity = () => { const m = media(); if (!m) return null; let o = 1; for (let e = m; e && e !== document.body; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o }

  const sample = async (ms, label) => {
    const out = []
    const t0 = performance.now()
    while (performance.now() - t0 < ms) {
      const f = flightEl()
      out.push({ t: Math.round(performance.now() - t0), flight: f ? R(f.getBoundingClientRect()) : null, stage: stageOpacity(), media: media() ? R(media().getBoundingClientRect()) : null, viewer: !!document.querySelector('.media-viewer-back-btn') })
      await frame()
    }
    return out
  }

  // Open.
  const o = { bubbles: true, cancelable: true, clientX: tr.left + 10, clientY: tr.top + 10, button: 0 }
  tile.dispatchEvent(new MouseEvent('mousedown', o))
  tile.dispatchEvent(new MouseEvent('mouseup', o))
  const open = await sample(kind === 'video' ? 1600 : 900)
  const firstFlight = open.find((s) => s.flight)
  const withFlight = open.filter((s) => s.flight)
  const lastFlight = withFlight[withFlight.length - 1]
  const doubleDrawn = open.filter((s) => s.flight && s.stage > 0.01 && s.t < (lastFlight?.t ?? 0) - 40).length
  const settled = open[open.length - 1]
  const diff = (a, b) => a && b ? Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h)) : null
  const res = {
    kind,
    file: path.split(String.fromCharCode(92)).pop(),
    tile: R(tr),
    open: {
      firstFlight: firstFlight && firstFlight.flight,
      startOffByPx: diff(firstFlight && firstFlight.flight, R(tr)),
      landedAt: lastFlight && lastFlight.flight,
      finalMedia: settled.media,
      landingOffByPx: diff(lastFlight && lastFlight.flight, settled.media),
      flightFrames: withFlight.length,
      flightMs: lastFlight ? lastFlight.t - (firstFlight ? firstFlight.t : 0) : 0,
      framesDrawnTwice: doubleDrawn,
      viewerReady: settled.viewer,
      mediaAspect: settled.media ? +(settled.media.w / settled.media.h).toFixed(3) : null
    }
  }

  // Close (Escape, as a person would).
  await sleep(kind === 'video' ? 1200 : 300)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  const close = await sample(700)
  const cf = close.filter((s) => s.flight)
  const tileNow = document.querySelector(`[data-tile="${CSS.escape(path)}"]`)
  res.close = {
    firstFlight: cf[0] && cf[0].flight,
    lastFlight: cf[cf.length - 1] && cf[cf.length - 1].flight,
    tileNow: tileNow && R(tileNow.getBoundingClientRect()),
    endOffByPx: diff(cf[cf.length - 1] && cf[cf.length - 1].flight, tileNow && R(tileNow.getBoundingClientRect())),
    flightFrames: cf.length,
    viewerGone: !document.querySelector('[data-viewer-media]') && !flightEl(),
    scrollBefore,
    scrollAfter: scroller ? scroller.scrollTop : null
  }
  return JSON.stringify(res, null, 1)
})()
