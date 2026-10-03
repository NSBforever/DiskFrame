/**
 * Re-measures the shipped video-thumbnail command against the one it replaced,
 * on the same disposable fixtures. Bounded: 5 files, no real drive touched.
 */
const { spawnSync } = require('child_process')
const fs = require('fs'), path = require('path')
const ffmpeg = require(path.join(__dirname,'..','node_modules','ffmpeg-static'))
const ffprobe = require(path.join(__dirname,'..','node_modules','ffprobe-static')).path
const sharp = require(path.join(__dirname,'..','node_modules','sharp'))
const root = process.argv[2]
const tmp = path.join(root,'_b2'); fs.rmSync(tmp,{recursive:true,force:true}); fs.mkdirSync(tmp,{recursive:true})
const files = fs.readdirSync(root).filter(f=>/\.(mp4|mov)$/i.test(f)).map(f=>path.join(root,f))
const ms = t0 => Number(process.hrtime.bigint()-t0)/1e6
const SIZE = 300
const VF = `scale=${SIZE}:${SIZE}:force_original_aspect_ratio=increase,crop=${SIZE}:${SIZE}`

async function oldWay(src,i){
  const png = path.join(tmp,`o${i}.png`), out = path.join(tmp,`o${i}.jpg`)
  const t0 = process.hrtime.bigint(); let spawns = 0
  let r = spawnSync(ffmpeg,['-ss','0.2','-i',src,'-vframes','1','-f','image2','-q:v','2','-threads','1','-y',png],{stdio:'ignore',timeout:30000}); spawns++
  if(r.status!==0||!fs.existsSync(png)){ spawnSync(ffmpeg,['-ss','0','-i',src,'-vframes','1','-f','image2','-q:v','2','-threads','1','-y',png],{stdio:'ignore',timeout:30000}); spawns++ }
  const png0 = fs.existsSync(png)?fs.statSync(png).size:0
  if(src.toLowerCase().endsWith('.mov')){ spawnSync(ffprobe,['-v','error','-select_streams','v:0','-show_streams','-of','json',src],{encoding:'utf8',timeout:20000}); spawns++ }
  await sharp(png).rotate().resize(SIZE,SIZE,{fit:'cover',position:'centre'}).jpeg({quality:80}).toFile(out)
  try{fs.unlinkSync(png)}catch{}
  return { totalMs: ms(t0), spawns, tempBytes: png0 }
}
function newWay(src,i){
  const out = path.join(tmp,`n${i}.jpg`)
  const t0 = process.hrtime.bigint(); let spawns = 0
  let r = spawnSync(ffmpeg,['-ss','0.2','-i',src,'-vframes','1','-vf',VF,'-f','image2','-vcodec','mjpeg','-q:v','4','-threads','1','-y',out],{stdio:'ignore',timeout:30000}); spawns++
  if(r.status!==0||!fs.existsSync(out)||fs.statSync(out).size===0){ spawnSync(ffmpeg,['-ss','0','-i',src,'-vframes','1','-vf',VF,'-f','image2','-vcodec','mjpeg','-q:v','4','-threads','1','-y',out],{stdio:'ignore',timeout:30000}); spawns++ }
  return { totalMs: ms(t0), spawns, tempBytes: 0 }
}
;(async()=>{
  let so=0,sn=0,tempTotal=0
  console.log('file'.padEnd(16),'BEFORE ms'.padStart(10),'spawns'.padStart(7),'tempPNG'.padStart(9),'|','AFTER ms'.padStart(9),'spawns'.padStart(7),'|','gain'.padStart(6))
  for(let i=0;i<files.length;i++){
    const o=await oldWay(files[i],i), n=newWay(files[i],i)
    so+=o.totalMs; sn+=n.totalMs; tempTotal+=o.tempBytes
    console.log(path.basename(files[i]).padEnd(16),o.totalMs.toFixed(0).padStart(10),String(o.spawns).padStart(7),
      ((o.tempBytes/1048576).toFixed(2)+'MB').padStart(9),'|',n.totalMs.toFixed(0).padStart(9),String(n.spawns).padStart(7),'|',(o.totalMs/n.totalMs).toFixed(2)+'x')
  }
  console.log()
  console.log(`mean per file: before ${(so/files.length).toFixed(0)}ms  after ${(sn/files.length).toFixed(0)}ms  (${(so/sn).toFixed(2)}x)`)
  console.log(`temp PNG bytes written: before ${(tempTotal/1048576).toFixed(1)}MB  after 0MB`)
  console.log(`projected time to fill a 30-tile viewport at concurrency 2:`)
  console.log(`  before ${(15*so/files.length/1000).toFixed(1)}s   after ${(15*sn/files.length/1000).toFixed(1)}s`)
})()
