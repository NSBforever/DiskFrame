/** Read-only census of the production catalogue, to confirm nothing was lost. */
const D = require('better-sqlite3'), p = require('path'), fs = require('fs')
const root = p.join(process.env.APPDATA, 'diskframe')
const db = new D(p.join(root, 'diskframe.db'), { readonly: true })
const n = (s, ...a) => db.prepare(s).get(...a).n

console.log('rows                 ', n('SELECT COUNT(*) n FROM files'))
console.log('favourites (files)   ', n('SELECT COUNT(*) n FROM files WHERE favourited = 1'))
console.log('favourite_paths rows ', n('SELECT COUNT(*) n FROM favourite_paths'))
console.log('trashed              ', n('SELECT COUNT(*) n FROM files WHERE trashed_at IS NOT NULL'))
console.log('hidden (vault)       ', n('SELECT COUNT(*) n FROM files WHERE hidden = 1'))
console.log('folder_mappings      ', n('SELECT COUNT(*) n FROM folder_mappings'))
console.log('\nper volume:')
for (const r of db.prepare('SELECT IFNULL(volume_id, «null») v, COUNT(*) n FROM files GROUP BY volume_id ORDER BY n DESC'.replace(/«|»/g, "'")).all())
  console.log('  ', String(r.v).slice(0, 48).padEnd(50), r.n)
console.log('\nfavourites per volume:')
for (const r of db.prepare('SELECT IFNULL(volume_id, «null») v, COUNT(*) n FROM files WHERE favourited = 1 GROUP BY volume_id'.replace(/«|»/g, "'")).all())
  console.log('  ', String(r.v).slice(0, 48).padEnd(50), r.n)

const td = p.join(root, 'thumbs')
let bytes = 0
const files = fs.existsSync(td) ? fs.readdirSync(td) : []
for (const f of files) { try { bytes += fs.statSync(p.join(td, f)).size } catch { /* vanished */ } }
console.log('\nthumb cache          ', files.length, 'files,', (bytes / 1048576).toFixed(0), 'MB')
console.log('rows with a thumb    ', n("SELECT COUNT(*) n FROM files WHERE thumb IS NOT NULL AND thumb != ''"))
console.log('database             ', (fs.statSync(p.join(root, 'diskframe.db')).size / 1048576).toFixed(0), 'MB')
console.log('free on C:           ', (() => {
  try {
    const out = require('child_process').execSync('powershell -NoProfile -Command "(Get-PSDrive C).Free"', { encoding: 'utf8' })
    return (Number(out.trim()) / 1073741824).toFixed(1) + ' GB'
  } catch { return 'unknown' }
})())
