// electron-builder afterPack hook: refuse to produce an installer that is
// missing a binary DiskFrame needs at runtime.
//
// mpv.exe is gitignored (117 MB), so a build from a fresh checkout used to
// package without it silently - and every video then fell back to the ffmpeg
// stream path. ffmpeg/ffprobe/sharp/better-sqlite3 have to be unpacked from the
// asar to be executable or loadable at all. See README "Building".
const fs = require('fs')
const path = require('path')

const REQUIRED = [
  'resources/bin/win/mpv.exe',
  'node_modules/ffmpeg-static/ffmpeg.exe',
  'node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe',
  'node_modules/better-sqlite3/build/Release/better_sqlite3.node'
]

exports.default = async function verifyPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const unpacked = path.join(context.appOutDir, 'resources', 'app.asar.unpacked')
  const missing = REQUIRED.filter((rel) => {
    try {
      return fs.statSync(path.join(unpacked, rel)).size === 0
    } catch {
      return true
    }
  })
  // sharp's native binding lives in a platform package whose folder name
  // carries the platform, so look for it rather than naming one version.
  const sharpDir = path.join(unpacked, 'node_modules', '@img')
  const hasSharp =
    fs.existsSync(sharpDir) &&
    fs.readdirSync(sharpDir).some((d) => d.startsWith('sharp-win32-') && fs.existsSync(path.join(sharpDir, d, 'lib')))
  if (!hasSharp) missing.push('node_modules/@img/sharp-win32-*/lib')
  if (missing.length > 0) {
    throw new Error(
      `Packaged app is missing required binaries under ${unpacked}:\n  ${missing.join('\n  ')}\n` +
        'mpv.exe is not in git: put it at resources/bin/win/mpv.exe before building (see README).'
    )
  }
  console.log(`  • verify-pack: all ${REQUIRED.length + 1} runtime binaries present`)
}
