/**
 * Builds a small disposable media tree for first-use testing.
 *
 * Real decodable JPEGs and real MP4s, because the point is to exercise the
 * production thumbnail path (sharp and ffmpeg) rather than to count rows. Sizes
 * are set above the scanner's MIN_PHOTO_SIZE so nothing is filtered out, and
 * mtimes are spread across several years so the day-grouping has real groups.
 *
 * Writes nothing outside the directory given on the command line.
 *
 * Usage: electron (ELECTRON_RUN_AS_NODE=1) scratch/makefixture.js <dir> [photos] [videos]
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const root = process.argv[2]
const nPhotos = Number(process.argv[3] || 300)
const nVideos = Number(process.argv[4] || 12)
if (!root) {
  console.error('usage: makefixture.js <dir> [photos] [videos]')
  process.exit(1)
}

const sharp = require(path.join(__dirname, '..', 'node_modules', 'sharp'))
const ffmpeg = require(path.join(__dirname, '..', 'node_modules', 'ffmpeg-static'))

fs.mkdirSync(root, { recursive: true })

// A few nested folders, so the walk has real depth to cover.
const folders = ['2023/january', '2023/june', '2024/trip/day1', '2024/trip/day2', '2025/family', 'docs']
for (const f of folders) fs.mkdirSync(path.join(root, f), { recursive: true })

function mtimeFor(i) {
  // Spread across 2023-2025 so day/month/year grouping all have many groups.
  const base = Date.UTC(2023, 0, 1)
  const span = Date.UTC(2025, 11, 31) - base
  return new Date(base + Math.floor((i / Math.max(1, nPhotos)) * span) + i * 1000)
}

;(async () => {
  let made = 0
  for (let i = 0; i < nPhotos; i++) {
    const folder = folders[i % (folders.length - 1)] // keep 'docs' for documents
    const file = path.join(root, folder, `photo_${String(i).padStart(4, '0')}.jpg`)
    // 420x420 of noise: compresses poorly, so it clears MIN_PHOTO_SIZE (50KB)
    // the way a real photo does instead of being skipped as a sliver.
    const px = 420
    const buf = Buffer.alloc(px * px * 3)
    for (let b = 0; b < buf.length; b++) buf[b] = (Math.random() * 256) | 0
    await sharp(buf, { raw: { width: px, height: px, channels: 3 } })
      .jpeg({ quality: 92 })
      .toFile(file)
    const t = mtimeFor(i)
    fs.utimesSync(file, t, t)
    made++
  }

  for (let i = 0; i < nVideos; i++) {
    const file = path.join(root, folders[i % (folders.length - 1)], `clip_${i}.mp4`)
    // 1s of colour bars. Real container, real keyframe - ffmpeg has to actually
    // decode a frame to produce the thumbnail, which is the slow path we care
    // about ordering correctly.
    execFileSync(
      ffmpeg,
      ['-y', '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=10:duration=1`, '-pix_fmt', 'yuv420p', file],
      { stdio: 'ignore' }
    )
    const t = mtimeFor(i * 7)
    fs.utimesSync(file, t, t)
    made++
  }

  for (let i = 0; i < 6; i++) {
    const file = path.join(root, 'docs', `notes_${i}.pdf`)
    fs.writeFileSync(file, '%PDF-1.4\n% disposable test fixture\n')
    const t = mtimeFor(i * 11)
    fs.utimesSync(file, t, t)
    made++
  }

  // Photos specifically: the scanner's MIN_PHOTO_SIZE filter only applies to
  // them, and readdir sorts clip_*.mp4 ahead of photo_*.jpg.
  const sizes = fs
    .readdirSync(path.join(root, folders[0]))
    .filter((f) => f.endsWith('.jpg'))
    .map((f) => fs.statSync(path.join(root, folders[0], f)).size)
  console.log(
    JSON.stringify(
      {
        root,
        filesCreated: made,
        photos: nPhotos,
        videos: nVideos,
        docs: 6,
        samplePhotoBytes: sizes[0] ?? null,
        clearsMinPhotoSize: (sizes[0] ?? 0) > 50 * 1024
      },
      null,
      2
    )
  )
})().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
