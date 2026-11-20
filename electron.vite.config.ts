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
    const sha = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim()
    // A build from uncommitted source must not carry a clean commit's name:
    // it is not that commit, and About would say it was. Generated files the
    // build itself rewrites (tsbuildinfo) do not count.
    const dirty = execSync('git status --porcelain --untracked-files=no -- src electron.vite.config.ts package.json', { cwd: __dirname })
      .toString()
      .trim()
    return dirty ? `${sha}-dirty` : sha
  } catch {
    return 'unknown'
  }
}

// Production bundles for main and preload are minified: they used to ship as
// readable source with comments (index.js, 6,286 lines). This only raises the
// effort of reading them - a desktop app can always be decompiled. No source
// maps are emitted; scripts/verify-pack.cjs fails a build that packages one.
export default defineConfig(({ command }) => ({
  main: {
    define: {
      __DF_COMMIT__: JSON.stringify(buildCommit()),
      // PostHog EU project key (public, write-only by design) from the build environment;
      // unset = analytics stays inert. Opt-in only; see src/main/analytics.ts.
      __DF_POSTHOG_KEY__: JSON.stringify(process.env.DF_POSTHOG_KEY ?? ''),
      // Google OAuth "Desktop app" client, from the build environment (a CI
      // secret for releases). Google treats a desktop client as public, but it
      // still stays out of git. Unset = Calendar shows as not set up.
      __DF_GOOGLE_CLIENT_ID__: JSON.stringify(process.env.DF_GOOGLE_CLIENT_ID ?? ''),
      __DF_GOOGLE_CLIENT_SECRET__: JSON.stringify(process.env.DF_GOOGLE_CLIENT_SECRET ?? '')
    },
    build: {
      minify: command === 'build',
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          scanUtility: resolve('src/main/scanUtility.ts'),
          incrementalSyncWorker: resolve('src/main/incrementalSyncWorker.ts'),
          reconcileWorker: resolve('src/main/reconcileWorker.ts'),
          heicWorker: resolve('src/main/heicWorker.ts'),
          libraryWorker: resolve('src/main/libraryWorker.ts'),
          ffmpegWorker: resolve('src/main/ffmpegWorker.ts')
        }
      }
    }
  },
  preload: { build: { minify: command === 'build' } },
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
}))
