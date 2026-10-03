/** Read-only census of thumbnail state. No scan, no writes, no cache changes. */
const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')
const db = new Database(path.join(process.env.APPDATA, 'diskframe', 'diskframe.db'), { readonly: true })
const VID = ['.mp4','.mov','.m4v','.avi','.mkv','.wmv','.webm']
const PH = VID.map(()=>'?').join(',')
const thumbDir = path.join(process.env.APPDATA, 'diskframe', 'thumbs')

const q = (sql, ...p) => db.prepare(sql).get(...p)
console.log('total rows            ', q('SELECT COUNT(*) n FROM files').n)
console.log('videos                ', q(`SELECT COUNT(*) n FROM files WHERE ext IN (${PH})`, ...VID).n)
console.log('videos w/ thumb set   ', q(`SELECT COUNT(*) n FROM files WHERE ext IN (${PH}) AND thumb IS NOT NULL AND thumb != ''`, ...VID).n)
console.log('videos w/o thumb      ', q(`SELECT COUNT(*) n FROM files WHERE ext IN (${PH}) AND (thumb IS NULL OR thumb = '')`, ...VID).n)
console.log('photos w/o thumb      ', q(`SELECT COUNT(*) n FROM files WHERE ext IN ('.jpg','.jpeg','.png','.webp','.heic') AND (thumb IS NULL OR thumb='')`).n)
console.log()
console.log('--- videos without a thumb, by volume ---')
for (const r of db.prepare(`SELECT IFNULL(substr(volume_id,12,8),'NULL') v, COUNT(*) n FROM files WHERE ext IN (${PH}) AND (thumb IS NULL OR thumb='') GROUP BY v ORDER BY n DESC`).all(...VID)) console.log('  ', r.v, r.n)
console.log()
console.log('--- AppleDouble (._*) stubs indexed as media ---')
console.log('  total   ', q("SELECT COUNT(*) n FROM files WHERE name LIKE '._%'").n)
console.log('  videos  ', q(`SELECT COUNT(*) n FROM files WHERE name LIKE '._%' AND ext IN (${PH})`, ...VID).n)
console.log('  size<=8k', q("SELECT COUNT(*) n FROM files WHERE name LIKE '._%' AND size <= 8192").n)
console.log()
console.log('--- thumb column points at a file that is GONE from disk (sampled 4000) ---')
const rows = db.prepare(`SELECT path, thumb FROM files WHERE thumb IS NOT NULL AND thumb != '' LIMIT 4000`).all()
let missing = 0
for (const r of rows) if (!fs.existsSync(r.thumb)) missing++
console.log(`  ${missing} of ${rows.length} sampled thumb paths do not exist`)
console.log()
console.log('--- thumbs dir ---')
const files = fs.existsSync(thumbDir) ? fs.readdirSync(thumbDir) : []
let bytes = 0
for (const f of files.slice(0, 50000)) { try { bytes += fs.statSync(path.join(thumbDir, f)).size } catch {} }
console.log(`  ${files.length} files, ${(bytes/1048576).toFixed(0)} MB`)
console.log('  rows referencing a thumb:', q("SELECT COUNT(*) n FROM files WHERE thumb IS NOT NULL AND thumb != ''").n)
