/**
 * Delete -> immediate disappearance -> Trash -> Restore, through the real UI of
 * a running build. Isolated catalogue only (refuses the default one); nothing
 * on disk is deleted - Trash in DiskFrame is a flag on the record.
 *
 * Times are from the click that confirms, measured in animation frames, and
 * every check reads the screen (tiles, group header counts, status-bar total,
 * dock Trash badge, viewer) as well as the main process's own summary.
 */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()))
  const m = await window.api.getRuntimeMode()
  if (m.isDefaultUserData) return 'REFUSING: default user data'
  const out = { commit: m.buildCommit, checks: [] }
  const ok = (name, pass, detail = {}) => out.checks.push({ name, pass, ...detail })
  const q = { drive: 'C:', nav: 'all', search: '', groupBy: 'day', order: 'default' }
  const summaryTotal = async () => (await window.api.librarySummary(q)).total
  const tile = (p) => document.querySelector(`[data-tile="${CSS.escape(p)}"]`)
  const byText = (sel, re) => [...document.querySelectorAll(sel)].find((e) => re.test(e.textContent))
  const statusTotal = () => {
    const el = [...document.querySelectorAll('div')].find((d) => /^\s*[\d,]+\+?\s*files\s*$/i.test(d.textContent) && d.children.length === 1)
    return el ? Number(el.textContent.replace(/[^\d]/g, '')) : null
  }
  const badge = () => {
    const t = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /^\s*Trash\s*$/i.test(e.textContent))
    const item = t && t.closest('button, [role=button], .dock-item, div')
    const n = item && [...item.querySelectorAll('*')].map((e) => e.textContent.trim()).find((s) => /^\d+$/.test(s))
    return n ? Number(n) : 0
  }
  const headerCountFor = (p) => {
    const el = tile(p)
    if (!el) return null
    const top = parseFloat(el.style.top)
    const heads = [...document.querySelectorAll('.pg-header')].filter((h) => parseFloat(h.style.top) < top)
    const h = heads[heads.length - 1]
    return h ? Number(h.querySelector('.pg-header-count').textContent.replace(/[^\d]/g, '')) : null
  }
  const framesUntil = async (pred, max = 120) => {
    for (let i = 0; i <= max; i++) {
      if (pred()) return i
      await frame()
    }
    return null
  }
  const click = (el) => {
    const r = el.getBoundingClientRect()
    const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 }
    el.dispatchEvent(new MouseEvent('mousedown', o))
    el.dispatchEvent(new MouseEvent('mouseup', o))
  }
  const tiles = () => [...document.querySelectorAll('[data-tile]')].map((t) => t.dataset.tile)

  // ── 1. Context menu -> Move to Trash ──
  {
    const p = tiles()[1]
    const before = { total: statusTotal(), header: headerCountFor(p), badge: badge(), summary: await summaryTotal() }
    const r = tile(p).getBoundingClientRect()
    tile(p).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5, button: 2 }))
    await frame()
    byText('div', /^\s*Move to Trash\s*$/).click()
    await frame()
    byText('button', /^\s*Move to Trash\s*$/).click()
    const frames = await framesUntil(() => !tile(p))
    const after = { total: statusTotal(), badge: badge() }
    await sleep(600)
    const settled = { tilePresent: !!tile(p), total: statusTotal(), badge: badge(), summary: await summaryTotal() }
    ok('context menu: tile gone at once, counts follow', frames !== null && frames <= 2 && after.total === before.total - 1 && after.badge === before.badge + 1 && !settled.tilePresent && settled.summary === before.summary - 1, {
      framesToDisappear: frames, before, afterFirstFrames: after, settled, file: p.split(String.fromCharCode(92)).pop()
    })
  }

  // ── 2. Two selected + Delete key ──
  {
    const ps = tiles().slice(0, 2)
    for (const p of ps) tile(p).querySelector('.pg-check').click()
    await frame()
    const before = { total: statusTotal(), badge: badge() }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    await frame()
    byText('button', /^\s*Move to Trash\s*$/).click()
    const frames = await framesUntil(() => ps.every((p) => !tile(p)))
    await sleep(600)
    const selectedLeft = /selected/i.test(document.body.innerText.match(/\d+ selected/)?.[0] ?? '')
    ok('multi-select + Delete: both gone at once, selection cleared', frames !== null && frames <= 2 && statusTotal() === before.total - 2 && badge() === before.badge + 2 && !selectedLeft, {
      framesToDisappear: frames, total: `${before.total} -> ${statusTotal()}`, badge: `${before.badge} -> ${badge()}`, selectedLeft
    })
  }

  // ── 3. From the viewer: advances to the next file ──
  {
    const [p, next] = tiles()
    click(tile(p))
    await sleep(900)
    // The viewer's own filename label: a leaf element, outside the grid.
    const nameShown = () => {
      if (!document.querySelector('.media-viewer-back-btn')) return null
      const leaf = [...document.querySelectorAll('div,span')].find(
        (e) => e.children.length === 0 && /^\s*[^\\/]+\.(jpe?g|png|mp4|mov)\s*$/i.test(e.textContent) && !e.closest('[data-tile]')
      )
      return leaf ? leaf.textContent.trim() : null
    }
    const before = nameShown()
    document.querySelector('[title="Delete File"]').click()
    await frame()
    const btns = [...document.querySelectorAll('button')].filter((b) => /^\s*Move to Trash\s*$/.test(b.textContent))
    btns[btns.length - 1].click()
    const frames = await framesUntil(() => (nameShown() || '').toLowerCase() !== (before || '').toLowerCase())
    await sleep(500)
    const viewerOpen = !!document.querySelector('.media-viewer-back-btn')
    const now = nameShown()
    ok('viewer: deleting the open file shows the next one', viewerOpen && frames !== null && (now || '').toLowerCase() === next.split(String.fromCharCode(92)).pop().toLowerCase() && !tile(p), {
      before, after: now, expected: next.split(String.fromCharCode(92)).pop(), framesToAdvance: frames
    })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await sleep(600)
  }

  // ── 4. A trash the main process refuses is reported, and the gallery shows the truth ──
  {
    const p = tiles()[0]
    // Already trashed behind the gallery's back: the second trash changes nothing.
    await window.electron.ipcRenderer.invoke('delete-files', [p])
    tile(p).querySelector('.pg-check').click()
    await frame()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    await frame()
    byText('button', /^\s*Move to Trash\s*$/).click()
    await sleep(400)
    const toast = byText('div', /Could not move/i)
    ok('refused trash: an error is shown, nothing silently claimed', !!toast, { toast: toast && toast.textContent.trim() })
    await sleep(3200)
  }

  // ── 5. Restore from Trash puts it back in the gallery, no restart ──
  {
    const badgeBefore = badge()
    const trashed = await window.electron.ipcRenderer.invoke('get-trashed-files', 'C:')
    const victim = trashed[0]
    const t = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /^\s*Trash\s*$/i.test(e.textContent))
    t.closest('button, div').click()
    await sleep(700)
    const before = { badge: badgeBefore, inTrashView: !!document.querySelector(`[data-grid-tile="${CSS.escape(victim.path)}"]`) }
    const r = document.querySelector(`[data-grid-tile="${CSS.escape(victim.path)}"]`)
    r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2 }))
    await frame()
    byText('div', /^\s*Restore File\s*$/).click()
    const frames = await framesUntil(() => !document.querySelector(`[data-grid-tile="${CSS.escape(victim.path)}"]`))
    await sleep(600)
    const all = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /^\s*All files\s*$/i.test(e.textContent))
    all.closest('button, div').click()
    await sleep(900)
    const badgeAfter = badge()
    const page = await window.api.libraryPage(q, 0, 500)
    const back = page.rows.some((row) => row.path === victim.path)
    ok('restore: leaves Trash at once and is back in All files', frames !== null && frames <= 2 && back && badgeAfter === before.badge - 1, {
      framesToLeaveTrash: frames, backInGallery: back, badge: `${before.badge} -> ${badgeAfter}`, file: victim.name
    })
  }

  out.allPassed = out.checks.every((c) => c.pass)
  return JSON.stringify(out, null, 1)
})()
