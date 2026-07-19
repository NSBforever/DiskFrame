import Database from 'better-sqlite3'
import sharp from 'sharp'
import * as path from 'path'

const dbPath = path.join(process.env.APPDATA || '', 'diskframe', 'diskframe.db')
const db = new Database(dbPath)

const row = db
  .prepare("SELECT path FROM files WHERE ext IN ('.jpg', '.jpeg', '.png') LIMIT 1")
  .get()
console.log('Found row:', row)

async function test(file) {
  try {
    const res = await sharp(file)
      .rotate()
      .resize(240, 240, { fit: 'cover' })
      .jpeg({ quality: 75 })
      .toBuffer()
    console.log('Success! size:', res.length)
  } catch (e) {
    console.error('Sharp error:', e)
  }
}

if (row && row.path) {
  test(row.path)
} else {
  console.log('No photos in DB.')
}
