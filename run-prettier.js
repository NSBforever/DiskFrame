const { execSync } = require('child_process')
const path = require('path')

const files = [
  'src/renderer/src/App.tsx',
  'src/main/index.ts',
  'src/main/scanner.ts',
  'src/preload/index.ts',
  'src/preload/index.d.ts',
  'electron.vite.config.ts'
]

files.forEach((f) => {
  try {
    execSync(`node node_modules/prettier/bin/prettier.cjs --write "${f}"`, {
      cwd: __dirname,
      stdio: 'inherit'
    })
    console.log('✓', f)
  } catch (e) {
    console.error('✗', f, e.message)
  }
})
