const Database = require('better-sqlite3')
const path = require('path')
const os = require('os')
const fs = require('fs')

const realUserData = path.join(os.homedir(), 'AppData', 'Roaming', 'diskframe')
const dbPath = path.join(realUserData, 'diskframe.db')
const db = new Database(dbPath)

const movRows = db.prepare("SELECT * FROM files WHERE ext IN ('.mov', '.MOV')").all()
const existingMovs = movRows.filter(f => fs.existsSync(f.path)).slice(0, 10)

const mainApp = require('./out/main/index.js')
const { probeMedia } = mainApp

async function testProbes() {
  console.log('=== TESTING PROBE ON 10 EXISTING MOV FILES ===')
  for (const f of existingMovs) {
    const probe = await probeMedia(f.path)
    console.log(`[PROBE] file="${f.name}" videoCodec="${probe.videoCodec}" audioCodec="${probe.audioCodec}" pixFmt="${probe.pixFmt}" isNative=${probe.isNative} isRemux=${probe.isRemux}`)
  }
}

testProbes().catch(e => console.error('Probe test failed:', e))
