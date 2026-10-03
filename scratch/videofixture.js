/**
 * Two short disposable clips, MP4 and MOV, for end-of-playback verification.
 *
 * Deliberately a few seconds long: the thing being tested is what happens
 * AFTER the last frame, so the test has to be able to wait for it.
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const ffmpeg = require(path.join(__dirname, '..', 'node_modules', 'ffmpeg-static'))

const root = process.argv[2]
const secs = Number(process.argv[3] || 3)
fs.mkdirSync(root, { recursive: true })

const mp4 = path.join(root, 'clip_mp4.mp4')
execFileSync(ffmpeg, ['-y',
  '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=25:duration=${secs}`,
  '-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`,
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4
], { stdio: 'ignore', timeout: 120000 })

const mov = path.join(root, 'clip_mov.mov')
execFileSync(ffmpeg, ['-y', '-i', mp4, '-c', 'copy', mov], { stdio: 'ignore', timeout: 120000 })

// A still, so Next/Previous out of a finished video has somewhere to go.
const png = path.join(root, 'still.png')
execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=1:duration=1', '-frames:v', '1', png],
  { stdio: 'ignore', timeout: 120000 })

for (const f of [mp4, mov, png]) console.log(path.basename(f) + '\t' + fs.statSync(f).size + ' bytes')
