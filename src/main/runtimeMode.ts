/**
 * Diagnostic ("safe") launch mode.
 *
 * Normal startup fans out immediately: a drive poll every 3s, a recursive
 * filesystem watcher, a thumbnail backfill and a capture-date backfill, each
 * spawning sharp/ffmpeg. That makes it impossible to tell which subsystem is
 * responsible when the app becomes unresponsive or takes the machine with it.
 *
 * Safe mode starts the window and nothing else, then lets one subsystem at a
 * time be re-enabled, so a fault can be attributed instead of guessed at.
 *
 * Pure and import-free so `npm test` can exercise it.
 */

export interface SafeModeConfig {
  enabled: boolean
  /** Only this folder is indexed/browsed. No drive enumeration, no volume walk. */
  sampleFolder: string | null
  /** Subsystems explicitly re-enabled for this run, for bisecting a trigger. */
  allow: Set<string>
  /** Hard ceiling on files admitted from the sample folder. */
  maxFiles: number
  /** Verbose per-subsystem logging to a file. */
  verboseLog: boolean
  /** Skip GPU compositing - the confirmed bugcheck was in the graphics/power stack. */
  disableGpu: boolean
}

/** Subsystems that stay off in safe mode unless named in --safe-allow. */
export const SAFE_MODE_SUBSYSTEMS = [
  'scan', // full/incremental drive scans
  'watcher', // chokidar filesystem watcher
  'periodic', // IndexingService 30-min rescan + 3s drive poll
  'thumbnails', // background thumbnail generation (sharp/ffmpeg)
  'exif', // capture-date backfill (exifr/ffprobe)
  'hoverpreview', // video hover previews in the grid
  'mpv' // embedded mpv player
] as const

export type Subsystem = (typeof SAFE_MODE_SUBSYSTEMS)[number]

function argValue(argv: string[], name: string): string | null {
  const prefix = `--${name}=`
  for (const a of argv) {
    if (a.startsWith(prefix)) return a.slice(prefix.length)
    }
  const idx = argv.indexOf(`--${name}`)
  if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1]
  return null
}

export function parseSafeMode(argv: string[], env: Record<string, string | undefined> = {}): SafeModeConfig {
  const enabled = argv.includes('--safe-mode') || env.DISKFRAME_SAFE_MODE === '1'
  const rawAllow = argValue(argv, 'safe-allow') ?? env.DISKFRAME_SAFE_ALLOW ?? ''
  const allow = new Set(
    rawAllow
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => (SAFE_MODE_SUBSYSTEMS as readonly string[]).includes(s))
  )
  const rawMax = argValue(argv, 'safe-max-files') ?? env.DISKFRAME_SAFE_MAX_FILES ?? ''
  const parsedMax = Number.parseInt(rawMax, 10)

  return {
    enabled,
    sampleFolder: argValue(argv, 'sample-folder') ?? env.DISKFRAME_SAMPLE_FOLDER ?? null,
    allow,
    maxFiles: Number.isFinite(parsedMax) && parsedMax > 0 ? Math.min(parsedMax, 5000) : 200,
    verboseLog: enabled,
    disableGpu: argv.includes('--safe-no-gpu') || env.DISKFRAME_SAFE_NO_GPU === '1'
  }
}

/**
 * Whether a subsystem may run. Outside safe mode everything runs as before, so
 * this is a no-op for normal launches.
 */
export function subsystemEnabled(cfg: SafeModeConfig, name: Subsystem): boolean {
  if (!cfg.enabled) return true
  return cfg.allow.has(name)
}
