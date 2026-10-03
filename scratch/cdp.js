/**
 * Minimal Chrome DevTools Protocol client, so the installed app can be driven
 * and measured without clicking.
 *
 * Node has no WebSocket client and this is the only thing in the repo that
 * needs one, so the handshake and the two frame shapes we use are written out
 * here rather than adding a dependency. Text frames only, no fragmentation,
 * no permessage-deflate (CDP does not negotiate it).
 *
 * Usage: electron (ELECTRON_RUN_AS_NODE=1) scratch/cdp.js <port> '<js expression>'
 *   The expression is evaluated in the first page target, awaited, and the
 *   JSON result printed.
 *
 *        electron (ELECTRON_RUN_AS_NODE=1) scratch/cdp.js <port> --shot <file.png>
 *   Captures what is actually on screen. DOM assertions are not enough for
 *   anything layered over mpv's native window: mpv embeds as a real child HWND
 *   and Windows z-orders it above anything the DOM can draw, so an overlay can
 *   be present, opaque and on top in the DOM and still be invisible.
 */
const http = require('http')
const crypto = require('crypto')

function listTargets(port) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/json/list' }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch (e) {
            reject(e)
          }
        })
      })
      .on('error', reject)
  })
}

function encodeTextFrame(str) {
  const payload = Buffer.from(str, 'utf8')
  const mask = crypto.randomBytes(4)
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  const masked = Buffer.alloc(payload.length)
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4]
  return Buffer.concat([header, mask, masked])
}

/** Pulls whole server frames out of a growing buffer. Server frames are never
 *  masked, so this only has to handle the three length encodings. */
function decodeFrames(buf) {
  const out = []
  let off = 0
  while (off + 2 <= buf.length) {
    const opcode = buf[off] & 0x0f
    let len = buf[off + 1] & 0x7f
    let headerLen = 2
    if (len === 126) {
      if (off + 4 > buf.length) break
      len = buf.readUInt16BE(off + 2)
      headerLen = 4
    } else if (len === 127) {
      if (off + 10 > buf.length) break
      len = Number(buf.readBigUInt64BE(off + 2))
      headerLen = 10
    }
    if (off + headerLen + len > buf.length) break
    if (opcode === 0x1) out.push(buf.slice(off + headerLen, off + headerLen + len).toString('utf8'))
    off += headerLen + len
  }
  return { messages: out, rest: buf.slice(off) }
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl)
    const key = crypto.randomBytes(16).toString('base64')
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13'
      }
    })
    req.on('upgrade', (_res, socket) => {
      socket.setNoDelay(true)
      const waiting = new Map()
      let id = 0
      let buf = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk])
        const { messages, rest } = decodeFrames(buf)
        buf = rest
        for (const m of messages) {
          let msg
          try {
            msg = JSON.parse(m)
          } catch {
            continue
          }
          const pending = waiting.get(msg.id)
          if (pending) {
            waiting.delete(msg.id)
            pending(msg)
          }
        }
      })
      resolve({
        send(method, params) {
          const myId = ++id
          return new Promise((res) => {
            waiting.set(myId, res)
            socket.write(encodeTextFrame(JSON.stringify({ id: myId, method, params })))
          })
        },
        close: () => socket.destroy()
      })
    })
    req.on('error', reject)
    req.end()
  })
}

;(async () => {
  const port = Number(process.argv[2] || 9222)
  const expression = process.argv[3]
  if (!expression) {
    console.error("usage: cdp.js <port> '<js expression>' | cdp.js <port> --shot <file.png>")
    process.exit(1)
  }
  const shotPath = expression === '--shot' ? process.argv[4] : null
  if (expression === '--shot' && !shotPath) {
    console.error('usage: cdp.js <port> --shot <file.png>')
    process.exit(1)
  }
  const targets = await listTargets(port)
  // Once a video is open there are two page targets - the gallery and the mpv
  // control overlay, which is its own window. --target picks by URL substring;
  // without it the first page wins, which is whichever Chromium lists first.
  const wantIdx = process.argv.indexOf('--target')
  const want = wantIdx !== -1 ? process.argv[wantIdx + 1] : null
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  const page = want ? pages.find((t) => t.url.indexOf(want) !== -1) : pages.find((t) => t.url.indexOf('index.html') !== -1) || pages[0]
  if (!page) {
    console.error('no page target; targets: ' + targets.map((t) => t.type).join(','))
    process.exit(1)
  }
  const cdp = await connect(page.webSocketDebuggerUrl)
  if (shotPath) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const data = shot.result && shot.result.data
    if (!data) {
      console.error('no screenshot data: ' + JSON.stringify(shot).slice(0, 300))
      cdp.close()
      process.exit(1)
    }
    require('fs').writeFileSync(shotPath, Buffer.from(data, 'base64'))
    console.log('wrote ' + shotPath + ' (' + require('fs').statSync(shotPath).size + ' bytes)')
    cdp.close()
    process.exit(0)
  }
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  const r = res.result?.result
  if (res.result?.exceptionDetails) {
    console.error('EXCEPTION:', JSON.stringify(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails))
    cdp.close()
    process.exit(1)
  }
  console.log(typeof r?.value === 'string' ? r.value : JSON.stringify(r?.value ?? r, null, 2))
  cdp.close()
  process.exit(0)
})().catch((e) => {
  console.error('FATAL', e.message)
  process.exit(1)
})
