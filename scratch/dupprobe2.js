/**
 * Follow-up: what record identity actually exists, and do the two paths in each
 * reported pair both exist on disk right now? READ-ONLY, bounded to the pairs.
 */
const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

const db = new Database(path.join(process.env.APPDATA, 'diskframe', 'diskframe.db'), {
  readonly: true
})

console.log('=== CREATE TABLE files ===')
console.log(
  db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='files'").get().sql
)
console.log()
console.log('=== is there a stable per-record id? ===')
const probe = db.prepare('SELECT rowid AS rid, path FROM files LIMIT 1').get()
console.log('  rowid available:', probe && probe.rid !== undefined, '->', probe && probe.rid)
console.log()

// The pairs reported on screen: April 30 (2) and April 27 (3), 2025, drive D:.
const PAIRS = [
  [
    'D:\\Transfer\\March 8th - June mid 2025 Safety Transfer\\2025_04_30_19_37_IMG_5419.MOV',
    'D:\\iPhone Safety Transfers\\Transfer\\2025_04_30_19_37_IMG_5419.MOV'
  ],
  [
    'D:\\Transfer\\March 8th - June mid 2025 Safety Transfer\\2025_04_30_19_34_IMG_5418.MP4',
    'D:\\iPhone Safety Transfers\\Transfer\\2025_04_30_19_34_IMG_5418.MP4'
  ],
  [
    'D:\\Transfer\\March 8th - June mid 2025 Safety Transfer\\2025_04_28_00_36_IMG_5333.MP4',
    'D:\\iPhone Safety Transfers\\Transfer\\2025_04_28_00_36_IMG_5333.MP4'
  ],
  [
    'D:\\Transfer\\March 8th - June mid 2025 Safety Transfer\\2025_04_27_18_19_IMG_5311.MOV',
    'D:\\iPhone Safety Transfers\\Transfer\\2025_04_27_18_19_IMG_5311.MOV'
  ],
  [
    'D:\\Transfer\\March 8th - June mid 2025 Safety Transfer\\2025_04_27_16_53_IMG_5304.MOV',
    'D:\\iPhone Safety Transfers\\Transfer\\2025_04_27_16_53_IMG_5304.MOV'
  ]
]

const ffprobe = (() => {
  try {
    const p = require(path.join(__dirname, '..', 'node_modules', 'ffprobe-static')).path
    return p
  } catch {
    return null
  }
})()

function duration(p) {
  if (!ffprobe || !fs.existsSync(p)) return null
  try {
    const out = execFileSync(
      ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p],
      { encoding: 'utf8', timeout: 20000 }
    )
    return Number(out.trim()).toFixed(3)
  } catch {
    return 'probe-failed'
  }
}

const row = db.prepare(
  `SELECT rowid AS rid, path, name, size, mtime, date, volume_id, thumb, favourited, trashed_at
   FROM files WHERE path = ?`
)

console.log('=== the five reported pairs, side by side ===')
for (const [a, b] of PAIRS) {
  console.log('\n--- pair ---')
  for (const p of [a, b]) {
    const r = row.get(p)
    const onDisk = fs.existsSync(p)
    let st = null
    try {
      st = onDisk ? fs.statSync(p) : null
    } catch {
      /* unreadable */
    }
    console.log(`  path            : ${p}`)
    if (!r) {
      console.log('  NO CATALOGUE RECORD')
      continue
    }
    console.log(`  rowid           : ${r.rid}`)
    console.log(`  volume_id       : ${r.volume_id}`)
    console.log(`  volume-relative : ${r.path.slice(2)}`)
    console.log(`  db size / mtime : ${r.size} / ${r.mtime}`)
    console.log(`  on disk         : ${onDisk}${st ? ` size=${st.size} mtime=${Math.round(st.mtimeMs)}` : ''}`)
    console.log(`  thumb key       : ${r.thumb ? path.basename(r.thumb) : null}`)
    console.log(`  thumb source    : ${r.thumb ?? '(none)'}`)
    console.log(`  duration (s)    : ${duration(p)}`)
    console.log(`  fav / trashed   : ${r.favourited} / ${r.trashed_at ?? 'no'}`)
  }
}

// Are these two folder trees broadly the same set of files? That decides whether
// this is a handful of copies or a whole duplicated tree the user may not know
// about. Counted from the catalogue only - no walking.
console.log('\n=== how large is the overlap between the two D: trees? ===')
const treeA = 'D:\\Transfer\\March 8th - June mid 2025 Safety Transfer\\'
const treeB = 'D:\\iPhone Safety Transfers\\Transfer\\'
const names = (prefix) =>
  new Set(
    db
      .prepare(`SELECT name FROM files WHERE path LIKE ? || '%'`)
      .all(prefix)
      .map((r) => r.name)
  )
const A = names(treeA)
const B = names(treeB)
let shared = 0
for (const n of A) if (B.has(n)) shared++
console.log(`  ${treeA} : ${A.size} distinct filenames`)
console.log(`  ${treeB} : ${B.size} distinct filenames`)
console.log(`  filenames present in BOTH: ${shared}`)
