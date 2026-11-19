/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- plain CommonJS run by Node/electron-builder, not TypeScript */
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

  // Only the built app belongs in app.asar: no source, tests, source maps or
  // development folders (the allowlist in electron-builder.yml should already
  // guarantee this; this makes a regression fail the build instead of shipping).
  const asar = require('@electron/asar')
  const entries = asar.listPackage(path.join(context.appOutDir, 'resources', 'app.asar')).map((e) => e.replace(/\\/g, '/'))
  const ours = entries.filter((e) => !e.startsWith('/node_modules/'))
  const leaked = ours.filter(
    (e) =>
      /\.map$/i.test(e) ||
      /\.(ts|tsx)$/i.test(e) ||
      /\.test\./i.test(e) ||
      /^\/(src|scratch|docs|\.github|\.claude|graphify-out|dist[^/]*)\//i.test(e) ||
      /(^|\/)\.env/i.test(e)
  )
  if (leaked.length > 0) {
    throw new Error(`app.asar contains development files that must not ship:\n  ${leaked.slice(0, 20).join('\n  ')}`)
  }
  console.log(`  • verify-pack: ${ours.length} app entries, no source, tests or source maps`)
}
