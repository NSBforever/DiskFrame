// Reads out/main/index.js straight out of an app.asar (header JSON + offsets) and prints the baked build commit.
const fs = require('fs')
const f = process.argv[2], buf = fs.readFileSync(f)
const hsize = buf.readUInt32LE(12), header = JSON.parse(buf.slice(16, 16 + hsize).toString())
const base = 8 + buf.readUInt32LE(4)
let node = header; for (const p of ['out', 'main', 'index.js']) node = node.files[p]
const src = buf.slice(base + Number(node.offset), base + Number(node.offset) + node.size).toString()
const m = src.match(/buildCommit:\s*"([^"]+)"/)
console.log(f, '-> buildCommit', m ? m[1] : '?', '| has reconcile:', src.includes('reconcileWorker'), '| has revealMpv:', src.includes('mpv-reveal'))
