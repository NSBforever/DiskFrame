/**
 * Delete -> immediate disappearance -> Trash -> Restore, driven through the
 * real UI of a running build (isolated catalogue only - refuses the default
 * user data directory).
 *
 * Uses the context menu and the confirm dialog exactly as a person would, then
 * reads what is on screen: the tile, the group count, the status-bar total and
 * the Trash badge. Times are from the confirm click.
 */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const m = await window.api.getRuntimeMode()
  if (m.isDefaultUserData) return 'REFUSING: default user data'
  const out = { commit: m.buildCommit, steps: [] }
  const until = async (fn, ms = 5000) => {
    const t = performance.now()
    while (performance.now() - t < ms) {
      const v = fn()
      if (v) return performance.now() - t
      await sleep(16)
    }
    return null
  }
  const text = (el) => (el ? el.textContent.trim() : null)
  const findByText = (sel, re) => [...document.querySelectorAll(sel)].find((e) => re.test(e.textContent))
  const statusFiles = () => {
    const el = [...document.querySelectorAll('div')].find((d) => /^\s*[\d,]+\+?\s*files\s*$/i.test(d.textContent) && d.children.length === 1)
    return el ? Number(el.textContent.replace(/[^\d]/g, '')) : null
  }
  const trashBadge = () => {
    const nav = [...document.querySelectorAll('.snav')].find((e) => /trash/i.test(e.textContent))
    const b = nav && nav.querySelector('span:last-child')
    return b && /^\d+$/.test(b.textContent.trim()) ? Number(b.textContent.trim()) : 0
  }
  const click = (el, opts = {}) => {
    const r = el.getBoundingClientRect()
    const base = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, ...opts }
    el.dispatchEvent(new MouseEvent('mousedown', base))
    el.dispatchEvent(new MouseEvent('mouseup', base))
    el.dispatchEvent(new MouseEvent('click', base))
  }

  // Open the drive from the drive page if we are on it.
  const card = document.querySelector('.drive-card')
  if (card) click(card)
  await until(() => document.querySelector('[data-tile]'), 15000)
  await sleep(800)

  const tiles = [...document.querySelectorAll('[data-tile]')]
  if (tiles.length < 3) return JSON.stringify({ error: 'no tiles', n: tiles.length })
  const victim = tiles[1]
  const victimPath = victim.dataset.tile
  out.victim = victimPath.split('\\').pop()
  out.before = { tiles: tiles.length, total: statusFiles(), trash: trashBadge() }

  // Right-click -> Move to Trash -> confirm.
  const r = victim.getBoundingClientRect()
  victim.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5, button: 2 }))
  await until(() => findByText('div', /^\s*Move to Trash\s*$/))
  findByText('div', /^\s*Move to Trash\s*$/).click()
  await until(() => findByText('button', /^\s*Move to Trash\s*$/))
  const t0 = performance.now()
  findByText('button', /^\s*Move to Trash\s*$/).click()

  const goneMs = await until(() => !document.querySelector(`[data-tile="${CSS.escape(victimPath)}"]`), 6000)
  out.tileGoneAfterMs = goneMs === null ? 'STILL VISIBLE after 6s' : Math.round(goneMs)
  await sleep(1200)
  out.after = {
    tileStillInDom: !!document.querySelector(`[data-tile="${CSS.escape(victimPath)}"]`),
    total: statusFiles(),
    trash: trashBadge(),
    msSinceConfirm: Math.round(performance.now() - t0)
  }
  // What the main process says, independently of what is painted.
  const q = { drive: 'C:', nav: 'all', search: '', groupBy: 'day', order: 'default' }
  const s = await window.api.librarySummary(q)
  out.after.summaryTotal = s.total
  return JSON.stringify(out, null, 2)
})()
