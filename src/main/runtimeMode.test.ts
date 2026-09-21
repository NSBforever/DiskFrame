import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSafeMode, subsystemEnabled } from './runtimeMode.ts'

test('normal launch leaves every subsystem enabled', () => {
  const cfg = parseSafeMode(['electron', '.'], {})
  assert.equal(cfg.enabled, false)
  for (const s of ['scan', 'watcher', 'periodic', 'thumbnails', 'exif', 'hoverpreview', 'mpv'] as const) {
    assert.ok(subsystemEnabled(cfg, s), `${s} should run normally`)
  }
})

test('safe mode disables every background subsystem by default', () => {
  const cfg = parseSafeMode(['electron', '.', '--safe-mode'], {})
  assert.equal(cfg.enabled, true)
  for (const s of ['scan', 'watcher', 'periodic', 'thumbnails', 'exif', 'hoverpreview', 'mpv'] as const) {
    assert.ok(!subsystemEnabled(cfg, s), `${s} must stay off in safe mode`)
  }
})

test('subsystems can be re-enabled one at a time to isolate a trigger', () => {
  const cfg = parseSafeMode(['--safe-mode', '--safe-allow=thumbnails'], {})
  assert.ok(subsystemEnabled(cfg, 'thumbnails'))
  assert.ok(!subsystemEnabled(cfg, 'scan'))
  assert.ok(!subsystemEnabled(cfg, 'watcher'))
})

test('several subsystems can be allowed together', () => {
  const cfg = parseSafeMode(['--safe-mode', '--safe-allow=scan,watcher'], {})
  assert.ok(subsystemEnabled(cfg, 'scan'))
  assert.ok(subsystemEnabled(cfg, 'watcher'))
  assert.ok(!subsystemEnabled(cfg, 'thumbnails'))
})

test('unknown subsystem names are ignored rather than silently enabling things', () => {
  const cfg = parseSafeMode(['--safe-mode', '--safe-allow=everything,scan'], {})
  assert.ok(subsystemEnabled(cfg, 'scan'))
  assert.equal(cfg.allow.size, 1)
})

test('environment variables work for launchers that cannot pass argv', () => {
  const cfg = parseSafeMode(['electron', '.'], {
    DISKFRAME_SAFE_MODE: '1',
    DISKFRAME_SAFE_ALLOW: 'exif',
    DISKFRAME_SAMPLE_FOLDER: 'C:\\samples'
  })
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.sampleFolder, 'C:\\samples')
  assert.ok(subsystemEnabled(cfg, 'exif'))
  assert.ok(!subsystemEnabled(cfg, 'scan'))
})

test('sample folder accepts both --flag=value and --flag value', () => {
  assert.equal(parseSafeMode(['--sample-folder=C:\\a'], {}).sampleFolder, 'C:\\a')
  assert.equal(parseSafeMode(['--sample-folder', 'C:\\b'], {}).sampleFolder, 'C:\\b')
})

test('file ceiling defaults small and is capped', () => {
  assert.equal(parseSafeMode(['--safe-mode'], {}).maxFiles, 200)
  assert.equal(parseSafeMode(['--safe-mode', '--safe-max-files=50'], {}).maxFiles, 50)
  assert.equal(parseSafeMode(['--safe-mode', '--safe-max-files=999999'], {}).maxFiles, 5000, 'capped')
  assert.equal(parseSafeMode(['--safe-mode', '--safe-max-files=-5'], {}).maxFiles, 200, 'nonsense falls back')
  assert.equal(parseSafeMode(['--safe-mode', '--safe-max-files=abc'], {}).maxFiles, 200)
})

test('GPU can be taken out of the picture for the graphics-stack hypothesis', () => {
  assert.equal(parseSafeMode(['--safe-mode'], {}).disableGpu, false)
  assert.equal(parseSafeMode(['--safe-mode', '--safe-no-gpu'], {}).disableGpu, true)
  assert.equal(parseSafeMode(['--safe-mode'], { DISKFRAME_SAFE_NO_GPU: '1' }).disableGpu, true)
})
