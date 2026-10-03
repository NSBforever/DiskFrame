/** Read-only: are thumbnails already on disk for rows whose thumb column is NULL? */
const Database = require('better-sqlite3')
const path = require('path'), fs = require('fs'), crypto = require('crypto')
const db = new Database(path.join(process.env.APPDATA,'diskframe','diskframe.db'),{readonly:true})
const thumbDir = path.join(process.env.APPDATA,'diskframe','thumbs')
const md5 = p => crypto.createHash('md5').update(p).digest('hex')
const THUMBABLE = ['.jpg','.jpeg','.png','.webp','.heic','.mp4','.mov','.m4v','.avi','.mkv','.wmv','.webm']
const PH = THUMBABLE.map(()=>'?').join(',')

const onDisk = new Set(fs.readdirSync(thumbDir))
console.log('thumb files on disk:', onDisk.size)

const nullRows = db.prepare(`SELECT path, ext, size, name FROM files WHERE (thumb IS NULL OR thumb='') AND ext IN (${PH}) AND trashed_at IS NULL`).all(...THUMBABLE)
console.log('rows with NULL thumb (thumbable):', nullRows.length)

let hit = 0, miss = 0, hitVideo = 0, hitPhoto = 0
const VID = new Set(['.mp4','.mov','.m4v','.avi','.mkv','.wmv','.webm'])
for (const r of nullRows) {
  if (onDisk.has(md5(r.path) + '.jpg')) { hit++; if (VID.has(r.ext)) hitVideo++; else hitPhoto++ }
  else miss++
}
console.log()
console.log('>>> NULL-thumb rows whose thumbnail ALREADY EXISTS on disk:', hit, `(${(hit/nullRows.length*100).toFixed(1)}%)`)
console.log('      of those, videos:', hitVideo, ' photos:', hitPhoto)
console.log('>>> NULL-thumb rows with genuinely no thumbnail file:     ', miss)
console.log()
// Of the genuine misses, how many are undecodable stubs?
let stub = 0, tiny = 0
for (const r of nullRows) {
  if (onDisk.has(md5(r.path)+'.jpg')) continue
  if (r.name.startsWith('._')) stub++
  else if (VID.has(r.ext) && r.size <= 16384) tiny++
}
console.log('genuine misses that are AppleDouble ._ stubs:', stub)
console.log('genuine misses that are <=16KB videos:      ', tiny)
console.log()
// Orphans: thumb files nothing references
const referenced = new Set()
for (const r of db.prepare("SELECT thumb FROM files WHERE thumb IS NOT NULL AND thumb != ''").all()) referenced.add(path.basename(r.thumb))
let orphan = 0
for (const f of onDisk) if (!referenced.has(f)) orphan++
console.log('thumb files referenced by a row:', referenced.size)
console.log('thumb files referenced by NOTHING:', orphan)
