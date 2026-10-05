import { parentPort } from 'worker_threads'
import * as fs from 'fs'
import sharp from 'sharp'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const libheif = require('libheif-js/wasm-bundle')

/**
 * HEIC -> JPEG, off the main thread.
 *
 * HEVC has no decoder in sharp's libvips or the bundled ffmpeg, so this is
 * libheif compiled to WebAssembly. It used to run as heic-convert on the main
 * process: the asm.js build of libheif plus a pure-JS JPEG encoder, measured at
 * 6.5-6.8s of uninterrupted main-thread blocking per 24MP iPhone photo - every
 * HEIC tile froze the whole window, input included. Here the wasm build decodes
 * straight to RGBA and sharp resizes and encodes it, so the same file is ~3.7s
 * of this thread's time and none of the main thread's.
 */
interface Job {
  id: number
  input: string
  output: string
  /** Square cover crop to this many pixels, or the full image when absent. */
  size?: number
  quality: number
}

parentPort?.on('message', async (job: Job) => {
  try {
    const buf = await fs.promises.readFile(job.input)
    const decoder = new libheif.HeifDecoder()
    const images = decoder.decode(buf)
    try {
      if (!images.length) throw new Error('no decodable HEIF image')
      const image = images[0]
      const width = image.get_width()
      const height = image.get_height()
      const pixels: { data: Uint8ClampedArray } = await new Promise((resolve, reject) =>
        image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (d: unknown) =>
          d ? resolve(d as { data: Uint8ClampedArray }) : reject(new Error('HEIF decode failed'))
        )
      )
      let out = sharp(Buffer.from(pixels.data.buffer), { raw: { width, height, channels: 4 } })
      if (job.size) out = out.resize(job.size, job.size, { fit: 'cover', position: 'centre' })
      // Written beside the target and renamed, so a reader never sees half a JPEG.
      const tmp = `${job.output}.${process.pid}.tmp`
      await out.jpeg({ quality: job.quality }).toFile(tmp)
      await fs.promises.rename(tmp, job.output)
    } finally {
      for (const image of images) image.free()
      decoder.decoder?.delete?.()
    }
    parentPort?.postMessage({ id: job.id, ok: true })
  } catch (err) {
    parentPort?.postMessage({ id: job.id, ok: false, error: String(err) })
  }
})
