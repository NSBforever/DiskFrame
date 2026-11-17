// Refuse to release a set of files installed copies could not update from.
//
//   node scripts/verify-release.cjs [dir]        (default: dist)
//
// electron-updater reads latest.yml from the GitHub release, downloads the
// installer it names and rejects it unless its SHA-512 matches. So a release
// needs all four files, for the version in package.json, and latest.yml has to
// describe the installer that is actually next to it. Run after
// `npm run build:win`, and by the release workflow before anything is
// uploaded and again against the published assets.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const { name, version } = require('../package.json')
const dir = path.resolve(process.argv[2] || 'dist')
const problems = []
const size = (f) => {
  try {
    return fs.statSync(path.join(dir, f)).size
  } catch {
    return 0
  }
}

const setup = `${name}-${version}-setup.exe`
// electron-builder writes "diskframe 1.2.0.exe"; GitHub stores it as "diskframe.1.2.0.exe".
const portable = [`${name} ${version}.exe`, `${name}.${version}.exe`].find((f) => size(f) > 0)

for (const f of [setup, `${setup}.blockmap`, 'latest.yml']) if (size(f) === 0) problems.push(`missing or empty: ${f}`)
if (!portable) problems.push(`missing or empty: ${name} ${version}.exe (portable)`)

const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined
if (tag && tag !== `v${version}`) problems.push(`tag is ${tag} but package.json is ${version}`)

if (size('latest.yml') > 0) {
  const yml = fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8')
  const field = (k) => new RegExp(`^${k}:\\s*'?([^'\\r\\n]+)'?\\s*$`, 'm').exec(yml)?.[1]
  if (field('version') !== version) problems.push(`latest.yml is for ${field('version')}, package.json is ${version}`)
  if (field('path') !== setup) problems.push(`latest.yml points at ${field('path')}, expected ${setup}`)
  if (size(setup) > 0) {
    const listed = Number(/^\s+size:\s*(\d+)/m.exec(yml)?.[1])
    if (listed !== size(setup)) problems.push(`latest.yml says ${listed} bytes, ${setup} is ${size(setup)}`)
    const sha = crypto.createHash('sha512').update(fs.readFileSync(path.join(dir, setup))).digest('base64')
    if (field('sha512') !== sha) problems.push(`latest.yml sha512 does not match ${setup}: an installed copy would discard this download`)
  }
}

if (problems.length) {
  console.error(`Release ${version} in ${dir} is not publishable:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log(`Release ${version} in ${dir}: ${setup}, its blockmap, latest.yml and ${portable} are present and consistent.`)
