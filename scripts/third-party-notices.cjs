/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- plain CommonJS run by Node/electron-builder, not TypeScript */
// Writes resources/THIRD_PARTY_NOTICES.txt: every production dependency that
// ships inside DiskFrame, with its licence text, plus the bundled ffmpeg/
// ffprobe/mpv binaries. Run before packaging (npm run notices). Deterministic:
// sorted, no timestamps, so an unchanged dependency tree rewrites the same file.
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const seen = new Map()

function dirOf(name, from) {
  // Node resolution, walking up node_modules folders from the dependant.
  for (let d = from; ; d = path.dirname(d)) {
    const candidate = path.join(d, 'node_modules', name)
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
    if (path.dirname(d) === d) return null
  }
}

function visit(name, from) {
  const dir = dirOf(name, from)
  if (!dir) return
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const key = `${p.name}@${p.version}`
  if (seen.has(key)) return
  const licenceFile = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f))
  seen.set(key, {
    name: p.name,
    version: p.version,
    license: typeof p.license === 'string' ? p.license : (p.license && p.license.type) || 'see text',
    text: licenceFile ? fs.readFileSync(path.join(dir, licenceFile), 'utf8').trim() : null
  })
  for (const dep of Object.keys({ ...p.dependencies, ...p.optionalDependencies })) visit(dep, dir)
}

for (const dep of Object.keys(pkg.dependencies || {})) visit(dep, root)

const items = [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1))
const out = [
  'DiskFrame - third-party notices',
  '================================',
  '',
  'DiskFrame includes the following open-source software. Each is used under its own licence, reproduced below.',
  '',
  'Bundled programs (run as separate executables):',
  '- mpv (mpv.exe): GPLv2+ or LGPLv2.1+ depending on build configuration. Source: https://github.com/mpv-player/mpv',
  '- FFmpeg / FFprobe (via ffmpeg-static and ffprobe-static): LGPL/GPL depending on build configuration. Source: https://ffmpeg.org/',
  '',
  `Node.js packages (${items.length}):`,
  ''
]
for (const i of items) {
  out.push('-'.repeat(78), `${i.name} ${i.version} - ${i.license}`, '')
  if (i.text) out.push(i.text, '')
}
fs.writeFileSync(path.join(root, 'resources', 'THIRD_PARTY_NOTICES.txt'), out.join('\n') + '\n')
console.log(`third-party notices: ${items.length} packages -> resources/THIRD_PARTY_NOTICES.txt`)
