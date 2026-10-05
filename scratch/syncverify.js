/**
 * External changes reach the gallery: files and folders added, renamed, moved
 * and deleted on disk, the way File Explorer or another app would, against a
 * running build with an ISOLATED catalogue (refuses the default one).
 *
 *   node scratch/syncverify.js live   <port> <fixtureRoot>
 *   node scratch/syncverify.js closed-prepare <fixtureRoot>     (app not running)
 *   node scratch/syncverify.js closed-check   <port> <fixtureRoot>
 *
 * Only ever touches files inside <fixtureRoot>, which must be a disposable
 * tree (scratch/makefixture.js). Each check waits for the catalogue AND, for
 * on-screen files, the grid DOM - a passing summary alone would not show that
 * the gallery the user is looking at changed.
 */
const fs = require('fs')
const path = require('path')
const { connect } = require('./cdplib')

const [mode, a1, a2] = process.argv.slice(2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, ...detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(detail)}`)
}

async function rowsOf(cdp) {
  const json = await cdp.eval(`(async () => {
    const q = { drive: 'C:', nav: 'all', search: '', groupBy: 'day', order: 'default' }
    const s = await window.api.librarySummary(q)
    const out = []
    for (let off = 0; off < s.total; off += 500) {
      const p = await window.api.libraryPage(q, off, 500)
      for (const r of p.rows) out.push([r.path, r.favourited, r.volume_id])
    }
    return JSON.stringify({ total: s.total, rows: out })
  })()`)
  const v = JSON.parse(json)
  const map = new Map(v.rows.map(([p, f, vol]) => [p.toLowerCase(), { path: p, fav: f, vol }]))
  return { total: v.total, map }
}

async function until(cdp, pred, ms = 15000) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < ms) {
    last = await rowsOf(cdp)
    if (pred(last)) return { ms: Date.now() - t0, rows: last }
    await sleep(250)
  }
  return { ms: null, rows: last }
}

async function favourite(cdp, p) {
  const r = (await rowsOf(cdp)).map.get(p.toLowerCase())
  if (!r) throw new Error('not indexed: ' + p)
  if (r.fav === 1) return
  await cdp.eval(`window.api.toggleFavourite(${JSON.stringify(r.path)}, ${JSON.stringify(r.vol)})`)
  await sleep(300)
}

async function guard(cdp) {
  const m = JSON.parse(await cdp.eval('window.api.getRuntimeMode().then(JSON.stringify)'))
  if (m.isDefaultUserData) throw new Error('REFUSING: this is the default (real) catalogue')
  return m
}

async function live(port, root) {
  const cdp = await connect(port)
  const m = await guard(cdp)
  console.log('build', m.buildCommit, 'catalogue', m.userDataPath)
  const has = (rows, p) => rows.map.has(p.toLowerCase())
  const P = (...s) => path.join(root, ...s)

  // 1. A file copied in.
  fs.copyFileSync(P('2023', 'june', fs.readdirSync(P('2023', 'june')).find((f) => f.endsWith('.jpg'))), P('2025', 'family', 'added_live.jpg'))
  let r = await until(cdp, (x) => has(x, P('2025', 'family', 'added_live.jpg')))
  record('file added in Explorer appears', r.ms !== null, { ms: r.ms })

  // 2. A favourite renamed keeps its favourite.
  const victim = fs.readdirSync(P('2023', 'january')).find((f) => f.endsWith('.jpg'))
  await favourite(cdp, P('2023', 'january', victim))
  fs.renameSync(P('2023', 'january', victim), P('2023', 'january', 'renamed_live.jpg'))
  r = await until(cdp, (x) => !has(x, P('2023', 'january', victim)) && has(x, P('2023', 'january', 'renamed_live.jpg')))
  record('renamed favourite follows, still a favourite', r.ms !== null && r.rows.map.get(P('2023', 'january', 'renamed_live.jpg').toLowerCase())?.fav === 1, { ms: r.ms, from: victim })

  // 3. Moved to another folder.
  const mv = fs.readdirSync(P('2024', 'trip', 'day1')).find((f) => f.endsWith('.jpg'))
  fs.renameSync(P('2024', 'trip', 'day1', mv), P('docs', mv))
  r = await until(cdp, (x) => !has(x, P('2024', 'trip', 'day1', mv)) && has(x, P('docs', mv)))
  record('file moved between folders follows', r.ms !== null, { ms: r.ms })

  // 4. Deleting a file that is on screen removes its tile.
  const onScreen = await cdp.eval(`[...document.querySelectorAll('[data-tile]')].map(t => t.dataset.tile).find(p => /\\.jpg$/i.test(p))`)
  const before = (await rowsOf(cdp)).total
  fs.unlinkSync(onScreen)
  r = await until(cdp, (x) => !has(x, onScreen))
  const tileGone = await (async () => {
    for (let i = 0; i < 40; i++) {
      const present = await cdp.eval(`!!document.querySelector('[data-tile="' + CSS.escape(${JSON.stringify(onScreen)}) + '"]')`)
      if (!present) return true
      await sleep(100)
    }
    return false
  })()
  record('on-screen file deleted: record and tile gone', r.ms !== null && tileGone, { ms: r.ms, total: `${before} -> ${r.rows.total}`, tileGone })

  // 5. A folder deleted with Explorer (one event for the folder, none for its files).
  fs.mkdirSync(P('tmpfolder'))
  const src = P('2023', 'june', fs.readdirSync(P('2023', 'june')).find((f) => f.endsWith('.jpg')))
  for (const n of ['t1.jpg', 't2.jpg', 't3.jpg']) fs.copyFileSync(src, P('tmpfolder', n))
  r = await until(cdp, (x) => ['t1.jpg', 't2.jpg', 't3.jpg'].every((n) => has(x, P('tmpfolder', n))))
  record('new folder with files appears', r.ms !== null, { ms: r.ms })
  fs.rmSync(P('tmpfolder'), { recursive: true })
  r = await until(cdp, (x) => ['t1.jpg', 't2.jpg', 't3.jpg'].every((n) => !has(x, P('tmpfolder', n))))
  record('deleted folder: all its files gone', r.ms !== null, { ms: r.ms })

  // 6. A folder renamed, with a favourite inside.
  const inDay2 = fs.readdirSync(P('2024', 'trip', 'day2')).filter((f) => /\.(jpg|mp4)$/.test(f))
  await favourite(cdp, P('2024', 'trip', 'day2', inDay2[0]))
  fs.renameSync(P('2024', 'trip', 'day2'), P('2024', 'trip', 'day2 renamed'))
  r = await until(cdp, (x) => inDay2.every((n) => !has(x, P('2024', 'trip', 'day2', n)) && has(x, P('2024', 'trip', 'day2 renamed', n))))
  record('renamed folder: every file follows, favourite kept', r.ms !== null && r.rows.map.get(P('2024', 'trip', 'day2 renamed', inDay2[0]).toLowerCase())?.fav === 1, { ms: r.ms, files: inDay2.length })

  // Nothing unrelated was lost along the way.
  const final = await rowsOf(cdp)
  const onDisk = []
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else onDisk.push(p) } }
  walk(root)
  const missingFromCatalogue = onDisk.filter((p) => /\.(jpg|mp4|pdf)$/i.test(p) && fs.statSync(p).size >= (/\.jpg$/i.test(p) ? 51200 : 0) && !final.map.has(p.toLowerCase()))
  const ghosts = [...final.map.values()].filter((v) => v.path.toLowerCase().startsWith(root.toLowerCase()) && !fs.existsSync(v.path)).map((v) => v.path)
  record('catalogue matches the disk afterwards', missingFromCatalogue.length === 0 && ghosts.length === 0, { missingFromCatalogue: missingFromCatalogue.length, ghosts: ghosts.length, examples: [...missingFromCatalogue, ...ghosts].slice(0, 3) })
  cdp.close()
}

function closedPrepare(root) {
  const P = (...s) => path.join(root, ...s)
  const plan = {}
  const j = fs.readdirSync(P('2023', 'june')).filter((f) => f.endsWith('.jpg'))
  plan.renamedFrom = P('2023', 'june', j[0]); plan.renamedTo = P('2023', 'june', 'renamed_closed.jpg')
  fs.renameSync(plan.renamedFrom, plan.renamedTo)
  plan.deleted = P('2023', 'june', j[1]); fs.unlinkSync(plan.deleted)
  plan.added = P('2025', 'family', 'added_closed.jpg'); fs.copyFileSync(P('2023', 'june', j[2]), plan.added)
  const fam = fs.readdirSync(P('2025', 'family'))
  plan.folderGone = P('2025', 'family'); plan.folderGoneFiles = fam.map((f) => P('2025', 'family', f))
  // Move the whole folder out from under the root's tree to elsewhere in it.
  plan.folderTo = P('2025', 'family moved')
  fs.renameSync(plan.folderGone, plan.folderTo)
  fs.writeFileSync(path.join(root, '..', 'df-verify-plan.json'), JSON.stringify(plan, null, 1))
  console.log(JSON.stringify(plan, null, 1))
}

async function closedCheck(port, root) {
  const plan = JSON.parse(fs.readFileSync(path.join(root, '..', 'df-verify-plan.json'), 'utf8'))
  const cdp = await connect(port)
  await guard(cdp)
  const has = (rows, p) => rows.map.has(p.toLowerCase())
  const moved = plan.folderGoneFiles.map((p) => path.join(plan.folderTo, path.basename(p)))
  const r = await until(cdp, (x) =>
    !has(x, plan.renamedFrom) && has(x, plan.renamedTo) && !has(x, plan.deleted) &&
    plan.folderGoneFiles.every((p) => !has(x, p)) && moved.every((p) => has(x, p)), 30000)
  const x = r.rows
  record('changes made while DiskFrame was closed are reconciled on open', r.ms !== null, {
    ms: r.ms,
    renamed: !has(x, plan.renamedFrom) && has(x, plan.renamedTo),
    deletedGone: !has(x, plan.deleted),
    added: has(x, path.join(plan.folderTo, path.basename(plan.added))),
    folderMoved: moved.every((p) => has(x, p))
  })
  cdp.close()
}

;(async () => {
  if (mode === 'live') await live(Number(a1), a2)
  else if (mode === 'closed-prepare') closedPrepare(a1)
  else if (mode === 'closed-check') await closedCheck(Number(a1), a2)
  else throw new Error('mode?')
  const failed = results.filter((r) => !r.ok).length
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error('FATAL', e.message); process.exit(2) })
