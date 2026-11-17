/**
 * Files and folders dropped on the window from Explorer, added to the library.
 *
 * Not a second importer: each path goes through what already indexes media -
 * a folder through the bounded folder walk ("Index Folder"), a file through
 * the single-file path the watcher uses - so the same rules apply (supported
 * types, .ts/.mts sniffing, generated assets, tiny icons). What this adds is
 * the accounting the user is shown, and the guarantees a drop needs: the same
 * path twice in one drop counts once, a file already in the library is left
 * alone, and a long drop yields so the app stays responsive.
 */

export interface DropImportResult {
  /** New files now in the library. */
  added: number
  /** Already in the library (left untouched). */
  already: number
  /** Not a kind of file DiskFrame shows (or an icon-sized image). */
  unsupported: number
  /** Gone or unreadable by the time it was looked at. */
  missing: number
  /** Folders walked. */
  folders: number
  /** A folder walk stopped at its cap: run Index Folder on it to continue. */
  capped: boolean
  /** Drive letters that gained files, for refreshing their galleries. */
  drives: string[]
  /** Another drop was still being added; this one was not started. */
  busy?: boolean
}

export interface DropImportDeps {
  stat(path: string): Promise<{ isDirectory: boolean } | null>
  /** Whether the path is media DiskFrame indexes (reads .ts/.mts heads). */
  isMedia(path: string): boolean
  isIndexed(path: string): Promise<boolean>
  /** Index one file; false if it was turned away (e.g. an icon-sized image). */
  indexFile(path: string): Promise<boolean>
  indexFolder(path: string): Promise<{ added: number; seen: number; capped: boolean }>
  /** Let other work run (called every few files). */
  yieldNow(): Promise<void>
}

/** Most paths one drop may carry; Explorer can hand over far more. */
export const MAX_DROP_PATHS = 20000

export async function importDropped(paths: string[], deps: DropImportDeps): Promise<DropImportResult> {
  const r: DropImportResult = { added: 0, already: 0, unsupported: 0, missing: 0, folders: 0, capped: false, drives: [] }
  const drives = new Set<string>()
  const seen = new Set<string>()
  let n = 0
  for (const p of paths.slice(0, MAX_DROP_PATHS)) {
    const key = p.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (++n % 25 === 0) await deps.yieldNow()
    const st = await deps.stat(p)
    if (!st) {
      r.missing++
      continue
    }
    const drive = p.slice(0, 2).toUpperCase()
    if (st.isDirectory) {
      const f = await deps.indexFolder(p)
      r.folders++
      r.added += f.added
      r.already += Math.max(0, f.seen - f.added)
      r.capped ||= f.capped
      if (f.added) drives.add(drive)
      continue
    }
    if (!deps.isMedia(p)) {
      r.unsupported++
      continue
    }
    if (await deps.isIndexed(p)) {
      r.already++
      continue
    }
    if (await deps.indexFile(p)) {
      r.added++
      drives.add(drive)
    } else r.unsupported++
  }
  r.drives = [...drives]
  return r
}

/** One line for the toast, e.g. "Added 12 files · 3 already in DiskFrame · 2 not supported". */
export function dropSummary(r: DropImportResult): string {
  if (r.busy) return 'Still adding the previous drop - try again in a moment'
  const n = (k: number, one: string, many = one + 's'): string => `${k.toLocaleString()} ${k === 1 ? one : many}`
  const parts: string[] = []
  parts.push(r.added ? `Added ${n(r.added, 'file')}` : 'Nothing new to add')
  if (r.already) parts.push(`${r.already.toLocaleString()} already in DiskFrame`)
  if (r.unsupported) parts.push(`${r.unsupported.toLocaleString()} not supported`)
  if (r.missing) parts.push(`${r.missing.toLocaleString()} could not be read`)
  if (r.capped) parts.push('a folder was too large: use Index Folder to continue')
  return parts.join(' · ')
}
