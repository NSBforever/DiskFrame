/**
 * End-to-end check that a real Windows SUBST alias is resolved, not listed.
 *
 * Deliberately NOT part of `npm test`. It creates an OS-level drive mapping, and
 * a mapping outlives the process that made it - if the runner is killed between
 * create and cleanup, the mapping is left on the machine. That is not
 * hypothetical: it is exactly how a stray T: came to be reported as a third
 * drive in this app, with C:'s capacity, after an abandoned test. The unit
 * coverage in src/main/driveIdentity.test.ts is pure and needs no mapping, and
 * that is what runs by default.
 *
 * Run explicitly:
 *   node scratch/aliascheck.js
 *
 * It never touches the production catalogue, and it removes its own mapping on
 * every exit path - normal, thrown, and Ctrl-C.
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

// A letter far from anything a person is likely to be using, and verified free
// before use. Never reuses T: - that one has history.
const LETTER = 'Q:'
const BACKING = path.join(os.tmpdir(), 'diskframe-aliascheck')

function ps(script) {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 20000
  })
}

function substList() {
  try {
    return execFileSync('cmd', ['/c', 'subst'], { encoding: 'utf8', timeout: 10000 })
  } catch {
    return ''
  }
}

function removeMapping() {
  try {
    execFileSync('cmd', ['/c', 'subst', LETTER, '/D'], { stdio: 'ignore', timeout: 10000 })
  } catch {
    /* already gone */
  }
}

function enumerate() {
  // The same two sources the app's own enumeration uses.
  const out = ps(
    `$ld = Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeSerialNumber;` +
      `$v = Get-CimInstance Win32_Volume | Where-Object { $_.DriveLetter } | Select-Object DriveLetter,DeviceID;` +
      `@{ logical = @($ld); volumes = @($v) } | ConvertTo-Json -Depth 4 -Compress`
  )
  const parsed = JSON.parse(out)
  const volumes = new Map(
    (parsed.volumes || []).map((v) => [String(v.DriveLetter).toUpperCase(), String(v.DeviceID)])
  )
  return (parsed.logical || []).map((l) => {
    const letter = String(l.DeviceID).toUpperCase()
    return {
      letter,
      volumeId: volumes.get(letter) ?? null,
      fsSerial: l.VolumeSerialNumber ? String(l.VolumeSerialNumber) : null
    }
  })
}

let created = false
const cleanup = () => {
  if (!created) return
  created = false
  removeMapping()
  const still = substList().includes(LETTER.replace(':', ''))
  console.log(`cleanup: mapping removed, still present = ${still}`)
  if (still) console.error('!! FAILED TO REMOVE MAPPING - remove it with: subst ' + LETTER + ' /D')
}
process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})
process.on('uncaughtException', (e) => {
  console.error('FAILED', e)
  cleanup()
  process.exit(1)
})

// Imported straight from source: this script needs no Electron (only
// child_process and fs), and Node strips the types itself. Requiring the built
// bundle would not work anyway - driveIdentity is bundled into out/main/index.js
// rather than emitted on its own.
const { resolveDriveLetters, independentLetters } = require('../src/main/driveIdentity.ts')

// Guard: never touch a letter that is already in use by anything.
if (fs.existsSync(LETTER + '\\')) {
  console.error(`${LETTER} already exists - refusing to touch it. Pick another letter.`)
  process.exit(1)
}

fs.mkdirSync(BACKING, { recursive: true })
fs.writeFileSync(path.join(BACKING, 'marker.txt'), 'disposable fixture for aliascheck\n')

const before = enumerate()
console.log('before:', independentLetters(resolveDriveLetters(before)).join(' '))

execFileSync('cmd', ['/c', 'subst', LETTER, BACKING], { stdio: 'ignore', timeout: 10000 })
created = true
console.log(`created ${LETTER} -> ${BACKING}`)

const during = enumerate()
const resolvedDuring = resolveDriveLetters(during)
const listed = independentLetters(resolvedDuring)
const aliasRow = resolvedDuring.find((r) => r.letter === LETTER)
const backingLetter = BACKING.slice(0, 2).toUpperCase()

console.log('during:', listed.join(' '))
console.log('alias row:', JSON.stringify(aliasRow))

const checks = [
  [`${LETTER} enumerates as a logical disk`, during.some((d) => d.letter === LETTER)],
  [`${LETTER} has no volume identity of its own`, aliasRow ? aliasRow.volumeId === null : false],
  [`${LETTER} resolves to ${backingLetter}`, aliasRow ? aliasRow.aliasOf === backingLetter : false],
  [`${LETTER} is NOT listed as a drive`, !listed.includes(LETTER)],
  [`${backingLetter} is still listed`, listed.includes(backingLetter)],
  [
    'no genuine volume was dropped',
    independentLetters(resolveDriveLetters(before)).every((l) => listed.includes(l))
  ],
  [`${LETTER} is not reported unverified (it is verifiably ${backingLetter})`, aliasRow ? aliasRow.identityUnverified === false : false]
]

cleanup()

const after = enumerate()
const listedAfter = independentLetters(resolveDriveLetters(after))
checks.push([`${LETTER} gone after cleanup`, !after.some((d) => d.letter === LETTER)])
checks.push([
  'drive list back to its original set',
  listedAfter.sort().join(',') === independentLetters(resolveDriveLetters(before)).sort().join(',')
])
checks.push(['backing files preserved', fs.existsSync(path.join(BACKING, 'marker.txt'))])

console.log()
let failed = 0
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failed++
}
console.log(`\n${checks.length - failed}/${checks.length} passed`)
console.log(`backing folder left in place (disposable): ${BACKING}`)
process.exit(failed === 0 ? 0 : 1)
