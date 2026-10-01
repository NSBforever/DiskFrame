/**
 * Bounded investigation of the repeated video tiles reported on April 27 and
 * April 30. Reads the real database READ-ONLY. No scanning, no writes, nothing
 * deleted or hidden.
 */
const Database = require('better-sqlite3')
const path = require('path')
const crypto = require('crypto')

const db = new Database(path.join(process.env.APPDATA, 'diskframe', 'diskframe.db'), {
  readonly: true
})

const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.m4v', '.webm']
// The app's own thumbnail cache key, so a shared thumbnail can be told apart
// from a shared path. See makeHash() in scanner.ts.
const makeHash = (p) => crypto.createHash('md5').update(p).digest('hex')
const shortVol = (v) => (v ? v.slice(11, 19) : 'NULL')

console.log('=== schema: what is actually unique? ===')
for (const r of db
  .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='files'")
  .all()) {
  console.log(' ', r.name, '::', (r.sql || '(implicit)').replace(/\s+/g, ' '))
}
console.log()

console.log('=== every video dated 27 or 30 April, any year, any volume ===')
const ph = VIDEO_EXTS.map(() => '?').join(',')
const rows = db
  .prepare(
    `SELECT rowid, path, name, ext, size, mtime, date, year, month, drive, volume_id, thumb,
            favourited, trashed_at, hidden
     FROM files
     WHERE ext IN (${ph}) AND (substr(date,6,5) = '04-27' OR substr(date,6,5) = '04-30')
     ORDER BY date DESC, path ASC`
  )
  .all(...VIDEO_EXTS)
console.log('  rows:', rows.length)
for (const r of rows) {
  const keyOk = r.thumb ? path.basename(r.thumb) === makeHash(r.path) + '.jpg' : 'no-thumb'
  console.log(
    `  [rowid ${r.rowid}] ${r.date} ${r.drive} vol=${shortVol(r.volume_id)} size=${r.size} mtime=${r.mtime} hidden=${r.hidden} trashed=${r.trashed_at ? 'Y' : 'N'} fav=${r.favourited}`
  )
  console.log(`      path : ${r.path}`)
  console.log(`      thumb: ${r.thumb ? path.basename(r.thumb) : null}  keyMatchesMd5(path)=${keyOk}`)
}
console.log()

console.log('=== CASE 2a: more than one record for the same (volume_id, path) ===')
const samePath = db
  .prepare(
    `SELECT volume_id, path, COUNT(*) n, GROUP_CONCAT(rowid) rowids
     FROM files GROUP BY volume_id, path HAVING n > 1 ORDER BY n DESC LIMIT 20`
  )
  .all()
console.log('  duplicate (volume_id, path) groups:', samePath.length)
for (const d of samePath) console.log('   ', d.n, 'x', d.path, '| rowids', d.rowids)
console.log()

console.log('=== CASE 2b: same path recorded under DIFFERENT volume ids ===')
const crossVol = db
  .prepare(
    `SELECT path, COUNT(DISTINCT IFNULL(volume_id,'<null>')) v, COUNT(*) n,
            GROUP_CONCAT(IFNULL(volume_id,'<null>')) vols, GROUP_CONCAT(rowid) rowids
     FROM files GROUP BY path HAVING v > 1 ORDER BY n DESC LIMIT 20`
  )
  .all()
console.log('  paths present under more than one volume id:', crossVol.length)
for (const d of crossVol) console.log('   ', d.path, '->', d.vols, '| rowids', d.rowids)
console.log()

console.log('=== CASE 3a: one thumbnail file shared by several records ===')
const sharedThumb = db
  .prepare(
    `SELECT thumb, COUNT(*) n FROM files WHERE thumb IS NOT NULL AND thumb != ''
     GROUP BY thumb HAVING n > 1 ORDER BY n DESC LIMIT 15`
  )
  .all()
console.log('  thumbnails referenced by >1 record:', sharedThumb.length)
for (const d of sharedThumb) {
  const members = db
    .prepare(`SELECT rowid, path, size, volume_id FROM files WHERE thumb = ?`)
    .all(d.thumb)
  console.log('   ', d.n, 'records share', path.basename(d.thumb))
  for (const m of members) {
    console.log(`        [${m.rowid}] ${m.path} size=${m.size} vol=${shortVol(m.volume_id)}`)
  }
}
console.log()

console.log('=== CASE 3b: thumb filename disagrees with md5(path) ===')
const thumbed = db.prepare(`SELECT rowid, path, thumb FROM files WHERE thumb LIKE '%.jpg'`).all()
let bad = 0
for (const r of thumbed) {
  if (path.basename(r.thumb) !== makeHash(r.path) + '.jpg') {
    bad++
    if (bad <= 10) {
      console.log(
        `    MISMATCH [${r.rowid}] ${r.path}\n       has ${path.basename(r.thumb)} expected ${makeHash(r.path)}.jpg`
      )
    }
  }
}
console.log(`  checked ${thumbed.length} thumbnailed rows, ${bad} key mismatches`)
console.log()

console.log('=== CASE 4 pre-check: same (volume, size, mtime) at different paths ===')
const sameContentish = db
  .prepare(
    `SELECT volume_id, size, mtime, COUNT(*) n, GROUP_CONCAT(rowid) rowids
     FROM files WHERE ext IN (${ph}) AND size > 0
     GROUP BY volume_id, size, mtime HAVING n > 1 ORDER BY n DESC LIMIT 15`
  )
  .all(...VIDEO_EXTS)
console.log('  video groups sharing (volume, size, mtime):', sameContentish.length)
for (const d of sameContentish) {
  const members = db
    .prepare(`SELECT rowid, path, date FROM files WHERE rowid IN (${d.rowids})`)
    .all()
  console.log(`   ${d.n} videos, size=${d.size} mtime=${d.mtime} vol=${shortVol(d.volume_id)}`)
  for (const m of members) console.log(`        [${m.rowid}] ${m.date}  ${m.path}`)
}
