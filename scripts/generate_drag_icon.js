const fs = require('fs')
const path = require('path')
const sharp = require(path.join(__dirname, '../node_modules/sharp'))

const targetPath = path.join(__dirname, '../resources/drag-icon.png')

async function createDragIcon() {
  const svg = `
  <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="48" height="48" rx="8" fill="#E11D2E"/>
    <polygon points="18,14 34,24 18,34" fill="#FFFFFF"/>
  </svg>
  `
  await sharp(Buffer.from(svg))
    .png()
    .toFile(targetPath)
  console.log("Created drag-icon.png at:", targetPath, "size:", fs.statSync(targetPath).size)
}

createDragIcon().catch(console.error)
