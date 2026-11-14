import { readFileSync, writeFileSync } from 'fs'

/**
 * Render on the graphics adapter the screen is plugged into.
 *
 * On a laptop with two GPUs Chromium rendered DiskFrame on the discrete one
 * while the panel hangs off the integrated one, so every frame was copied
 * between adapters and the GPU thread sat in Present for ~10 ms of each frame.
 * Measured on such a machine (2880x1800 @ 90 Hz, 10,000 photos), same build:
 *
 *                              discrete        integrated (owns the panel)
 *   brisk scroll, median frame 33 ms           12.8 ms
 *   wheel -> screen, p50/p95   91 / 211 ms     52 / 74 ms
 *   Present, per frame         ~10 ms          ~1 ms
 *
 * Which adapter is right is a property of the hardware, and a GPU can only be
 * chosen with a command-line switch before the app is ready - before anything
 * can be asked about the hardware. So each run works out the answer in the
 * background and stores it; the next launch applies it. With one GPU, or
 * screens on both, nothing is forced and Chromium's default stands.
 *
 * DF_GPU=low|high|default overrides the stored answer for one run.
 */
export type GpuSwitch = 'force_low_power_gpu' | 'force_high_performance_gpu'

export interface GpuAdapter {
  vendorId: number
  deviceId: number
  /** A screen is attached to this adapter right now. */
  hasDisplay: boolean
}

const NVIDIA = 0x10de
const INTEL = 0x8086
const AMD = 0x1002

/** True/false when it can be told which of two adapters is the integrated one. */
function isIntegrated(a: GpuAdapter, other: GpuAdapter): boolean | null {
  if (a.vendorId === NVIDIA) return false
  if (a.vendorId === INTEL) return other.vendorId !== INTEL ? true : null
  // AMD makes both kinds: integrated beside an NVIDIA card, discrete beside Intel graphics.
  if (a.vendorId === AMD) return other.vendorId === NVIDIA ? true : other.vendorId === INTEL ? false : null
  return null
}

/**
 * The switch that makes Chromium render on the adapter that owns every screen,
 * or null to leave the choice alone.
 * ponytail: two adapters only, told apart by vendor. Two GPUs of one vendor
 * (AMD APU + Radeon card), or three, fall through to Chromium's default; ask
 * DXGI for adapter LUIDs through a native module if that ever matters.
 */
export function gpuSwitchFor(adapters: GpuAdapter[]): GpuSwitch | null {
  if (adapters.length !== 2) return null
  const owners = adapters.filter((a) => a.hasDisplay)
  if (owners.length !== 1) return null
  const owner = owners[0]
  const integrated = isIntegrated(owner, adapters[0] === owner ? adapters[1] : adapters[0])
  if (integrated === null) return null
  return integrated ? 'force_low_power_gpu' : 'force_high_performance_gpu'
}

/**
 * Win32_VideoController rows as `ConvertTo-Json` prints them (one object, or an
 * array) -> adapters. A row drives a screen when it reports a current
 * resolution. Rows without a PCI id (remote-desktop and virtual display
 * drivers) are not GPUs Chromium can pick and are dropped.
 */
export function parseVideoControllers(json: string): GpuAdapter[] {
  let rows: unknown
  try {
    rows = JSON.parse(json)
  } catch {
    return []
  }
  const out: GpuAdapter[] = []
  for (const r of Array.isArray(rows) ? rows : [rows]) {
    const row = r as { PNPDeviceID?: unknown; CurrentHorizontalResolution?: unknown } | null
    const m = /VEN_([0-9A-F]{4})&DEV_([0-9A-F]{4})/i.exec(String(row?.PNPDeviceID ?? ''))
    if (!m) continue
    out.push({ vendorId: parseInt(m[1], 16), deviceId: parseInt(m[2], 16), hasDisplay: Number(row?.CurrentHorizontalResolution) > 0 })
  }
  return out
}

export const VIDEO_CONTROLLER_QUERY =
  'Get-CimInstance Win32_VideoController | Select-Object PNPDeviceID, CurrentHorizontalResolution | ConvertTo-Json -Compress'

/** The answer stored by the last run, with DF_GPU taking precedence. */
export function readGpuSwitch(file: string, env: string | undefined): GpuSwitch | null {
  if (env === 'low') return 'force_low_power_gpu'
  if (env === 'high') return 'force_high_performance_gpu'
  if (env === 'default') return null
  try {
    const v = (JSON.parse(readFileSync(file, 'utf8')) as { switch?: unknown }).switch
    return v === 'force_low_power_gpu' || v === 'force_high_performance_gpu' ? v : null
  } catch {
    return null // first run, or unreadable: Chromium's default
  }
}

export function writeGpuSwitch(file: string, value: GpuSwitch | null): void {
  try {
    writeFileSync(file, JSON.stringify({ switch: value }))
  } catch {
    /* a read-only profile: the next run simply asks again */
  }
}
