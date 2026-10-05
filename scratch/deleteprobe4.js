/** Favourites view: a trashed favourite leaves the view and its count; trashing
 *  the only file open in the viewer closes the viewer. Isolated catalogue only. */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const m = await window.api.getRuntimeMode()
  if (m.isDefaultUserData) return 'REFUSING: default user data'
  const leaf = (re) => [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && re.test(e.textContent))
  const nav = async (label) => {
    leaf(new RegExp('^\\s*' + label + '\\s*$', 'i')).closest('button, div').click()
    await sleep(700)
  }
  const favCount = () => {
    const el = [...document.querySelectorAll('div')].find((d) => /favourites\s*$/i.test(d.textContent) && d.querySelector('svg') && d.children.length <= 2)
    return el ? Number((el.textContent.match(/(\d+)/) || [])[1]) : null
  }
  await nav('All files')
  // Make exactly one favourite on the screen.
  const favs = await new Promise((r) => { const off = window.api.onFavouritesUpdated((d) => { off(); r(d.files) }); window.api.getFavourites('C:') })
  for (const f of favs) window.api.toggleFavourite(f.path, f.volume_id)
  await sleep(500)
  const target = document.querySelector('[data-tile]').dataset.tile
  const row = (await window.api.libraryPage({ drive: 'C:', nav: 'all', search: '', groupBy: 'day', order: 'default' }, 0, 500)).rows.find((r) => r.path === target)
  window.api.toggleFavourite(row.path, row.volume_id)
  await sleep(600)
  await nav('Favourites')
  const tileInFav = () => document.querySelector(`[data-grid-tile="${CSS.escape(target)}"]`)
  const before = { inView: !!tileInFav(), count: favCount() }
  // Open it, and trash it from the viewer: it was the only favourite.
  const el = tileInFav()
  const r = el.getBoundingClientRect()
  const o = { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10, button: 0 }
  el.dispatchEvent(new MouseEvent('mousedown', o)); el.dispatchEvent(new MouseEvent('mouseup', o))
  await sleep(900)
  const viewerOpened = !!document.querySelector('.media-viewer-back-btn')
  document.querySelector('[title="Delete File"]').click()
  await sleep(100)
  const btns = [...document.querySelectorAll('button')].filter((b) => /^\s*Move to Trash\s*$/.test(b.textContent))
  btns[btns.length - 1].click()
  await sleep(800)
  const after = { viewerOpen: !!document.querySelector('.media-viewer-back-btn'), inView: !!tileInFav(), count: favCount(), emptyState: !!leaf(/^\s*No favourites yet/i) }
  // Restore it so the fixture is left as found.
  await window.electron.ipcRenderer.invoke('restore-files', [{ path: row.path, volumeId: row.volume_id }])
  return JSON.stringify({ pass: before.inView && viewerOpened && !after.viewerOpen && !after.inView && after.count === 0, before, viewerOpened, after }, null, 1)
})()
