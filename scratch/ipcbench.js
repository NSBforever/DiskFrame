/**
 * Bounded before/after for the second confirmed cause: what `files-updated`
 * used to carry.
 *
 * Before: getGroupedFiles(drive) - every row for the volume, grouped, then
 * structured-cloned across IPC and flattened into an array plus a Map in the
 * renderer. After: nothing but {drive, reason}; the renderer re-reads the
 * group summary and the pages it is showing.
 *
 * Reads the real database read-only. Nothing is scanned.
 */
const Database = require('better-sqlite3')
const path = require('path')
const v8 = require('v8')

const db = new Database(path.join(process.env.APPDATA, 'diskframe', 'diskframe.db'), {
  readonly: true
})
const vol = db
  .prepare('SELECT volume_id, COUNT(*) n FROM files WHERE volume_id IS NOT NULL GROUP BY volume_id ORDER BY n DESC LIMIT 1')
  .get()
console.log(`volume ${vol.volume_id} — ${vol.n} rows\n`)

const COLS =
  'path, name, ext, size, date, year, month, lat, lng, drive, favourited, thumb, volume_id'
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6

// ── BEFORE: the whole catalogue ──
let t0 = process.hrtime.bigint()
const rows = db
  .prepare(
    `SELECT ${COLS} FROM files WHERE volume_id = ? AND hidden = 0 AND trashed_at IS NULL ORDER BY date DESC`
  )
  .all(vol.volume_id)
const grouped = {}
for (const f of rows) {
  const key = `${f.year || 'Unknown'}-${f.month || 'Unknown'}`
  ;(grouped[key] ||= []).push(f)
}
const beforeQuery = ms(t0)

// What the IPC layer actually does to the payload.
t0 = process.hrtime.bigint()
const buf = v8.serialize(grouped)
const serialize = ms(t0)
t0 = process.hrtime.bigint()
const back = v8.deserialize(buf)
const deserialize = ms(t0)

// What the renderer then did with it.
t0 = process.hrtime.bigint()
const all = Object.values(back).flat()
const index = new Map(all.map((f) => [f.path, f]))
const rendererWork = ms(t0)

console.log('BEFORE  files-updated carrying getGroupedFiles():')
console.log(`  main: query + group        ${beforeQuery.toFixed(0)} ms (synchronous, blocks the window)`)
console.log(`  main: structured clone out ${serialize.toFixed(0)} ms`)
console.log(`  payload size               ${(buf.length / 1048576).toFixed(1)} MB`)
console.log(`  renderer: clone in         ${deserialize.toFixed(0)} ms`)
console.log(`  renderer: flatten + Map    ${rendererWork.toFixed(0)} ms  (${index.size} entries)`)
console.log(
  `  TOTAL blocking            ${(beforeQuery + serialize + deserialize + rendererWork).toFixed(0)} ms across both processes\n`
)

// ── AFTER: the group summary the renderer reads instead ──
t0 = process.hrtime.bigint()
const summary = db
  .prepare(
    `SELECT substr(date,1,10) AS gkey, COUNT(*) AS n,
            SUM(CASE WHEN ext IN ('.pdf','.docx','.doc','.txt','.xlsx','.pptx','.csv') THEN 1 ELSE 0 END) AS n_compact,
            MIN(date) AS min_date, MAX(date) AS max_date
     FROM files WHERE volume_id = ? AND hidden = 0 AND trashed_at IS NULL
     GROUP BY gkey ORDER BY MAX(date) DESC, gkey DESC`
  )
  .all(vol.volume_id)
const summaryMs = ms(t0)
const sumBuf = v8.serialize(summary)

// Plus the one page the grid actually shows.
t0 = process.hrtime.bigint()
const page = db
  .prepare(
    `SELECT ${COLS} FROM files WHERE volume_id = ? AND hidden = 0 AND trashed_at IS NULL
     ORDER BY substr(date,1,10) DESC, date DESC, path ASC LIMIT 200 OFFSET 0`
  )
  .all(vol.volume_id)
const pageMs = ms(t0)
const pageBuf = v8.serialize(page)

console.log('AFTER  files-updated carrying {drive, reason}:')
console.log(`  payload size               ~60 bytes`)
console.log(`  then: group summary        ${summaryMs.toFixed(0)} ms, ${(sumBuf.length / 1024).toFixed(0)} KB, ${summary.length} groups`)
console.log(`  then: one visible page     ${pageMs.toFixed(0)} ms, ${(pageBuf.length / 1024).toFixed(0)} KB, ${page.length} rows`)
console.log(`  TOTAL blocking            ${(summaryMs + pageMs).toFixed(0)} ms`)
