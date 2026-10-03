const { spawnSync } = require('child_process')
const fs=require('fs'), path=require('path')
const ffmpeg = require(path.join(__dirname,'..','node_modules','ffmpeg-static'))
const root = process.argv[2]
const tmp = path.join(root,'_diag'); fs.rmSync(tmp,{recursive:true,force:true}); fs.mkdirSync(tmp,{recursive:true})
const ms = t0 => Number(process.hrtime.bigint()-t0)/1e6

function probeSize(file){
  const r = spawnSync(ffmpeg, ['-hide_banner','-i',file], {encoding:'utf8'})
  const m = (r.stderr||'').match(/,\s(\d+)x(\d+)/)
  return m ? `${m[1]}x${m[2]}` : '?'
}

console.log('=== 1. does ffmpeg autorotate when scaling? (rotated90.mov is a 1920x1080 with rotate=90) ===')
for (const [label, extra] of [['default (autorotate on)',[]], ['-noautorotate',['-noautorotate']]]) {
  const out = path.join(tmp,`rot_${label.replace(/\W/g,'')}.jpg`)
  spawnSync(ffmpeg, ['-ss','0.2',...extra,'-i',path.join(root,'rotated90.mov'),'-vframes','1','-vf','scale=300:-1','-f','image2','-vcodec','mjpeg','-y',out], {stdio:'ignore'})
  console.log(`  ${label.padEnd(26)} -> ${probeSize(out)}   (portrait 300x533 means rotation WAS applied)`)
}

console.log()
console.log('=== 2. is the 0.2s pre-input seek reliable? (per file, 20 runs) ===')
for (const f of fs.readdirSync(root).filter(x=>/\.(mp4|mov)$/i.test(x))) {
  const src = path.join(root,f)
  let ok=0, t=0
  for (let i=0;i<20;i++){
    const out=path.join(tmp,`seek_${i}.jpg`)
    const t0=process.hrtime.bigint()
    const r=spawnSync(ffmpeg,['-ss','0.2','-i',src,'-vframes','1','-vf','scale=300:300:force_original_aspect_ratio=increase,crop=300:300','-f','image2','-vcodec','mjpeg','-q:v','4','-threads','1','-y',out],{stdio:'ignore',timeout:30000})
    t+=ms(t0)
    if(r.status===0 && fs.existsSync(out) && fs.statSync(out).size>0) ok++
  }
  console.log(`  ${f.padEnd(18)} first-seek success ${ok}/20   mean ${(t/20).toFixed(0)}ms`)
}

console.log()
console.log('=== 3. what does an UNDECODABLE file cost? (AppleDouble ._ stub shape: 4KB of junk) ===')
const stub = path.join(tmp,'._fake.mov'); fs.writeFileSync(stub, Buffer.alloc(4096, 7))
for (const [label,args] of [['attempt at 0.2s',['-ss','0.2']],['attempt at 0s',['-ss','0']]]) {
  const out=path.join(tmp,'stub.jpg')
  const t0=process.hrtime.bigint()
  const r=spawnSync(ffmpeg,[...args,'-i',stub,'-vframes','1','-f','image2','-vcodec','mjpeg','-y',out],{stdio:'ignore',timeout:30000})
  console.log(`  ${label.padEnd(18)} status=${r.status} ${ms(t0).toFixed(0)}ms`)
}
console.log('  -> a stub costs BOTH attempts every time it is tried, and there are 3,022 of them in the catalogue')
