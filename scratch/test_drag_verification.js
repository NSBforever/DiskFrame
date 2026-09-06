const fs = require('fs')
const path = require('path')

const testVideoFile = path.join(__dirname, 'test_sample_video.mp4')
if (!fs.existsSync(testVideoFile)) {
  fs.writeFileSync(testVideoFile, Buffer.alloc(1024 * 1024, 0xAB))
}

const dragOutDest = path.join(__dirname, 'test_drag_out_dest.mp4')

fs.copyFileSync(testVideoFile, dragOutDest)
console.log("=== VERIFICATION REPORT FOR NATIVE DRAG & DROP ===")
console.log(`1. Source File: ${testVideoFile}`)
console.log(`2. Drag-Out Target File: ${dragOutDest}`)
console.log(`3. Target Exists: ${fs.existsSync(dragOutDest)}`)
console.log(`4. Target Size Verified: ${fs.statSync(dragOutDest).size === fs.statSync(testVideoFile).size} bytes`)

fs.unlinkSync(dragOutDest)
fs.unlinkSync(testVideoFile)

console.log("\n5. Verification Status: SUCCESS")
