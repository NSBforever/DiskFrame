/**
 * Which drives exist and which volume each letter is, without PowerShell.
 *
 * Measured on the owner's machine before this existed: the drive page took
 * 4.3s to show its first card on a warm launch and 8.4s on the first launch of
 * the day, with only C: connected. None of that was disk work. node-disk-info
 * shells out to `wmic`, which Windows 11 no longer ships, so every poll failed
 * and fell back to PowerShell; the hardware query was another PowerShell
 * script, started up to three times concurrently; and every volume identity was
 * one more PowerShell process, run sequentially per letter. A PowerShell start
 * is 0.5-3s on this machine depending on how cold it is, and an external drive
 * added more of them.
 *
 * What replaces them:
 *   mountvol      a tiny native exe (~50ms) that lists every volume GUID and
 *                 the letter it is mounted at. The GUID is exactly the
 *                 `\\?\Volume{...}\` string the catalogue already stores as
 *                 volume_id (it is what Win32_Volume.DeviceID returned), so no
 *                 record changes identity.
 *   fs.statfs     capacity and free space, per letter, asynchronously, each with
 *                 its own timeout - a sleeping or unplugged device delays only
 *                 its own card.
 *   fs.stat .dev  on Windows this is the filesystem's volume serial, the same
 *                 value Win32_LogicalDisk.VolumeSerialNumber reported, which is
 *                 what resolves a SUBST alias to the volume behind it.
 *
 * PowerShell is still used for one thing only - bus type, medium and model -
 * and that runs in the background and never holds up the list.
 */
import { execFile } from 'child_process'
import * as fs from 'fs'

/** Parses `mountvol` output into letter -> volume GUID path. Pure, for tests.
 *  The header and the "no mount points" line are localised; the volume and
 *  path lines are not, so only those are read. */
export function parseMountvol(output: string): Map<string, string> {
  const out = new Map<string, string>()
  let current: string | null = null
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (/^\\\\\?\\Volume\{[0-9a-fA-F-]+\}\\$/.test(line)) {
      current = line
      continue
    }
    const m = line.match(/^([A-Za-z]):\\$/)
    if (m && current) out.set(`${m[1].toUpperCase()}:`, current)
  }
  return out
}

/** The filesystem serial in the 8-hex-digit form Win32_LogicalDisk used. */
export function serialFromDev(dev: number | bigint): string | null {
  const n = typeof dev === 'bigint' ? Number(dev & 0xffffffffn) : dev >>> 0
  return n ? n.toString(16).toUpperCase().padStart(8, '0') : null
}

let volumesCache: { at: number; map: Map<string, string> } | null = null
let volumesInFlight: Promise<Map<string, string> | null> | null = null
/** How long one mountvol answer is reused. Several callers ask within the same
 *  burst (drive poll, open-drive, availability refresh); one process serves all. */
const VOLUMES_TTL_MS = 1000

/**
 * Letter -> volume GUID for every mounted volume. null when mountvol itself
 * could not run, which callers treat as "unknown", never as "no volumes".
 */
export function listMountedVolumes(): Promise<Map<string, string> | null> {
  if (volumesCache && Date.now() - volumesCache.at < VOLUMES_TTL_MS) {
    return Promise.resolve(volumesCache.map)
  }
  if (volumesInFlight) return volumesInFlight
  volumesInFlight = new Promise<Map<string, string> | null>((resolve) => {
    execFile('mountvol', [], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      volumesInFlight = null
      // mountvol prints its listing after the usage text and exits non-zero
      // when given no arguments on some builds, so the output decides, not
      // the exit code.
      const map = parseMountvol(String(stdout ?? ''))
      if (map.size === 0 && err) return resolve(null)
      volumesCache = { at: Date.now(), map }
      resolve(map)
    })
  })
  return volumesInFlight
}

/** Forget the cached mountvol answer, e.g. when a device has just appeared. */
export function invalidateMountedVolumes(): void {
  volumesCache = null
}

export interface ProbedDrive {
  letter: string
  totalBytes: number
  freeBytes: number
  fsSerial: string | null
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      () => {
        clearTimeout(t)
        resolve('timeout')
      }
    )
  })
}

/** Last answer per letter, so a device that is slow to respond keeps its card
 *  (with the figures it last reported) instead of flickering out of the list. */
const lastProbe = new Map<string, ProbedDrive | null>()
/** A probe still running is not started again: a hung network letter must not
 *  stack one blocked libuv thread per poll. */
const probing = new Map<string, Promise<ProbedDrive | null>>()

function probeLetter(letter: string): Promise<ProbedDrive | null> {
  const running = probing.get(letter)
  if (running) return running
  const root = `${letter}\\`
  const p = (async (): Promise<ProbedDrive | null> => {
    try {
      const [sf, st] = await Promise.all([fs.promises.statfs(root), fs.promises.stat(root)])
      const totalBytes = sf.blocks * sf.bsize
      // A letter with no medium (an empty card reader slot) answers with zero
      // blocks or an error; it is not presented as a drive.
      if (!totalBytes) return null
      return { letter, totalBytes, freeBytes: sf.bavail * sf.bsize, fsSerial: serialFromDev(st.dev) }
    } catch {
      return null
    }
  })().then((r) => {
    probing.delete(letter)
    lastProbe.set(letter, r)
    return r
  })
  probing.set(letter, p)
  return p
}

/**
 * Every letter that currently answers as a drive. Each letter is probed on its
 * own with `perDriveMs` to answer; one that does not is reported with what it
 * last answered (or left out if it never has), so it cannot hold up the rest.
 */
export async function probeDrives(extraLetters: Iterable<string> = [], perDriveMs = 1500): Promise<ProbedDrive[]> {
  // A: and B: are only probed when something says they are real volumes -
  // probing an absent floppy controller is the one probe that can be slow for
  // no reason.
  const letters = new Set<string>()
  for (let c = 'C'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) letters.add(String.fromCharCode(c) + ':')
  for (const l of extraLetters) letters.add(l.slice(0, 2).toUpperCase())
  const results = await Promise.all(
    [...letters].map(async (letter) => {
      const r = await withTimeout(probeLetter(letter), perDriveMs)
      return r === 'timeout' ? (lastProbe.get(letter) ?? null) : r
    })
  )
  return results.filter((r): r is ProbedDrive => r !== null)
}
