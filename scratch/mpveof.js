/**
 * What mpv actually reports at end of file, with the options the app uses.
 *
 * The complaint is "controls stop working after a video finishes". Before
 * changing any mpv option, this records what the backend really does: the
 * end-file event and its reason, eof-reached, idle-active, pause and time-pos,
 * in order. Then it tries the two obvious recoveries in sequence and reports
 * which one actually resumes playback:
 *
 *   A  set pause=no          - what the Play button sends today
 *   B  seek 0 absolute, then set pause=no
 *
 * Spawns mpv headless (--vo=null --ao=null) on a disposable 2-second fixture.
 * No window, no real media, no app involved.
 */
const { spawn, execFileSync } = require('child_process')
const net = require('net')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ffmpeg = require(path.join(__dirname, '..', 'node_modules', 'ffmpeg-static'))
const mpvExe = path.join(__dirname, '..', 'resources', 'bin', 'win', 'mpv.exe')
const dir = path.join(os.tmpdir(), 'df-mpveof')
fs.mkdirSync(dir, { recursive: true })
const container = process.argv[2] === 'mov' ? 'mov' : 'mp4'
const clip = path.join(dir, 'two-seconds.' + container)
execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip],
  { stdio: 'ignore', timeout: 120000 })
console.log('fixture: ' + clip + ' (' + fs.statSync(clip).size + ' bytes)')

const pipe = '\\\\.\\pipe\\mpv-eof-probe-' + process.pid

// Exactly the options src/main/mpvManager.ts spawns with, minus the window.
const args = [
  '--input-ipc-server=' + pipe,
  '--idle=no',
  '--keep-open=yes',
  '--no-config',
  '--input-default-bindings=no',
  '--osc=no',
  '--vo=null',
  '--ao=null',
  clip
]
console.log('mpv args: ' + args.filter((a) => a.indexOf('ipc-server') === -1).join(' '))

const proc = spawn(mpvExe, args)
let exited = null
proc.on('close', (code) => { exited = code })

const t0 = Date.now()
const log = []
const at = () => String(Date.now() - t0).padStart(5) + 'ms'
const note = (what) => { log.push(at() + '  ' + what); console.log(at() + '  ' + what) }

setTimeout(connect, 400)

function connect() {
  const sock = net.connect(pipe)
  sock.on('error', () => setTimeout(connect, 150))
  sock.on('connect', () => {
    note('IPC connected')
    const send = (command) => sock.write(JSON.stringify({ command }) + '\n')
    // The properties the app observes today, plus the three it does not.
    const props = ['time-pos', 'duration', 'pause', 'eof-reached', 'idle-active', 'core-idle']
    props.forEach((p, i) => send(['observe_property', i + 1, p]))

    const last = {}
    let eofSeenAt = null
    let resumedAfter = null
    let phase = 'playing'
    let buf = ''

    sock.on('data', (d) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        let m
        try { m = JSON.parse(line) } catch { continue }

        // The event the app never listens for.
        if (m.event === 'end-file') {
          note('EVENT end-file  reason=' + m.reason + (m.error ? ' error=' + m.error : ''))
          continue
        }
        if (m.event && m.event !== 'property-change') {
          note('EVENT ' + m.event)
          continue
        }
        if (m.event !== 'property-change') continue

        const name = m.name
        const value = m.data
        // time-pos ticks constantly; only report it at the moments that matter.
        if (name === 'time-pos') {
          last['time-pos'] = value
          if (phase === 'A-sent' && typeof value === 'number' && eofSeenAt !== null &&
              last['eof-reached'] === false && resumedAfter === null) {
            resumedAfter = 'A'
          }
          continue
        }
        if (last[name] === value) continue
        last[name] = value
        note('property ' + name + ' = ' + JSON.stringify(value) +
             (name === 'eof-reached' && value === true ? '   <-- end of file' : ''))
        if (name === 'eof-reached' && value === true && eofSeenAt === null) {
          eofSeenAt = Date.now()
          note('state at EOF: pause=' + last['pause'] + ' eof-reached=true idle-active=' +
               last['idle-active'] + ' core-idle=' + last['core-idle'] +
               ' time-pos=' + last['time-pos'] + ' duration=' + last['duration'])

          // ── A: exactly what the Play button sends today ──
          setTimeout(() => {
            phase = 'A-sent'
            note('>> A: set_property pause=false   (what the Play button sends today)')
            send(['set_property', 'pause', false])
          }, 300)

          // Did A do anything?
          setTimeout(() => {
            const moved = typeof last['time-pos'] === 'number' && last['eof-reached'] === false
            note('   A result: eof-reached=' + last['eof-reached'] + ' pause=' + last['pause'] +
                 ' time-pos=' + last['time-pos'] + '  -> playback ' + (moved ? 'RESUMED' : 'DID NOT RESUME'))

            // ── B: seek to the start, then un-pause ──
            phase = 'B-sent'
            note('>> B: seek 0 absolute, then set_property pause=false')
            send(['seek', 0, 'absolute'])
            send(['set_property', 'pause', false])
          }, 1600)

          setTimeout(() => {
            const moved = typeof last['time-pos'] === 'number' && last['time-pos'] < 1.9 &&
                          last['eof-reached'] === false
            note('   B result: eof-reached=' + last['eof-reached'] + ' pause=' + last['pause'] +
                 ' time-pos=' + last['time-pos'] + '  -> playback ' + (moved ? 'RESUMED' : 'DID NOT RESUME'))
            note('process still alive: ' + (exited === null) + (exited === null ? '' : ' (exit ' + exited + ')'))
            console.log('\n--- conclusion ---')
            console.log('keep-open=yes holds the session open at EOF: ' + (exited === null))
            console.log('the end-file event carries a reason the app never reads')
            console.log('eof-reached is never observed by the app, so it cannot know it ended')
            try { sock.end() } catch { /* closing anyway */ }
            try { proc.kill() } catch { /* already gone */ }
            setTimeout(() => process.exit(0), 300)
          }, 3000)
        }
      }
    })
  })
}

setTimeout(() => { console.error('timed out'); try { proc.kill() } catch { /* gone */ } process.exit(1) }, 30000)
