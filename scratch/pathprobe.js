/**
 * Read-only: what the per-file path lookup costs, and what the app decides for
 * the reported "Failed to load image" path.
 *
 * Reproduces checkPathAvailability's two inputs exactly - the row's recorded
 * volume_id and whether the file is readable - without going through the app,
 * so the decision can be read apart from any rendering.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scratch/pathprobe.js
 */
const D = require('better-sqlite3'), p = require('path'), fs = require('fs')
const db = new D(p.join(process.env.APPDATA, 'diskframe', 'diskframe.db'), { readonly: true })

const readable = (f) => {
  try { fs.accessSync(f, fs.constants.R_OK); return true } catch { return false }
}

console.log('--- query plan: SELECT volume_id FROM files WHERE path = ? ---')
for (const r of db.prepare('EXPLAIN QUERY PLAN SELECT volume_id FROM files WHERE path = ?').all('x'))
  console.log('   ', r.detail)

console.log('\n--- the reported Snips records: original vs cached preview ---')
const snips = db.prepare("SELECT path, volume_id, thumb FROM files WHERE path LIKE '%TempState%Snips%'").all()
let origGone = 0, thumbOk = 0, noIdentity = 0
for (const r of snips) {
  if (!fs.existsSync(r.path)) origGone++
  if (r.thumb && fs.existsSync(r.thumb)) thumbOk++
  if (!r.volume_id) noIdentity++
}
console.log(`    ${snips.length} rows`)
console.log(`    original missing on disk:  ${origGone}`)
console.log(`    cached preview present:    ${thumbOk}`)
console.log(`    no recorded volume id:     ${noIdentity}`)
const one = snips[0]
if (one) {
  console.log(`    sample: ${one.path.slice(0, 100)}`)
  console.log(`      exists=${fs.existsSync(one.path)} readable=${readable(one.path)} volume=${one.volume_id ? 'recorded' : 'NONE'}`)
}

console.log('\n--- rows whose identity was never recorded (reported as unverified, not served) ---')
console.log('    all rows:                ', db.prepare('SELECT COUNT(*) n FROM files').get().n)
console.log('    rows with NULL volume_id:', db.prepare('SELECT COUNT(*) n FROM files WHERE volume_id IS NULL').get().n)

console.log('\n--- cost of the lookup every media request makes ---')
const stmt = db.prepare('SELECT volume_id FROM files WHERE path = ?')
const sample = db.prepare('SELECT path FROM files ORDER BY RANDOM() LIMIT 200').all().map((r) => r.path)
let t = process.hrtime.bigint()
for (const s of sample) stmt.get(s)
const ms = Number(process.hrtime.bigint() - t) / 1e6
console.log(`    200 lookups on random real paths: ${ms.toFixed(0)}ms (${(ms / 200).toFixed(3)}ms each)`)
console.log(`    one 60-tile viewport: ${((ms / 200) * 60).toFixed(0)}ms of synchronous main-process time, before any file I/O`)
