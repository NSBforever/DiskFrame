import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
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
