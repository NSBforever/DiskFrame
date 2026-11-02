/**
 * Deleting a file without ever letting it become a silent permanent delete.
 *
 * Every user-facing delete in DiskFrame promises the OS Recycle Bin ("This will
 * move the file to the OS Recycle Bin"), and the 30-day trash auto-purge runs
 * unprompted on every startup. Two things used to turn those into permanent
 * deletes nobody confirmed:
 *
 *   - safeDelete fell back to fs.unlinkSync whenever `trash` threw.
 *   - `trash` itself hands paths to sindresorhus/recycle-bin, which runs
 *     IFileOperation with FOF_NOCONFIRMATION and without FOF_WANTNUKEWARNING.
 *     On a volume Windows keeps no Recycle Bin for - a removable stick or SD
 *     card, a network share - that combination destroys the file outright and
 *     still reports success.
 *
 * Both hit hardest on external drives, the ones least likely to have a bin. So
 * the drive type is read first and only a fixed local disk is handed to
 * `trash`; anything else, including a type that could not be read, is refused
 * and the file is left exactly where it is. Callers keep the row in
 * DiskFrame's Trash when this throws, so it is retried or reported instead.
 *
 * ponytail: a fixed drive with its bin turned off (BitBucket NukeOnDelete) or a
 * file bigger than the bin's size cap is still destroyed by `trash` without a
 * prompt. Catching that needs the per-volume BitBucket registry keys; add it if
 * a disabled bin ever turns up on a drive DiskFrame deletes from.
 *
 * The parse and the decisions are pure so `npm test` can exercise them.
 */
import { execFile } from 'child_process'
import * as fs from 'fs'

/** `[IO.DriveInfo]::GetDrives()` output, one `C:\|Fixed` line per letter, as 'C:' -> 'Fixed'. */
export function parseDriveTypes(stdout: string): Map<string, string> {
  const types = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^([A-Za-z]):\\?\|(\w+)$/.exec(line.trim())
    if (m) types.set(`${m[1].toUpperCase()}:`, m[2])
  }
  return types
}

/** Why `filePath` must not be handed to `trash`, or null when its drive has a Recycle Bin. */
export function recycleRefusal(filePath: string, types: Map<string, string> | null): string | null {
  if (!/^[A-Za-z]:/.test(filePath)) return 'not on a lettered local drive, so there is no Recycle Bin'
  const letter = filePath.slice(0, 2).toUpperCase()
  const type = types?.get(letter)
  if (type === 'Fixed') return null
  return type ? `${letter} is a ${type} drive, which has no Recycle Bin` : `could not read the drive type of ${letter}`
}

/**
 * Sends `filePath` to the Recycle Bin, or throws and leaves it on disk. There
 * is deliberately no unlink fallback: a recycle that fails stays failed.
 */
export async function recycle(
  filePath: string,
  types: Map<string, string> | null,
  sendToBin: (p: string) => Promise<void>
): Promise<void> {
  if (!fs.existsSync(filePath)) return
  const refusal = recycleRefusal(filePath, types)
  if (refusal) throw new Error(`not sent to the Recycle Bin: ${refusal}`)
  await sendToBin(filePath)
}

let cached: { at: number; types: Promise<Map<string, string> | null> } | null = null

/**
 * Drive type per letter, or null if PowerShell could not answer. One query
 * covers every letter (~270ms measured) and is kept for 10s, so a whole Empty
 * Trash shares it instead of spawning once per file. The timeout bounds a
 * letter that stalls; a null answer refuses every delete rather than guessing.
 */
export function driveTypes(): Promise<Map<string, string> | null> {
  if (cached && Date.now() - cached.at < 10_000) return cached.types
  const types = new Promise<Map<string, string> | null>((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', "[IO.DriveInfo]::GetDrives() | % { $_.Name + '|' + $_.DriveType }"],
      { windowsHide: true, timeout: 10_000 },
      (err, stdout) => resolve(err ? null : parseDriveTypes(stdout))
    )
  })
  cached = { at: Date.now(), types }
  return types
}
