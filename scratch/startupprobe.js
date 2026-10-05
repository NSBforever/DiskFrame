/**
 * Launch-to-usable timings for a real build, measured from outside it.
 *
 *   node scratch/startupprobe.js <exe> [port] [--user-data-dir=...]
 *
 * t=0 is the spawn. Reported, each the first time it is true:
 *   target     a renderer page exists (window created, devtools reachable)
 *   shown      the window is visible (document.visibilityState === 'visible')
 *   shell      React has mounted something into #root
 *   cards      at least one .drive-card is on screen
 *   counted    no card is still showing its count placeholder
 * Every main-process stdout line is echoed with its own offset, so the stages
 * in between (DB, drive enumeration, PowerShell) can be read off directly.
 * The app is closed through its own window afterwards, not killed.
 */
const { spawn } = require('child_process')
const http = require('http')
const crypto = require('crypto')

const exe = process.argv[2]
const port = Number(process.argv[3] || 9333)
const extra = process.argv.slice(4)
const t0 = Date.now()
const at = () => Date.now() - t0
const marks = {}
const mark = (k) => {
  if (marks[k] === undefined) {
    marks[k] = at()
    console.log(`  >> ${k} at ${marks[k]}ms`)
  }
}

const child = spawn(exe, [`--remote-debugging-port=${port}`, ...extra], { stdio: ['ignore', 'pipe', 'pipe'] })
const echo = (prefix) => (buf) => {
  for (const line of buf.toString().split(/\r?\n/)) {
    if (line.trim()) console.log(`${String(at()).padStart(6)}ms ${prefix}${line.slice(0, 220)}`)
  }
}
child.stdout.on('data', echo(''))
child.stderr.on('data', echo('ERR '))

function get(path) {
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
  const h = p.length < 126 ? Buffer.from([0x81, 0x80 | p.length]) : Buffer.from([0x81, 0x80 | 126, p.length >> 8, p.length & 255])
  const x = Buffer.alloc(p.length)
  for (let i = 0; i < p.length; i++) x[i] = p[i] ^ m[i % 4]
  return Buffer.concat([h, m, x])
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
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
      resolve({
        send: (method, params) => new Promise((r) => { const i = ++id; wait.set(i, r); sock.write(frame(JSON.stringify({ id: i, method, params }))) }),
        close: () => sock.destroy()
      })
    })
    req.on('error', reject)
    req.end()
  })
}

const PROBE = `JSON.stringify({
  vis: document.visibilityState,
  boot: !!(document.getElementById('root') && document.getElementById('root').children.length),
  shell: !!document.querySelector('.drive-grid-container, .drive-empty-state, .df-glass'),
  fcp: (performance.getEntriesByType('paint')[0] || {}).startTime || null,
  cards: document.querySelectorAll('.drive-card').length,
  loading: document.querySelectorAll('.drive-filecount-loading').length,
  empty: !!document.querySelector('.drive-empty-state'),
  counts: [...document.querySelectorAll('.drive-card')].map(c => (c.querySelector('.drive-name')||{}).textContent + ' = ' + (c.querySelector('.drive-filecount')||{}).textContent),
  fs: !!document.fullscreenElement
})`

;(async () => {
  let page = null
  while (!page && at() < 60000) {
    try {
      const t = await get('/json/list')
      page = t.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
    } catch { /* not up yet */ }
    if (!page) await new Promise((r) => setTimeout(r, 30))
  }
  if (!page) { console.log('no page target within 60s'); child.kill(); process.exit(1) }
  mark('target')
  const cdp = await connect(page.webSocketDebuggerUrl)
  let last = ''
  let doneAt = null
  while (at() < 90000) {
    const r = await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true })
    const v = r.result && r.result.result && r.result.result.value
    if (v) {
      const s = JSON.parse(v)
      if (s.vis === 'visible') mark('shown')
      if (s.boot) mark('boot-html')
      // First paint, converted from the renderer's clock to the spawn's.
      if (s.fcp && marks.target !== undefined && marks.firstPaint === undefined) {
        const nav = await cdp.send('Runtime.evaluate', { expression: 'performance.timeOrigin', returnByValue: true })
        marks.firstPaint = Math.round(nav.result.result.value + s.fcp - t0)
        console.log(`  >> firstPaint at ${marks.firstPaint}ms`)
      }
      if (s.shell) mark('shell')
      if (s.empty) mark('empty-state')
      if (s.cards > 0) mark('cards')
      if (s.cards > 0 && s.loading === 0) { mark('counted'); if (doneAt === null) doneAt = at() }
      if (v !== last) { console.log(`${String(at()).padStart(6)}ms [dom] ${v}`); last = v }
      if (doneAt !== null && at() - doneAt > 4000) break
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  console.log('SUMMARY ' + JSON.stringify(marks))
  await cdp.send('Runtime.evaluate', { expression: 'window.close()' })
  cdp.close()
  setTimeout(() => { try { child.kill() } catch { /* gone */ } process.exit(0) }, 4000)
})().catch((e) => { console.error('FATAL', e); child.kill(); process.exit(1) })
