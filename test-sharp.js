import sharp from 'sharp'
import * as path from 'path'

async function test() {
  const file = 'C:\\Windows\\Web\\Wallpaper\\Theme1\\img1.jpg' // some standard windows photo
  try {
    await sharp(file).resize(240, 240).jpeg().toFile('test-thumb.jpg')
    console.log('Success!')
  } catch (e) {
    console.error('Error:', e)
  }
}
test()
