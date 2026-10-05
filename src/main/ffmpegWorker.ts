import { parentPort, workerData } from 'worker_threads'
import { spawn } from 'child_process'
import * as fs from 'fs'

/**
 * Starts ffmpeg for video thumbnails, off the main thread.
 *
 * Creating a process on Windows is synchronous for the thread that asks
 * (CreateProcess, plus whatever the antivirus does with the image). From the
 * main process that was ~12ms per video thumbnail on average and 100-300ms when
 * several slots finished together - measured as the largest main-thread cost
 * left while thumbnails were generating, on the thread that routes wheel input.
 * Here it blocks only this worker. Each request is one ffmpeg run; several run
 * at once (the pump bounds how many).
 */
const ffmpeg = workerData.ffmpegPath as string

parentPort?.on('message', (m: { id: number; args: string[]; outPath: string; timeoutMs: number }) => {
  let settled = false
  const done = (ok: boolean): void => {
    if (settled) return
    settled = true
    clearTimeout(killTimer)
    parentPort?.postMessage({ id: m.id, ok })
  }
  const ff = spawn(ffmpeg, m.args)
  // Drained but not kept: an ffmpeg whose stderr nobody reads blocks on a full pipe.
  ff.stderr.resume()
  const killTimer = setTimeout(() => {
    try {
      ff.kill()
    } catch {
      /* already gone */
    }
    done(false)
  }, m.timeoutMs)
  ff.on('error', () => done(false))
  ff.on('close', () => fs.stat(m.outPath, (err, st) => done(!err && st.size > 0)))
})
