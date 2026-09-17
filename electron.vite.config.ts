import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          scanWorker: resolve('src/main/scanWorker.ts'),
          scanUtility: resolve('src/main/scanUtility.ts'),
          incrementalSyncWorker: resolve('src/main/incrementalSyncWorker.ts')
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
