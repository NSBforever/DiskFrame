/**
 * Bounded micro-benchmark: what one video thumbnail costs, current pipeline vs
 * letting ffmpeg scale and encode directly. Disposable fixtures only.
 */
const { execFileSync, spawnSync } = require('child_process')
const fs = require('fs'), path = require('path'), crypto = require('crypto')
const ffmpeg = require(path.join(__dirname,'..','node_modules','ffmpeg-static'))
const ffprobe = require(path.join(__dirname,'..','node_modules','ffprobe-static')).path
const sharp = require(path.join(__dirname,'..','node_modules','sharp'))

const root = process.argv[2]
const tmp = path.join(root, '_out'); fs.rmSync(tmp,{recursive:true,force:true}); fs.mkdirSync(tmp,{recursive:true})
const files = fs.readdirSync(root).filter(f=>/\.(mp4|mov)$/i.test(f)).map(f=>path.join(root,f))
const ms = t0 => Number(process.hrtime.bigint()-t0)/1e6
const hr = () => process.hrtime.bigint()

/** CURRENT: ffmpeg -> full-res PNG, ffprobe for rotation (mov), sharp resize. */
async function current(src, i) {
  const t = { spawns: 0 }
  const frame = path.join(tmp, `cur_${i}.png`)
  let t0 = hr()
  let r = spawnSync(ffmpeg, ['-ss','0.2','-i',src,'-vframes','1','-f','image2','-q:v','2','-threads','1','-y',frame], {stdio:'ignore', timeout:30000})
  t.spawns++
  if (r.status !== 0 || !fs.existsSync(frame)) {
    spawnSync(ffmpeg, ['-ss','0','-i',src,'-vframes','1','-f','image2','-q:v','2','-threads','1','-y',frame], {stdio:'ignore', timeout:30000}); t.spawns++
  }
  t.extractMs = ms(t0)
  t.framePngBytes = fs.existsSync(frame) ? fs.statSync(frame).size : 0

  t0 = hr()
  if (src.toLowerCase().endsWith('.mov')) {
    spawnSync(ffprobe, ['-v','error','-select_streams','v:0','-show_entries','stream_side_data=rotation:stream_tags=rotate','-of','json',src], {encoding:'utf8', timeout:20000})
    t.spawns++
  }
  t.probeMs = ms(t0)

  t0 = hr()
  const out = path.join(tmp, `cur_${i}.jpg`)
  await sharp(frame).rotate().resize(300,300,{fit:'cover',position:'centre'}).jpeg({quality:80}).toFile(out)
  t.sharpMs = ms(t0)
  t.outBytes = fs.statSync(out).size
  try { fs.unlinkSync(frame) } catch {}
  t.totalMs = t.extractMs + t.probeMs + t.sharpMs
  return t
}

/** PROPOSED: one ffmpeg spawn, scaled + cropped + JPEG straight out. */
function proposed(src, i) {
  const t = { spawns: 0 }
  const out = path.join(tmp, `new_${i}.jpg`)
  const vf = 'scale=300:300:force_original_aspect_ratio=increase,crop=300:300'
  let t0 = hr()
  let r = spawnSync(ffmpeg, ['-ss','0.2','-i',src,'-vframes','1','-vf',vf,'-f','image2','-vcodec','mjpeg','-q:v','4','-threads','1','-y',out], {stdio:'ignore', timeout:30000})
  t.spawns++
  if (r.status !== 0 || !fs.existsSync(out) || fs.statSync(out).size === 0) {
    spawnSync(ffmpeg, ['-ss','0','-i',src,'-vframes','1','-vf',vf,'-f','image2','-vcodec','mjpeg','-q:v','4','-threads','1','-y',out], {stdio:'ignore', timeout:30000}); t.spawns++
  }
  t.totalMs = ms(t0)
  t.outBytes = fs.existsSync(out) ? fs.statSync(out).size : 0
  return t
}

;(async () => {
  console.log('file'.padEnd(18), 'CURRENT ms'.padStart(11), 'spawns'.padStart(7), 'tempPNG'.padStart(10), '|', 'NEW ms'.padStart(8), 'spawns'.padStart(7), '|', 'speedup'.padStart(8))
  let sumCur = 0, sumNew = 0
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    const c = await current(f, i)
    const n = proposed(f, i)
    sumCur += c.totalMs; sumNew += n.totalMs
    console.log(
      path.basename(f).padEnd(18),
      c.totalMs.toFixed(0).padStart(11), String(c.spawns).padStart(7),
      ((c.framePngBytes/1048576).toFixed(1)+'MB').padStart(10), '|',
      n.totalMs.toFixed(0).padStart(8), String(n.spawns).padStart(7), '|',
      (c.totalMs/n.totalMs).toFixed(1)+'x'
    )
  }
  console.log()
  console.log(`TOTAL  current ${sumCur.toFixed(0)}ms   new ${sumNew.toFixed(0)}ms   speedup ${(sumCur/sumNew).toFixed(1)}x`)
  console.log(`per-file mean: current ${(sumCur/files.length).toFixed(0)}ms  new ${(sumNew/files.length).toFixed(0)}ms`)
})()
