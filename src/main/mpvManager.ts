import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import { spawn, ChildProcess } from 'child_process'
import * as net from 'net'
import { exec } from 'child_process'

let mpvWindow: BrowserWindow | null = null
let mpvProcess: ChildProcess | null = null
let ipcSocket: net.Socket | null = null
let currentPipeName = ''
let hostWindowRef: BrowserWindow | null = null
let cachedRelativeBounds = { left: 0, top: 0, width: 0, height: 0 }
// closeMpv() kills the process, which fires 'close' with a non-zero code and
// used to be reported to the renderer as a playback failure. The renderer
// reacts to that by falling back to the stream server, i.e. spawning an ffmpeg
// transcode for a video the user just closed. Set while we are the ones doing
// the killing so a deliberate shutdown is not mistaken for a crash.
let closingDeliberately = false

/**
 * Which playback session is current.
 *
 * Bumped by every initMpv and every closeMpv. mpv's pipe connect retries for
 * 2.5s and its process events arrive whenever the OS gets round to them, so
 * without this a session that has already been replaced can still install its
 * socket over the live one, or report its own shutdown as the current video's
 * failure. Every callback that can outlive its session captures this and
 * checks it.
 */
let sessionId = 0

/**
 * Whether the current file has played to its end and is sitting there.
 *
 * mpv is run with --keep-open=yes, which is correct - it keeps the session and
 * the last frame rather than tearing the window down. What it also does,
 * measured against mpv itself (scratch/mpveof.js, same options, MP4 and MOV):
 *
 *     1993ms  eof-reached = true
 *     1993ms  core-idle   = true
 *     2103ms  pause       = true        <- mpv pauses itself
 *             idle-active = false        (the session is alive)
 *             end-file                   NEVER FIRES at eof under keep-open
 *
 * So the app saw only `pause = true` and could not tell "the user paused" from
 * "it finished". And at eof, un-pausing does nothing:
 *
 *     set_property pause=false    -> pause snaps back to true, eof-reached
 *                                    stays true, DID NOT RESUME
 *     seek 0 absolute, pause=false -> eof-reached=false, playback-restart,
 *                                    RESUMED
 *
 * That is the whole of "controls stop working after a video finishes": the
 * Play button sends the first one. eof-reached is the signal to watch -
 * listening for end-file, the obvious guess, would never have fired.
 */
let ended = false

function getMpvPath(): string {
  const isDev = !app.isPackaged
  const root = app.getAppPath()
  const unpackedRoot = root.replace('app.asar', 'app.asar.unpacked')
  const candidates = [
    isDev ? join(root, 'resources', 'bin', 'win', 'mpv.exe') : join(unpackedRoot, 'resources', 'bin', 'win', 'mpv.exe'),
    isDev ? join(root, 'resources', 'mpv', 'mpv.exe') : join(unpackedRoot, 'resources', 'mpv', 'mpv.exe'),
    join(process.cwd(), 'resources', 'bin', 'win', 'mpv.exe'),
    join(process.cwd(), 'resources', 'mpv', 'mpv.exe'),
    'mpv.exe',
    'mpv'
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return 'mpv'
}

function getHwndString(win: BrowserWindow): string {
  const buf = win.getNativeWindowHandle()
  if (buf.length === 8) {
    return buf.readBigUint64LE(0).toString()
  } else if (buf.length === 4) {
    return buf.readUInt32LE(0).toString()
  } else {
    return buf.readInt32LE(0).toString()
  }
}

function setWindowZOrder(childHwnd: string, parentHwnd: string) {
  const psCommand = `
    $code = @'
      [DllImport("user32.dll")]
      public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
      [DllImport("user32.dll")]
      public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint Flags);
    '@
    $Win32 = Add-Type -MemberDefinition $code -Name "Win32API" -Namespace Win32Functions -PassThru
    $child = [IntPtr][long](${childHwnd})
    $parent = [IntPtr][long](${parentHwnd})
    $Win32::SetParent($child, $parent)
    $Win32::SetWindowPos($child, [IntPtr]1, 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010)
  `
  return new Promise<void>((resolve) => {
    exec(`powershell -NoProfile -Command "${psCommand.replace(/\n/g, ' ')}"`, (err) => {
      if (err) console.error('[mpvManager] Z-order PowerShell failed:', err)
      // Resolve either way: a failed re-parent must not hang video startup.
      resolve()
    })
  })
}

/** Push a message to the control overlay, if it is alive. */
export function sendToOverlay(channel: string, payload: unknown): void {
  if (!mpvWindow || mpvWindow.isDestroyed()) return
  mpvWindow.webContents.send(channel, payload)
}

export function setOverlayInteractive(interactive: boolean): void {
  if (!mpvWindow || mpvWindow.isDestroyed()) return
  mpvWindow.setIgnoreMouseEvents(!interactive, { forward: true })
}

export function updateMpvBounds(bounds: { left: number; top: number; width: number; height: number }) {
  if (!mpvWindow || !hostWindowRef) return
  cachedRelativeBounds = bounds
  const contentBounds = hostWindowRef.getContentBounds()
  const childX = Math.round(contentBounds.x + bounds.left)
  const childY = Math.round(contentBounds.y + bounds.top)
  const childW = Math.round(bounds.width)
  const childH = Math.round(bounds.height)
  mpvWindow.setBounds({
    x: childX,
    y: childY,
    width: childW,
    height: childH
  })
}
export function refreshMpvBounds() {
  updateMpvBounds(cachedRelativeBounds)
}



/**
 * The control overlay's HTML, written to userData on first use.
 *
 * A file:// page rather than a data: URL so the shared preload (and therefore
 * window.api) applies to it normally.
 */
/** Overlay page, resolved the same way as the bundled mpv binary. */
function getOverlayPath(): string {
  const isDev = !app.isPackaged
  const root = app.getAppPath()
  const unpackedRoot = root.replace('app.asar', 'app.asar.unpacked')
  const candidates = [
    isDev
      ? join(root, 'resources', 'overlay', 'controls.html')
      : join(unpackedRoot, 'resources', 'overlay', 'controls.html'),
    join(root, 'resources', 'overlay', 'controls.html'),
    join(process.cwd(), 'resources', 'overlay', 'controls.html')
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return candidates[0]
}

/**
 * Shows a session started with deferShow, and starts it playing.
 *
 * The viewer opens with an animation from the clicked tile, drawn in the main
 * window - and mpv's window, an owned window, always sits above the main one.
 * Shown at once, it covered the animation with black until its first frame and
 * started the audio before there was a picture. So the session starts hidden
 * and paused at its final bounds, and the viewer reveals it once the animation
 * has landed and mpv has decoded a frame.
 */
export function revealMpv(): void {
  if (!mpvWindow || mpvWindow.isDestroyed()) return
  if (!mpvWindow.isVisible()) mpvWindow.show()
  if (ipcSocket && !ipcSocket.destroyed) sendCommand(ipcSocket, ['set_property', 'pause', false])
}

export async function initMpv(
  filePath: string,
  relativeBounds: { left: number; top: number; width: number; height: number },
  hostWindow: BrowserWindow,
  opts: { deferShow?: boolean } = {}
) {
  closeMpv() // close any previous session

  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }

  // This session's identity. Everything below that can be called back into
  // after the user has moved on compares against it.
  const mySession = ++sessionId
  ended = false

  hostWindowRef = hostWindow
  cachedRelativeBounds = relativeBounds

  // Create a transparent, frameless child window
  const contentBounds = hostWindow.getContentBounds()
  const childX = Math.round(contentBounds.x + relativeBounds.left)
  const childY = Math.round(contentBounds.y + relativeBounds.top)
  const childW = Math.round(relativeBounds.width)
  const childH = Math.round(relativeBounds.height)

  // Born at its final size and position. Constructed without bounds it took
  // Electron's default (800x600, OS-placed) and was only moved afterwards,
  // which is the other half of the entrance flash.
  mpvWindow = new BrowserWindow({
    parent: hostWindow,
    x: childX,
    y: childY,
    width: childW,
    height: childH,
    frame: false,
    show: false,
    transparent: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Same as the main window: the shared preload uses Node APIs, so a
      // sandboxed renderer refuses to load it ("Unable to load preload
      // script") and window.api is undefined in the overlay.
      sandbox: false,
      preload: join(__dirname, '../preload/index.js')
    }
  })

  // Prevent capturing mouse events
  // Mouse passes straight through to the video by default; the overlay asks
  // for interactivity only while its control bar is actually showing.
  mpvWindow.setIgnoreMouseEvents(true, { forward: true })

  const mpvHwnd = getHwndString(mpvWindow)
  const mainHwnd = getHwndString(hostWindow)

  // Start re-parenting now but do not block on it: the PowerShell round trip
  // is the single slowest step in opening a video (Add-Type compiles on every
  // call), and spawning mpv does not depend on it. Awaiting it before the
  // spawn made startup the SUM of the two instead of the longer one.
  const reparented = setWindowZOrder(mpvHwnd, mainHwnd)

  // Generate unique named pipe name
  const randId = Math.random().toString(36).substring(2, 9)
  currentPipeName = `\\\\.\\pipe\\mpv-socket-${randId}`

  // Spawn MPV process
  const mpvExe = getMpvPath()
  const args = [
    `--wid=${mpvHwnd}`,
    `--input-ipc-server=${currentPipeName}`,
    '--hwdec=d3d11va', // hardware decoding (dxva2 fallback can be sent via IPC)
    '--idle=no',
    '--keep-open=yes',
    '--force-window=yes',
    '--video-aspect-override=-1',
    '--osc=no',
    '--no-config',
    '--input-default-bindings=no',
    // Decoded and ready on its first frame, but silent until revealMpv().
    ...(opts.deferShow ? ['--pause'] : []),
    filePath
  ]

  mpvProcess = spawn(mpvExe, args)
  console.log('[mpvManager] Spawning MPV process PID:', mpvProcess?.pid, 'Exe:', mpvExe, 'Args:', args.join(' '))

  // Only now is it safe to show: the window is a child of the host, sunk to
  // the bottom of the z-order, and restated at its final bounds. Showing
  // earlier is what put the video in a corner for a few hundred milliseconds.
  await reparented
  if (!mpvWindow || mpvWindow.isDestroyed()) return
  mpvWindow.setBounds({ x: childX, y: childY, width: childW, height: childH })

  // Controls live in THIS window, not the main one.
  //
  // mpv's window is an OWNED top-level window (parent=0, owner=<main>), and
  // Windows always z-orders an owned window above its owner - so nothing
  // rendered in the main window can ever appear over the video, whatever its
  // z-index. Chromium renders into a child HWND of this window, and a child
  // paints above its parent's own drawing, so an overlay loaded here does
  // composite above mpv's video. Verified on screen, not in the DOM.
  mpvWindow.loadFile(getOverlayPath()).catch((e) => {
    console.error('[mpvManager] overlay failed to load:', e)
  })
  if (!opts.deferShow) mpvWindow.show()

  mpvProcess.on('error', (err) => {
    console.error('[mpvManager] Spawn error:', err)
    if (hostWindow && !hostWindow.isDestroyed()) {
      hostWindow.webContents.send('mpv-error', { error: err.message })
    }
  })

  const thisProcess = mpvProcess
  mpvProcess.on('close', (code) => {
    console.log('[mpvManager] Process closed with code:', code)
    // Three different things end a session and they must not be confused:
    // the user closing it, the file finishing, and mpv falling over. Only the
    // last is a failure, and only for the session still on screen - a late
    // 'close' from a previous video would otherwise make the video now
    // playing fall back to transcoding.
    if (closingDeliberately || thisProcess !== mpvProcess || mySession !== sessionId) return
    if (code !== 0 && hostWindow && !hostWindow.isDestroyed()) {
      hostWindow.webContents.send('mpv-error', { error: `MPV exited with code ${code}` })
    }
  })

  // Wait for named pipe and connect
  try {
    await connectIpcPipe(currentPipeName, hostWindow, mySession)
  } catch (err) {
    // A session the user has already left is not a failure to report. Closing
    // a video while the pipe was still being retried used to surface as a
    // playback error, and the renderer answered it by transcoding a file
    // nobody was watching.
    if (mySession === sessionId && !hostWindow.isDestroyed()) {
      hostWindow.webContents.send('mpv-error', { error: 'Failed to connect to mpv IPC socket' })
    }
  }
}

function connectIpcPipe(pipeName: string, hostWindow: BrowserWindow, mySession: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let retries = 0
    const maxRetries = 25 // 2.5 seconds total

    function tryConnect() {
      if (hostWindow.isDestroyed()) {
        reject(new Error('Host window destroyed'))
        return
      }
      // The retry loop outlives a close or a switch to the next video. Without
      // this it would eventually connect and install its socket as the live
      // one, so commands for the video on screen went to a dead session.
      if (mySession !== sessionId) {
        reject(new Error('Session superseded'))
        return
      }
      console.log(`[mpvManager] Connecting to pipe (try ${retries + 1}):`, pipeName)
      const socket = net.connect(pipeName)

      socket.on('connect', () => {
        if (mySession !== sessionId) {
          try {
            socket.destroy()
          } catch {
            /* nothing to clean up */
          }
          reject(new Error('Session superseded'))
          return
        }
        console.log('[mpvManager] Connected to named pipe successfully')
        ipcSocket = socket
        setupIpcListeners(socket, hostWindow, mySession)
        resolve()
      })

      socket.on('error', () => {
        retries++
        if (retries < maxRetries) {
          setTimeout(tryConnect, 100)
        } else {
          console.error('[mpvManager] Failed to connect to IPC socket after retries')
          reject(new Error('IPC Connection Timeout'))
        }
      })
    }

    setTimeout(tryConnect, 150)
  })
}

function sendCommand(socket: net.Socket, command: any[]) {
  const payload = JSON.stringify({ command }) + '\n'
  socket.write(payload)
}

/**
 * Tells both surfaces the same thing at the same time.
 *
 * The control bar lives in the mpv window (it is the only thing that can be
 * seen over mpv's native surface) and the gallery's own chrome lives in the
 * main window. They must never disagree about whether the video has ended.
 */
function broadcast(hostWindow: BrowserWindow, payload: { name: string; value: unknown }): void {
  if (hostWindow && !hostWindow.isDestroyed()) hostWindow.webContents.send('mpv-property-change', payload)
  if (mpvWindow && !mpvWindow.isDestroyed()) mpvWindow.webContents.send('mpv-property-change', payload)
}

function setEnded(hostWindow: BrowserWindow, value: boolean): void {
  if (ended === value) return
  ended = value
  broadcast(hostWindow, { name: 'ended', value })
}

/**
 * Whether the current session can still be commanded.
 *
 * mpv's window can be gone while the renderer still thinks it is playing - the
 * process crashed, or the pipe closed. Sending into that is silent and looks
 * exactly like broken controls, so the renderer is told instead and starts the
 * backend again rather than talking to a dead one.
 */
export function mpvSessionAlive(): boolean {
  return !!ipcSocket && !ipcSocket.destroyed && !!mpvProcess
}

function setupIpcListeners(socket: net.Socket, hostWindow: BrowserWindow, mySession: number) {
  // Observe properties
  sendCommand(socket, ['observe_property', 1, 'time-pos'])
  sendCommand(socket, ['observe_property', 2, 'duration'])
  sendCommand(socket, ['observe_property', 3, 'pause'])
  sendCommand(socket, ['observe_property', 4, 'volume'])
  sendCommand(socket, ['observe_property', 5, 'mute'])
  sendCommand(socket, ['observe_property', 6, 'speed'])
  sendCommand(socket, ['observe_property', 7, 'hwdec-current'])
  sendCommand(socket, ['observe_property', 8, 'width'])
  sendCommand(socket, ['observe_property', 9, 'height'])
  // mpv embeds as a real native child window (--wid), so mouse events over the
  // video pixels go to mpv's own window, never to the DOM - the renderer's
  // mousemove-driven controls-visibility timer would otherwise never fire
  // while hovering the video itself. Observing mouse-pos gives mpv's own
  // input as an activity signal we can forward back over the existing
  // mpv-property-change channel.
  sendCommand(socket, ['observe_property', 10, 'mouse-pos'])
  // The one that says the video finished. Under --keep-open=yes mpv does not
  // fire end-file at eof at all - it sets this, then pauses itself ~100ms
  // later. Without it, "it ended" arrived as an ordinary pause=true and was
  // indistinguishable from the user pressing pause. Measured: scratch/mpveof.js.
  sendCommand(socket, ['observe_property', 13, 'eof-reached'])
  // Lets the overlay say "no subtitles" instead of offering a dead button.
  sendCommand(socket, ['observe_property', 11, 'track-list'])
  // Which subtitle track is active, so the CC button can show its real state.
  sendCommand(socket, ['observe_property', 12, 'sid'])

  let hasTriedHwdecFallback = false
  let buffer = ''
  socket.on('data', (data) => {
    buffer += data.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        // Anything still arriving for a session the user has left must not
        // touch the state of the one now on screen.
        if (mySession !== sessionId) continue

        // Fires when a file is actually unloaded, which under --keep-open=yes
        // is not at eof. Its reason is how a crash is told apart from the user
        // closing the video.
        if (msg.event === 'end-file') {
          if (msg.reason === 'error' && !closingDeliberately && !hostWindow.isDestroyed()) {
            hostWindow.webContents.send('mpv-error', {
              error: `Playback failed: ${msg.error ?? 'unknown decode error'}`
            })
          }
          continue
        }

        if (msg.event === 'property-change') {
          if (msg.name === 'hwdec-current' && msg.data === 'no' && !hasTriedHwdecFallback) {
            hasTriedHwdecFallback = true
            console.log('[mpvManager] d3d11va hwdec inactive, falling back to dxva2...')
            sendCommand(socket, ['set_property', 'hwdec', 'dxva2'])
          }
          if (msg.name === 'eof-reached' && typeof msg.data === 'boolean') {
            setEnded(hostWindow, msg.data)
          }
          const payload = { name: msg.name, value: msg.data }
          broadcast(hostWindow, payload)
        }
      } catch (err) {
        // silent parse error for incomplete frames
      }
    }
  })

  socket.on('close', () => {
    console.log('[mpvManager] IPC named pipe closed')
  })
}

/**
 * One place that knows what a command means at the end of a file.
 *
 * Both the overlay's Play button and the main window's player send their
 * commands through here, as does every keyboard shortcut in either window, so
 * this is where "it has ended" has to be understood - a guard in one of the
 * callers would leave the others still sending a no-op into a finished file.
 *
 * Measured against mpv (scratch/mpveof.js): at eof under --keep-open=yes,
 * un-pausing alone does nothing at all; a seek is what clears eof-reached and
 * restarts playback. So:
 *
 *   play / Space / K at the end   -> replay from the beginning
 *   any seek at the end           -> resume from there, rather than staying
 *                                    paused on the last frame
 */
export function sendMpvCommand(command: string, args: any[]) {
  if (!ipcSocket || ipcSocket.destroyed) {
    console.warn('[mpvManager] Cannot send command, socket not connected')
    // The renderer thinks it is still playing something. Say so, rather than
    // dropping the command and leaving dead-looking controls on screen.
    if (hostWindowRef && !hostWindowRef.isDestroyed()) {
      hostWindowRef.webContents.send('mpv-session-lost')
    }
    return
  }

  let effective: unknown[] = [command, ...args]

  if (ended) {
    const unpausing =
      command === 'set_property' && args[0] === 'pause' && args[1] === false
    const cycling = command === 'cycle' && args[0] === 'pause'
    if (unpausing || cycling) {
      // Replay. The seek is the part that matters; the unpause follows it
      // because mpv paused itself when it reached the end.
      ipcSocket.write(JSON.stringify({ command: ['seek', 0, 'absolute'] }) + '\n')
      effective = ['set_property', 'pause', false]
    } else if (command === 'seek') {
      // The seek itself clears eof-reached; without this the user lands at the
      // new position still paused, which reads as the controls being dead.
      ipcSocket.write(JSON.stringify({ command: effective }) + '\n')
      effective = ['set_property', 'pause', false]
    }
  }

  ipcSocket.write(JSON.stringify({ command: effective }) + '\n')
}

export function closeMpv() {
  console.log('[mpvManager] Closing active mpv session')
  closingDeliberately = true
  // Retake the identity before anything is torn down, so the retry loop and
  // the process events belonging to the session being closed can see at once
  // that they are no longer current.
  sessionId++
  ended = false

  if (ipcSocket) {
    try {
      ipcSocket.removeAllListeners()
      ipcSocket.destroy()
    } catch {}
    ipcSocket = null
  }

  if (mpvProcess) {
    const proc = mpvProcess
    mpvProcess = null
    try {
      proc.removeAllListeners('error')
      proc.kill('SIGKILL')
    } catch {}
  }

  if (mpvWindow) {
    try {
      mpvWindow.destroy()
    } catch {}
    mpvWindow = null
  }

  hostWindowRef = null
  // Cleared on the next tick so the 'close' event this kill produces is still
  // seen as deliberate.
  setTimeout(() => {
    closingDeliberately = false
  }, 0)
}
