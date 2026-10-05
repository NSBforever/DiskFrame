import { resolve } from 'path'
import { execSync } from 'child_process'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Baked in at build time, not read at runtime - a packaged app ships no .git
// directory, so this is the only point where the source commit is knowable.
// Settings -> About shows this alongside the version so an installed build
// can be told apart from another with the same package.json version.
function buildCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim()
  } catch {
    return 'unknown'
  }
}

export default defineConfig({
  main: {
    define: {
      __DF_COMMIT__: JSON.stringify(buildCommit())
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          scanUtility: resolve('src/main/scanUtility.ts'),
          incrementalSyncWorker: resolve('src/main/incrementalSyncWorker.ts'),
          reconcileWorker: resolve('src/main/reconcileWorker.ts')
        }
      }
    }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    server: {
      headers: {
        'Content-Security-Policy':
          "default-src 'self' 'unsafe-inline' file: media: data: blob:; img-src * data: blob: file: media:; media-src * data: blob: file: media:;"
      }
    }
  }
})
