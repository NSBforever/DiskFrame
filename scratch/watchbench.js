/**
 * Bounded before/after for the confirmed freeze cause.
 *
 * `chokidar.watch(root, {recursive})` cannot attach without first walking the
 * tree; `fs.watch(root, {recursive:true})` attaches through the OS. This
 * measures both on ONE representative folder (never the whole drive) and
 * samples main-thread event-loop stalls while each attaches, because
 * "Not Responding" is an event-loop property.
 *
 * Usage: electron (ELECTRON_RUN_AS_NODE=1) scratch/watchbench.js <folder>
 */
const fs = require('fs')
const target = process.argv[2]
if (!target) {
  console.error('usage: watchbench.js <folder>')
  process.exit(1)
}

const TICK = 50
function startLagSampler() {
  let last = Date.now()
  let worst = 0
  let total = 0
  const t = setInterval(() => {
    const now = Date.now()
    const lag = now - last - TICK
    last = now
    if (lag > worst) worst = lag
    if (lag > 0) total += lag
  }, TICK)
  return {
    stop() {
      clearInterval(t)
      return { worst, total }
    }
  }
}

function benchFsWatch() {
  return new Promise((resolve) => {
    const s = startLagSampler()
    const t0 = Date.now()
    const w = fs.watch(target, { recursive: true, persistent: true })
    // fs.watch is synchronous to attach: once the call returns, the OS is
    // reporting changes. There is no "ready" to wait for.
    const elapsed = Date.now() - t0
    setTimeout(() => {
      const lag = s.stop()
      w.close()
      resolve({ name: 'fs.watch recursive (after)', attachMs: elapsed, ...lag })
    }, 2000)
  })
}

function benchChokidar() {
  return new Promise((resolve) => {
    const chokidar = require('chokidar')
    const s = startLagSampler()
    const t0 = Date.now()
    const w = chokidar.watch(target, {
      // Exactly the options the shipped watcher used.
      ignored: [
        /(^|[\/\\])\../,
        '**/node_modules/**',
        '**/$Recycle.Bin/**',
        '**/System Volume Information/**',
        '**/Windows/**',
        '**/Program Files/**',
        '**/AppData/**',
        '**/ProgramData/**'
      ],
      persistent: true,
      ignoreInitial: true,
      depth: 6,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 }
    })
    w.on('ready', () => {
      const elapsed = Date.now() - t0
      const lag = s.stop()
      w.close()
      resolve({ name: 'chokidar depth:6 (before)', attachMs: elapsed, ...lag })
    })
    w.on('error', (e) => console.warn('chokidar error', e.message))
  })
}

;(async () => {
  console.log(`target: ${target}`)
  // fs.watch first, so chokidar gets the benefit of a warm filesystem cache -
  // this biases the comparison AGAINST the change being measured.
  const a = await benchFsWatch()
  console.log(a)
  const b = await benchChokidar()
  console.log(b)
  process.exit(0)
})()
