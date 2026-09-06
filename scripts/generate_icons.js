import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const sourceImage = 'C:\\Users\\nagir\\.gemini\\antigravity-ide\\brain\\dbd73660-cd6b-4062-b4eb-cfc8fc75e075\\diskframe_app_logo_1784908873654.png';
const buildIconPng = 'build/icon.png';
const resourcesIconPng = 'resources/icon.png';
const buildIconIco = 'build/icon.ico';

async function createIco(pngBuffers, sizes) {
  const numImages = pngBuffers.length;
  const headerSize = 6;
  const directorySize = 16 * numImages;
  let dataOffset = headerSize + directorySize;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // Reserved
  header.writeUInt16LE(1, 2); // Type: 1 for ICO
  header.writeUInt16LE(numImages, 4); // Number of images

  const directories = [];
  for (let i = 0; i < numImages; i++) {
    const size = sizes[i];
    const buf = pngBuffers[i];
    const dir = Buffer.alloc(16);
    dir.writeUInt8(size >= 256 ? 0 : size, 0); // Width
    dir.writeUInt8(size >= 256 ? 0 : size, 1); // Height
    dir.writeUInt8(0, 2); // Palette colors (0 = no palette)
    dir.writeUInt8(0, 3); // Reserved
    dir.writeUInt16LE(1, 4); // Color planes
    dir.writeUInt16LE(32, 6); // Bits per pixel
    dir.writeUInt32LE(buf.length, 8); // Image data length
    dir.writeUInt32LE(dataOffset, 12); // Offset of image data
    directories.push(dir);
    dataOffset += buf.length;
  }

  return Buffer.concat([header, ...directories, ...pngBuffers]);
}

async function run() {
  console.log('Generating high-res PNG icon...');
  const base512 = await sharp(sourceImage)
    .resize(512, 512, { fit: 'cover' })
    .png()
    .toBuffer();

  fs.writeFileSync(buildIconPng, base512);
  fs.writeFileSync(resourcesIconPng, base512);
  console.log('Saved build/icon.png and resources/icon.png');

  const icoSizes = [256, 128, 64, 48, 32, 16];
  const pngBuffers = [];

  for (const sz of icoSizes) {
    const buf = await sharp(sourceImage)
      .resize(sz, sz, { fit: 'cover' })
      .png()
      .toBuffer();
    pngBuffers.push(buf);
  }

  const icoBuffer = await createIco(pngBuffers, icoSizes);
  fs.writeFileSync(buildIconIco, icoBuffer);
  console.log('Successfully generated build/icon.ico');
}

run().catch(err => {
  console.error('Error generating icons:', err);
  process.exit(1);
});
