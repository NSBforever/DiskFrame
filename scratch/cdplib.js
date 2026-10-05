/** Minimal CDP client for verification scripts (same protocol subset as cdp.js). */
const http = require('http')
const crypto = require('crypto')

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => { try { resolve(JSON.parse(b)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

function frame(str) {
  const p = Buffer.from(str)
  const m = crypto.randomBytes(4)
  let h
  if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length])
  else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2) }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(p.length), 2) }
  const x = Buffer.alloc(p.length)
  for (let i = 0; i < p.length; i++) x[i] = p[i] ^ m[i % 4]
  return Buffer.concat([h, m, x])
}

async function connect(port, urlMatch = 'index.html') {
  let page
  for (let i = 0; i < 200 && !page; i++) {
    try {
      const t = await getJson(port, '/json/list')
      page = t.find((x) => x.type === 'page' && x.webSocketDebuggerUrl && x.url.includes(urlMatch)) || null
    } catch { /* not up */ }
    if (!page) await new Promise((r) => setTimeout(r, 100))
  }
  if (!page) throw new Error('no page target on ' + port)
  const u = new URL(page.webSocketDebuggerUrl)
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' } })
    req.on('upgrade', (_r, sock) => {
      let buf = Buffer.alloc(0)
      let id = 0
      const wait = new Map()
      sock.on('data', (c) => {
        buf = Buffer.concat([buf, c])
        for (;;) {
          if (buf.length < 2) break
          let len = buf[1] & 0x7f
          let hl = 2
          if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); hl = 4 }
          else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); hl = 10 }
          if (buf.length < hl + len) break
          const msg = buf.slice(hl, hl + len).toString()
          buf = buf.slice(hl + len)
          try { const j = JSON.parse(msg); const w = wait.get(j.id); if (w) { wait.delete(j.id); w(j) } } catch { /* event */ }
        }
      })
      sock.on('error', () => {})
      const send = (method, params) => new Promise((r) => { const i = ++id; wait.set(i, r); sock.write(frame(JSON.stringify({ id: i, method, params }))) })
      resolve({
        send,
        async eval(expression) {
          const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
          if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description))
          return r.result && r.result.result && r.result.result.value
        },
        close: () => sock.destroy()
      })
    })
    req.on('error', reject)
    req.end()
  })
}

module.exports = { connect, getJson }
