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

export async function initMpv(
  filePath: string,
  relativeBounds: { left: number; top: number; width: number; height: number },
  hostWindow: BrowserWindow
) {
  closeMpv() // close any previous session

  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }

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
  mpvWindow.show()

  mpvProcess.on('error', (err) => {
    console.error('[mpvManager] Spawn error:', err)
    if (hostWindow && !hostWindow.isDestroyed()) {
      hostWindow.webContents.send('mpv-error', { error: err.message })
    }
  })

  const thisProcess = mpvProcess
  mpvProcess.on('close', (code) => {
    console.log('[mpvManager] Process closed with code:', code)
    // Only report a failure for the session that is still current and that we
    // did not kill ourselves. A late 'close' from a previous video would
    // otherwise make the video now on screen fall back to transcoding.
    if (closingDeliberately || thisProcess !== mpvProcess) return
    if (code !== 0 && hostWindow && !hostWindow.isDestroyed()) {
      hostWindow.webContents.send('mpv-error', { error: `MPV exited with code ${code}` })
    }
  })

  // Wait for named pipe and connect
  try {
    await connectIpcPipe(currentPipeName, hostWindow)
  } catch (err) {
    if (!hostWindow.isDestroyed()) {
      hostWindow.webContents.send('mpv-error', { error: 'Failed to connect to mpv IPC socket' })
    }
  }
}

function connectIpcPipe(pipeName: string, hostWindow: BrowserWindow): Promise<void> {
  return new Promise((resolve, reject) => {
    let retries = 0
    const maxRetries = 25 // 2.5 seconds total

    function tryConnect() {
      if (hostWindow.isDestroyed()) {
        reject(new Error('Host window destroyed'))
        return
      }
      console.log(`[mpvManager] Connecting to pipe (try ${retries + 1}):`, pipeName)
      const socket = net.connect(pipeName)

      socket.on('connect', () => {
        console.log('[mpvManager] Connected to named pipe successfully')
        ipcSocket = socket
        setupIpcListeners(socket, hostWindow)
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

function setupIpcListeners(socket: net.Socket, hostWindow: BrowserWindow) {
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
  // Lets the overlay say "no subtitles" instead of offering a dead button.
  sendCommand(socket, ['observe_property', 11, 'track-list'])

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
        if (msg.event === 'property-change') {
          if (msg.name === 'hwdec-current' && msg.data === 'no' && !hasTriedHwdecFallback) {
            hasTriedHwdecFallback = true
            console.log('[mpvManager] d3d11va hwdec inactive, falling back to dxva2...')
            sendCommand(socket, ['set_property', 'hwdec', 'dxva2'])
          }
          const payload = { name: msg.name, value: msg.data }
          if (!hostWindow.isDestroyed()) {
            hostWindow.webContents.send('mpv-property-change', payload)
          }
          // The control bar lives in the mpv window, so it needs the same
          // stream of state - otherwise it would render a static bar.
          if (mpvWindow && !mpvWindow.isDestroyed()) {
            mpvWindow.webContents.send('mpv-property-change', payload)
          }
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

export function sendMpvCommand(command: string, args: any[]) {
  if (!ipcSocket || ipcSocket.destroyed) {
    console.warn('[mpvManager] Cannot send command, socket not connected')
    return
  }
  const fullCmd = [command, ...args]
  const payload = JSON.stringify({ command: fullCmd }) + '\n'
  ipcSocket.write(payload)
}

export function closeMpv() {
  console.log('[mpvManager] Closing active mpv session')
  closingDeliberately = true

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
