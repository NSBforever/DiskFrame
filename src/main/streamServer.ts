import * as http from 'http'
import * as fs from 'fs'
import { extname } from 'path'
import { spawn, ChildProcess } from 'child_process'
import ffmpegStaticPath from 'ffmpeg-static'

function resolveFfmpeg(): string {
  try {
    const p = ffmpegStaticPath
    if (p) {
      const candidates = [
        p.replace('app.asar', 'app.asar.unpacked'),
        p,
        p + '.exe'
      ]
      for (const c of candidates) if (fs.existsSync(c)) return c
    }
  } catch {}
  return 'ffmpeg'
}
const ffmpegExe = resolveFfmpeg()

function resolveFfprobe(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffprobeStatic = require('ffprobe-static')
    const p = ffprobeStatic?.path as string
    if (p) {
      const candidates = [
        p.replace('app.asar', 'app.asar.unpacked'),
        p,
        p + '.exe'
      ]
      for (const c of candidates) if (fs.existsSync(c)) return c
    }
  } catch {}
  return 'ffprobe'
}
const ffprobeExe = resolveFfprobe()

export interface MediaProbeResult {
  duration: number
  videoCodec: string
  audioCodec: string
  pixFmt: string
  width: number
  height: number
  isNative: boolean
  isRemux: boolean
  isAudioNative: boolean
}

let server: http.Server | null = null
let serverPort = 0
let activeProcess: ChildProcess | null = null

export function killActiveStream(): void {
  if (activeProcess) {
    try {
      activeProcess.kill('SIGKILL')
    } catch {}
    activeProcess = null
  }
}

export async function probeMedia(filePath: string): Promise<MediaProbeResult> {
  return new Promise((resolve) => {
    // Try ffprobe first for structured JSON metadata
    const ffprobeProc = spawn(ffprobeExe, [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath
    ])

    let stdout = ''
    let ffprobeErr = false

    ffprobeProc.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    ffprobeProc.on('error', () => {
      ffprobeErr = true
    })

    ffprobeProc.on('close', (code) => {
      if (!ffprobeErr && code === 0 && stdout.trim().length > 0) {
        try {
          const data = JSON.parse(stdout)
          const streams = data.streams || []
          const format = data.format || {}

          const videoStream = streams.find((s: { codec_type?: string }) => s.codec_type === 'video')
          const audioStream = streams.find((s: { codec_type?: string }) => s.codec_type === 'audio')

          const videoCodec = (videoStream?.codec_name || '').toLowerCase()
          const audioCodec = (audioStream?.codec_name || '').toLowerCase()
          const pixFmt = (videoStream?.pix_fmt || '').toLowerCase()
          const width = parseInt(videoStream?.width || '0', 10)
          const height = parseInt(videoStream?.height || '0', 10)
          const duration = parseFloat(format.duration || videoStream?.duration || '0')

          const ext = extname(filePath).toLowerCase()

          const isChromiumVideo = ['h264', 'avc', 'avc1', 'vp8', 'vp9', 'av1'].some((c) =>
            videoCodec.includes(c)
          )
          const isChromiumAudio =
            !audioCodec || ['aac', 'mp3', 'opus', 'vorbis', 'flac'].some((c) => audioCodec.includes(c))
          const isYuv420p = !pixFmt || (pixFmt.includes('yuv420p') && !pixFmt.includes('yuv420p10'))

          const isMp4 = ext === '.mp4'
          const isNative = isMp4 && (videoCodec.includes('h264') || videoCodec.includes('avc')) && isYuv420p && isChromiumAudio
          const isRemux = isChromiumVideo

          resolve({
            duration,
            videoCodec,
            audioCodec,
            pixFmt,
            width,
            height,
            isNative,
            isRemux,
            isAudioNative: isChromiumAudio
          })
          return
        } catch {}
      }

      // Fallback: parse stderr from ffmpeg -i if ffprobe wasn't available or JSON parse failed
      fallbackFfmpegProbe(filePath, resolve)
    })
  })
}

function fallbackFfmpegProbe(filePath: string, resolve: (res: MediaProbeResult) => void): void {
  const proc = spawn(ffmpegExe, ['-i', filePath])
  let stderr = ''
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  proc.on('close', () => {
    let duration = 0
    const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/)
    if (durationMatch) {
      const hours = parseFloat(durationMatch[1])
      const mins = parseFloat(durationMatch[2])
      const secs = parseFloat(durationMatch[3])
      duration = hours * 3600 + mins * 60 + secs
    }

    let videoCodec = ''
    let pixFmt = ''
    let width = 0
    let height = 0

    const videoMatch = stderr.match(/Stream #\d+:\d+.*?: Video: ([^,\n]+)/)
    if (videoMatch) videoCodec = videoMatch[1].toLowerCase()

    const pixMatch = stderr.match(/Video: [^,\n]+,\s*([^,\n]+),\s*(\d+)x(\d+)/)
    if (pixMatch) {
      pixFmt = pixMatch[1].trim().toLowerCase()
      width = parseInt(pixMatch[2], 10)
      height = parseInt(pixMatch[3], 10)
    } else {
      const resMatch = stderr.match(/(\d{3,5})x(\d{3,5})/)
      if (resMatch) {
        width = parseInt(resMatch[1], 10)
        height = parseInt(resMatch[2], 10)
      }
    }

    let audioCodec = ''
    const audioMatch = stderr.match(/Stream #\d+:\d+.*?: Audio: ([^,\n]+)/)
    if (audioMatch) audioCodec = audioMatch[1].toLowerCase()

    const ext = extname(filePath).toLowerCase()

    const isH264 = videoCodec.includes('h264') || videoCodec.includes('avc')
    const isYuv420p = pixFmt.includes('yuv420p') && !pixFmt.includes('yuv420p10')
    const isAacOrNone = !audioCodec || audioCodec.includes('aac') || audioCodec.includes('mp3')
    const isMp4 = ext === '.mp4'

    const isNative = isMp4 && isH264 && isYuv420p && isAacOrNone
    const isRemux = isH264

    resolve({
      duration,
      videoCodec,
      audioCodec,
      pixFmt,
      width,
      height,
      isNative,
      isRemux,
      isAudioNative: isAacOrNone
    })
  })
  proc.on('error', () => {
    resolve({
      duration: 0,
      videoCodec: '',
      audioCodec: '',
      pixFmt: '',
      width: 0,
      height: 0,
      isNative: false,
      isRemux: false,
      isAudioNative: false
    })
  })
}

export function initStreamServer(): Promise<number> {
  return new Promise((resolve) => {
    if (server && serverPort > 0) {
      return resolve(serverPort)
    }

    server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || '', `http://127.0.0.1:${serverPort}`)
      if (reqUrl.pathname === '/stream') {
        const filePath = reqUrl.searchParams.get('path')
        const startSecs = parseFloat(reqUrl.searchParams.get('start') || '0')

        if (!filePath || !fs.existsSync(filePath)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('File not found')
          return
        }

        killActiveStream()

        probeMedia(filePath)
          .then((probe) => {
            const args: string[] = []

            if (startSecs > 0) {
              args.push('-ss', startSecs.toString())
            }

            args.push('-i', filePath)

            if (probe.isRemux) {
              // Video stream: copy (no re-encode needed)
              args.push('-c:v', 'copy')
              // Audio stream: copy if Chromium natively decodes, otherwise convert audio to AAC
              if (probe.isAudioNative) {
                args.push('-c:a', 'copy')
              } else {
                args.push('-c:a', 'aac', '-b:a', '192k')
              }
            } else {
              // Fallback full transcode for non-Chromium video codecs (e.g. ProRes)
              args.push(
                '-c:v',
                'libx264',
                '-preset',
                'ultrafast',
                '-crf',
                '23',
                '-pix_fmt',
                'yuv420p',
                '-vf',
                'scale=trunc(iw/2)*2:trunc(ih/2)*2',
                '-c:a',
                'aac',
                '-b:a',
                '128k',
                '-ac',
                '2'
              )
            }

            args.push(
              '-movflags',
              '+frag_keyframe+empty_moov+default_base_moof',
              '-f',
              'mp4',
              'pipe:1'
            )

            res.writeHead(200, {
              'Content-Type': 'video/mp4',
              'Transfer-Encoding': 'chunked',
              'Access-Control-Allow-Origin': '*',
              'Accept-Ranges': 'none'
            })

            const ff = spawn(ffmpegExe, args)
            activeProcess = ff

            ff.stdout.pipe(res)

            ff.stderr.on('data', () => {
              // Silent stderr stream info
            })

            ff.on('close', () => {
              if (activeProcess === ff) activeProcess = null
            })

            req.on('close', () => {
              if (activeProcess === ff) {
                killActiveStream()
              }
            })
          })
          .catch((err) => {
            console.error('[StreamServer] Probe error:', err)
            if (!res.headersSent) {
              res.writeHead(500)
              res.end('Transcode error')
            }
          })
      } else {
        res.writeHead(404)
        res.end()
      }
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server?.address()
      if (addr && typeof addr === 'object') {
        serverPort = addr.port
        console.log(`[StreamServer] Local HTTP stream server running at http://127.0.0.1:${serverPort}`)
        resolve(serverPort)
      } else {
        resolve(0)
      }
    })
  })
}

export function closeStreamServer(): void {
  killActiveStream()
  if (server) {
    server.close()
    server = null
    serverPort = 0
  }
}
