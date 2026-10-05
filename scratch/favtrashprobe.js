(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const count = () => {
    const t = document.body.innerText.match(/(\d+)\s*FAVOURITES/i)
    return t ? Number(t[1]) : null
  }
  const leaf = (re) => [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && re.test(e.textContent))
  leaf(/^\s*All files\s*$/i).closest('button, div').click()
  await sleep(900)
  const before = count()
  // Trash the favourite through the UI: it is in the gallery (All files), find its tile.
  const favs = await new Promise((r) => { const off = window.api.onFavouritesUpdated((d) => { off(); r(d.files) }); window.api.getFavourites('C:') })
  const p = favs[0].path
  let el = document.querySelector(`[data-tile="${CSS.escape(p)}"]`)
  if (!el) return JSON.stringify({ note: 'favourite not on screen', p })
  const r = el.getBoundingClientRect()
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5, button: 2 }))
  await sleep(50)
  ;[...document.querySelectorAll('div')].find((e) => /^\s*Move to Trash\s*$/.test(e.textContent)).click()
  await sleep(50)
  ;[...document.querySelectorAll('button')].find((b) => /^\s*Move to Trash\s*$/.test(b.textContent)).click()
  await new Promise((res) => requestAnimationFrame(res))
  const immediate = count()
  await sleep(800)
  return JSON.stringify({ before, immediate, settled: count(), pass: before === 1 && immediate === 0 && count() === 0 })
})()
