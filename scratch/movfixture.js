/** Disposable MOV/MP4 fixtures, including rotated ones, for thumbnail benchmarking. */
const { execFileSync } = require('child_process')
const fs = require('fs'), path = require('path')
const ffmpeg = require(path.join(__dirname,'..','node_modules','ffmpeg-static'))
const root = process.argv[2]
fs.mkdirSync(root, { recursive: true })
const made = []
function run(args){ execFileSync(ffmpeg, args, { stdio:'ignore', timeout: 120000 }) }
// A 1080p and a 4K clip: thumbnail cost scales with frame size, and the user's
// library is phone video, so 4K is the realistic case.
for (const [name, size, secs] of [['hd_1080p','1920x1080',6],['uhd_4k','3840x2160',6],['short_1s','1920x1080',1]]) {
  const f = path.join(root, name + '.mp4')
  run(['-y','-f','lavfi','-i',`testsrc2=size=${size}:rate=30:duration=${secs}`,'-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p',f])
  made.push(f)
}
// MOV container, and a MOV carrying a 90-degree display matrix - the case the
// current code spawns ffprobe for.
const srcHd = path.join(root,'hd_1080p.mp4')
const mov = path.join(root,'plain.mov'); run(['-y','-i',srcHd,'-c','copy',mov]); made.push(mov)
const rot = path.join(root,'rotated90.mov'); run(['-y','-i',srcHd,'-c','copy','-metadata:s:v','rotate=90',rot]); made.push(rot)
for (const f of made) console.log(`${path.basename(f)}\t${(fs.statSync(f).size/1048576).toFixed(1)} MB`)
