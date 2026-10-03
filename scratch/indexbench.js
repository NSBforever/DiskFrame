/**
 * What an index on files(path) is worth, measured on a COPY of the real
 * catalogue. The real database is opened read-only and never written.
 *
 * Every one of these statements is on a hot path today:
 *   media://      one volume lookup per image, video and preview request
 *   thumbnails    one availability lookup + one UPDATE per tile, cached or not
 *   viewport      one IN (...) per prioritize-thumbnails call
 *   discovery     one existence check per file inserted, for the whole scan
 */
const D = require('better-sqlite3'), p = require('path'), fs = require('fs'), os = require('os')
const real = p.join(process.env.APPDATA, 'diskframe', 'diskframe.db')
const copy = p.join(os.tmpdir(), 'df-indexbench.db')

for (const f of [copy, copy + '-wal', copy + '-shm']) {
  try { fs.unlinkSync(f) } catch { /* not there */ }
}
// VACUUM INTO gives a consistent copy including the live WAL, read-only on the
// source. The real catalogue is never written by this script.
const src = new D(real, { readonly: true })
src.exec("VACUUM INTO '" + copy.split('\\').join('/') + "'")
src.close()

const db = new D(copy)
const n = db.prepare('SELECT COUNT(*) n FROM files').get().n
const paths = db.prepare('SELECT path FROM files ORDER BY RANDOM() LIMIT 400').all().map((r) => r.path)
console.log('catalogue copy: ' + n + ' rows, ' + (fs.statSync(copy).size / 1048576).toFixed(0) + ' MB')

const cases = {
  'media:// volume lookup  (SELECT volume_id WHERE path=?)': () => {
    const s = db.prepare('SELECT volume_id FROM files WHERE path = ?')
    return () => { for (const x of paths) s.get(x) }
  },
  'thumbnail write         (UPDATE ... WHERE path=?)': () => {
    const s = db.prepare('UPDATE files SET thumb = thumb WHERE path = ?')
    return () => { for (const x of paths) s.run(x) }
  },
  'viewport skip-list      (SELECT ... WHERE path IN (400))': () => {
    const ph = paths.map(() => '?').join(',')
    const s = db.prepare('SELECT path, thumb_fail_sig FROM files WHERE path IN (' + ph + ') AND IFNULL(thumb_fail_count,0) >= ?')
    return () => { s.all(...paths, 3) }
  },
  'discovery existence     (SELECT 1 WHERE path=?)': () => {
    const s = db.prepare('SELECT 1 FROM files WHERE path = ?')
    return () => { for (const x of paths) s.get(x) }
  }
}

function run(label) {
  console.log('\n=== ' + label + ' ===')
  const res = {}
  for (const [name, mk] of Object.entries(cases)) {
    const fn = mk()
    fn() // warm
    const t = process.hrtime.bigint()
    fn()
    const ms = Number(process.hrtime.bigint() - t) / 1e6
    res[name] = ms
    const per = name.indexOf('IN (400)') !== -1 ? ms : ms / paths.length
    console.log('  ' + name.padEnd(56) + ms.toFixed(0).padStart(6) + 'ms total   ' + per.toFixed(3) + 'ms per call')
  }
  return res
}

const plan = (d) => d.prepare('EXPLAIN QUERY PLAN SELECT volume_id FROM files WHERE path = ?').all('x').map((r) => r.detail).join(' | ')

const before = run('BEFORE: no index on files(path)')
console.log('\n  plan: ' + plan(db))

const tIdx = process.hrtime.bigint()
db.exec('CREATE INDEX IF NOT EXISTS idx_files_path ON files (path)')
const buildMs = Number(process.hrtime.bigint() - tIdx) / 1e6
const sizeAfter = fs.statSync(copy).size

const after = run('AFTER: CREATE INDEX idx_files_path ON files (path)')
console.log('\n  plan: ' + plan(db))

console.log('\n=== summary (' + n + ' rows) ===')
console.log('  index build: ' + buildMs.toFixed(0) + 'ms one-off, database ' + (sizeAfter / 1048576).toFixed(0) + ' MB after')
for (const k of Object.keys(cases)) {
  console.log('  ' + k.padEnd(56) + before[k].toFixed(0).padStart(6) + 'ms -> ' + after[k].toFixed(0).padStart(5) + 'ms  (' + (before[k] / Math.max(after[k], 0.001)).toFixed(0) + 'x)')
}
const kLookup = 'media:// volume lookup  (SELECT volume_id WHERE path=?)'
const kWrite = 'thumbnail write         (UPDATE ... WHERE path=?)'
const perTile = (before[kWrite] + before[kLookup]) / paths.length
const perTileAfter = (after[kWrite] + after[kLookup]) / paths.length
console.log('\n  per thumbnail, DB time only: ' + perTile.toFixed(1) + 'ms -> ' + perTileAfter.toFixed(2) + 'ms')
console.log('  a 40-tile viewport:          ' + (perTile * 40).toFixed(0) + 'ms -> ' + (perTileAfter * 40).toFixed(0) + 'ms of synchronous main-process work')
db.close()
for (const f of [copy, copy + '-wal', copy + '-shm']) {
  try { fs.unlinkSync(f) } catch { /* already gone */ }
}
