/**
 * Turning a stored path into the path a file lives at today.
 *
 * The index records absolute paths. When a folder is moved on the drive, every
 * row under it stops resolving even though the volume is the same disk and the
 * files are still there. Rather than re-scanning or matching files by name and
 * size - which can pair up two different photos that happen to agree on both -
 * the user points the app at the folder's new location once, and every row
 * under it is rewritten through that one explicit mapping.
 *
 * Pure functions only: no filesystem, no database. The caller supplies an
 * existence test so this can be tested and so a single scan of the disk can
 * answer for many rows.
 */

export interface FolderMapping {
  /** Stored prefix, e.g. "E:\\College Memories". */
  from: string
  /** Where it lives now, e.g. "E:\\Archive 2024\\College Memories". */
  to: string
}

const SEP = '\\'

/** Trailing separators removed, so "E:\\x\\" and "E:\\x" are one prefix. */
export function normalisePrefix(p: string): string {
  let out = String(p ?? '').replace(/\//g, SEP)
  while (out.length > 3 && out.endsWith(SEP)) out = out.slice(0, -1)
  return out
}

/** Case-insensitive on Windows, and only at a path boundary. */
function isUnder(path: string, prefix: string): boolean {
  if (prefix.length === 0) return false
  const p = path.toLowerCase()
  const q = prefix.toLowerCase()
  if (p === q) return true
  return p.startsWith(q) && (q.endsWith(SEP) || p[q.length] === SEP)
}

/**
 * The stored path rewritten through the most specific mapping that covers it.
 *
 * Longest prefix wins, so a mapping for a subfolder overrides one for its
 * parent. A path with no mapping is returned unchanged.
 */
export function applyMappings(storedPath: string, mappings: FolderMapping[]): string {
  const path = String(storedPath ?? '')
  let best: FolderMapping | null = null
  for (const m of mappings) {
    const from = normalisePrefix(m.from)
    if (!isUnder(path, from)) continue
    if (!best || from.length > normalisePrefix(best.from).length) best = m
  }
  if (!best) return path
  const from = normalisePrefix(best.from)
  const to = normalisePrefix(best.to)
  return to + path.slice(from.length)
}

/**
 * Splits a path into the deepest ancestor that exists and the first component
 * below it that does not.
 *
 * That boundary is what the user is actually asked about: not "this file is
 * gone" but "this folder is not where it was, where is it now?". Returns null
 * when the whole path resolves.
 */
export function missingRootOf(
  path: string,
  exists: (p: string) => boolean
): { presentAncestor: string; missingRoot: string } | null {
  const p = String(path ?? '')
  if (p.length < 3) return null
  if (exists(p)) return null

  const driveRoot = p.slice(0, 3) // "E:\"
  const rest = p.slice(3)
  if (!rest) return null
  const parts = rest.split(SEP).filter((s) => s.length > 0)

  // The last component is the file itself; a missing *file* under a present
  // folder is a different problem and is not a relink candidate.
  let cur = driveRoot.slice(0, 2)
  let presentAncestor = driveRoot
  if (!exists(driveRoot)) return null

  for (let i = 0; i < parts.length; i++) {
    cur = cur + SEP + parts[i]
    if (exists(cur)) {
      presentAncestor = cur
      continue
    }
    // The first component that is absent. If it is the final one, the folder
    // chain is intact and only the file is gone.
    if (i === parts.length - 1) return null
    return { presentAncestor, missingRoot: cur }
  }
  return null
}

/**
 * Whether a proposed mapping is corroborated by the files the index expects
 * under it.
 *
 * The mapping itself is always the user's explicit choice; this only reports
 * how much of it checks out, so a mistaken pick can be refused rather than
 * silently rewriting thousands of rows. Sizes are compared as corroboration of
 * a folder the user already identified - never as the means of finding it.
 */
export function scoreMapping(
  samples: { storedPath: string; size: number }[],
  mapping: FolderMapping,
  probe: (p: string) => { size: number } | null
): { checked: number; found: number; sizeMatches: number; ratio: number } {
  let found = 0
  let sizeMatches = 0
  for (const s of samples) {
    const candidate = applyMappings(s.storedPath, [mapping])
    const st = probe(candidate)
    if (!st) continue
    found++
    if (typeof s.size === 'number' && st.size === s.size) sizeMatches++
  }
  const checked = samples.length
  return { checked, found, sizeMatches, ratio: checked ? found / checked : 0 }
}
