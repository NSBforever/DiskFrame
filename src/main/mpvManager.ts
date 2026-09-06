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
  exec(`powershell -NoProfile -Command "${psCommand.replace(/\n/g, ' ')}"`, (err) => {
    if (err) {
      console.error('[mpvManager] Z-order PowerShell failed:', err)
    } else {
      console.log('[mpvManager] Z-order PowerShell succeeded')
    }
  })
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
  mpvWindow = new BrowserWindow({
    parent: hostWindow,
    frame: false,
    show: false,
    transparent: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  const contentBounds = hostWindow.getContentBounds()
  const childX = Math.round(contentBounds.x + relativeBounds.left)
  const childY = Math.round(contentBounds.y + relativeBounds.top)
  const childW = Math.round(relativeBounds.width)
  const childH = Math.round(relativeBounds.height)

  mpvWindow.setBounds({
    x: childX,
    y: childY,
    width: childW,
    height: childH
  })

  // Prevent capturing mouse events
  mpvWindow.setIgnoreMouseEvents(true)
  mpvWindow.show()

  const mpvHwnd = getHwndString(mpvWindow)
  const mainHwnd = getHwndString(hostWindow)

  // Set parent and move to bottom of Z-order
  setWindowZOrder(mpvHwnd, mainHwnd)

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

  mpvProcess.on('error', (err) => {
    console.error('[mpvManager] Spawn error:', err)
    if (hostWindow && !hostWindow.isDestroyed()) {
      hostWindow.webContents.send('mpv-error', { error: err.message })
    }
  })

  mpvProcess.on('close', (code) => {
    console.log('[mpvManager] Process closed with code:', code)
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
          if (!hostWindow.isDestroyed()) {
            hostWindow.webContents.send('mpv-property-change', {
              name: msg.name,
              value: msg.data
            })
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

  if (ipcSocket) {
    try {
      ipcSocket.destroy()
    } catch {}
    ipcSocket = null
  }

  if (mpvProcess) {
    try {
      mpvProcess.kill('SIGKILL')
    } catch {}
    mpvProcess = null
  }

  if (mpvWindow) {
    try {
      mpvWindow.destroy()
    } catch {}
    mpvWindow = null
  }

  hostWindowRef = null
}
