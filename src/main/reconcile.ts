/**
 * Brings a volume's catalogue in line with what is on disk, by folder.
 *
 * Pure: it takes the known rows, a record of each tracked folder from the last
 * run, and a filesystem adapter, and reports what changed. It never touches the
 * database - the main process applies the result after re-checking that the
 * volume is still the one this ran against. Runs in a worker thread
 * (reconcileWorker.ts), so none of its I/O is on the main event loop.
 *
 * Which folders: the ones holding indexed files, and their ancestors up to the
 * catalogue root - on the owner's C: about 770, against ~50,000 folders under
 * the home directory in all. Walking every folder was tried first and measured:
 * 149 seconds and 200,000 entries for the first run, 9-12 seconds per run after
 * it, and it would have added ~2,500 build-output images the scan had never
 * indexed. Tracked folders only is one stat each per run.
 *
 * Why a stat is enough: on NTFS a directory's mtime moves whenever an entry
 * inside it is created, deleted or renamed. A folder whose mtime matches the
 * last run has the same entries it had then and is skipped - no listing,
 * nothing read. Each record also keeps the folder's subfolder names, so a
 * changed listing reveals exactly which subfolders are new; only those are
 * walked. (Edits to a file's content do not move its folder's mtime; the live
 * watcher covers those, and an explicit "Check for changes" runs with `full`,
 * which lists every tracked folder, stats every file and walks every untracked
 * subfolder.)
 *
 * What counts as evidence, because a wrong removal is the one unrecoverable
 * outcome here:
 *   - A file is gone only when its folder was LISTED successfully, on a volume
 *     whose root is still present, and the listing does not contain it.
 *   - A folder is gone only when its nearest existing ancestor was listed
 *     successfully and does not contain it.
 *   - A permission error, any other error, or a missing volume root proves
 *     nothing: the folder is left exactly as it was.
 *   - Removals are reported only in the final event of a run that finished. A
 *     run that is cancelled, times out or loses its root reports none.
 * A file that turns up at a new path with the same NTFS file id and size as a
 * known file whose old path no longer exists is a move or rename, reported as
 * such so its record (favourite, thumbnail, date) follows it.
 */

export interface KnownFile {
  path: string
  size: number
  mtime: number | null
  ino: number | null
}

export interface FoundFile {
  path: string
  name: string
  ext: string
  size: number
  mtime: number
  ino: number | null
}

/** A tracked folder as last listed: its mtime, and its subfolder names. */
export interface FolderRecord {
  mtime: number
  /** Lower-cased subfolder names. null when never recorded. */
  children: string[] | null
}

/** [path, mtime, lower-cased subfolder names] - what is persisted per folder. */
export type FolderRow = [string, number, string[]]

export interface ReconcileInput {
  /** Catalogue scope for this volume ("C:\Users\me" for C:, "E:\" otherwise). */
  root: string
  files: KnownFile[]
  /** Rows that exist but are not this run's to judge - trashed or moved to the
   *  vault. Never reported as added, never reported as removed. */
  ignorePaths: string[]
  folders: Record<string, FolderRecord>
  /** List and stat everything, and walk every untracked subfolder. */
  full: boolean
  exts: string[]
  photoExts: string[]
  minPhotoSize: number
  /** Directory names never descended into (same list the scan uses). */
  skipDirs: string[]
  /** Ceiling on entries visited while walking folders that are new to us. */
  maxNewEntries: number
  /** Path predicate shared with the scan (generated assets etc.). */
  isExcluded?: (path: string) => boolean
}

export type StatResult =
  | { ok: true; isDir: boolean; isFile: boolean; mtimeMs: number; size: number; ino: number | null }
  | { ok: false; code: string }
export type ListResult =
  | { ok: true; entries: { name: string; isFile: boolean; isDir: boolean }[] }
  | { ok: false; code: string }

export interface FsAdapter {
  stat(path: string): StatResult
  list(path: string): ListResult
  /** Called between folders; the worker uses it to throttle its own I/O. */
  pace?(): void
}

export interface ReconcileBatch {
  type: 'batch'
  added: FoundFile[]
  moved: { from: string; to: FoundFile }[]
  changed: FoundFile[]
  /** Folder records safe to keep now: nothing in them is waiting to be removed. */
  folders: FolderRow[]
}

export interface ReconcileDone {
  type: 'done'
  removed: string[]
  /** Recorded together with the removals above, never before them - or a run
   *  cancelled in between would leave a folder marked unchanged with its
   *  removal never applied. */
  folders: FolderRow[]
  /** Folders confirmed gone; their records (and those beneath them) are dropped. */
  goneFolders: string[]
  stats: { foldersChecked: number; foldersListed: number; foldersSkippedUnchanged: number; unreadable: number; newEntriesVisited: number }
}

export interface ReconcileAborted {
  type: 'aborted'
  reason: string
}

export type ReconcileEvent = ReconcileBatch | ReconcileDone | ReconcileAborted

/** The real filesystem, synchronously - this runs in a worker thread. Error
 *  codes are passed through untouched because they are the evidence: ENOENT
 *  means absent, anything else means "could not tell". */
export function nodeFs(fs: typeof import('fs')): FsAdapter {
  const code = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? 'EUNKNOWN'
  return {
    stat(p) {
      try {
        const s = fs.statSync(p)
        return { ok: true, isDir: s.isDirectory(), isFile: s.isFile(), mtimeMs: s.mtimeMs, size: s.size, ino: s.ino ? Number(s.ino) : null }
      } catch (e) {
        return { ok: false, code: code(e) }
      }
    },
    list(p) {
      try {
        const entries = fs.readdirSync(p, { withFileTypes: true }).map((d) => ({ name: d.name, isFile: d.isFile(), isDir: d.isDirectory() }))
        return { ok: true, entries }
      } catch (e) {
        return { ok: false, code: code(e) }
      }
    }
  }
}

const SEP = '\\'
const lc = (s: string): string => s.toLowerCase()
function dirOf(p: string): string {
  const i = p.lastIndexOf(SEP)
  if (i <= 2) return p.slice(0, 3) // "C:\"
  return p.slice(0, i)
}
function baseOf(p: string): string {
  return p.slice(p.lastIndexOf(SEP) + 1)
}
function join(dir: string, name: string): string {
  return dir.endsWith(SEP) ? dir + name : dir + SEP + name
}
function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : lc(name.slice(i))
}
function isUnder(path: string, root: string): boolean {
  const p = lc(path)
  const r = lc(root.endsWith(SEP) ? root : root + SEP)
  return p === lc(root) || p.startsWith(r)
}

export function runReconcile(input: ReconcileInput, fsx: FsAdapter, emit: (e: ReconcileEvent) => void): void {
  const root = input.root
  const driveRoot = root.slice(0, 3)
  const rootPresent = (): boolean => {
    const s = fsx.stat(driveRoot)
    return s.ok && s.isDir
  }
  if (!rootPresent()) {
    emit({ type: 'aborted', reason: `volume root ${driveRoot} is not present` })
    return
  }

  const exts = new Set(input.exts.map(lc))
  const photoExts = new Set(input.photoExts.map(lc))
  const skip = new Set(input.skipDirs.map(lc))
  const walkable = (name: string): boolean => !name.startsWith('.') && !skip.has(lc(name))
  const records = new Map<string, FolderRecord>()
  for (const [p, rec] of Object.entries(input.folders)) records.set(lc(p), rec)

  // Known files by folder, and by file id for move detection.
  const byDir = new Map<string, KnownFile[]>()
  const knownPaths = new Set<string>()
  const byIno = new Map<number, KnownFile>()
  for (const f of input.files) {
    const d = lc(dirOf(f.path))
    let list = byDir.get(d)
    if (!list) byDir.set(d, (list = []))
    list.push(f)
    knownPaths.add(lc(f.path))
    if (f.ino) byIno.set(f.ino, f)
  }
  for (const p of input.ignorePaths) knownPaths.add(lc(p))

  // Tracked folders: those holding known files, those recorded last time, and
  // their ancestors up to the catalogue root - so a new folder created next to
  // existing media is seen when its parent's listing changes. Folders outside
  // the root (indexed through "Index folder") are tracked themselves, but their
  // ancestors are not: that would be the rest of the drive.
  const realCase = new Map<string, string>()
  const track = (p: string): void => {
    const k = lc(p)
    if (!realCase.has(k)) realCase.set(k, p)
  }
  track(root)
  for (const f of input.files) track(dirOf(f.path))
  for (const p of Object.keys(input.folders)) track(p)
  for (const p of [...realCase.values()]) {
    if (!isUnder(p, root)) continue
    let cur = p
    while (lc(cur) !== lc(root) && cur.length > 3) {
      cur = dirOf(cur)
      if (!isUnder(cur, root)) break
      track(cur)
    }
  }
  const tracked = new Set(realCase.keys())
  /** Known folders whose parent is a given folder, for spotting a renamed one. */
  const childrenOf = new Map<string, string[]>()
  for (const k of tracked) {
    const parent = lc(dirOf(realCase.get(k)!))
    if (parent === k) continue
    let l = childrenOf.get(parent)
    if (!l) childrenOf.set(parent, (l = []))
    l.push(baseOf(k))
  }

  const added: FoundFile[] = []
  const moved: { from: string; to: FoundFile }[] = []
  const changed: FoundFile[] = []
  const safeFolders: FolderRow[] = []
  const pendingFolders: FolderRow[] = []
  const removed = new Set<string>()
  const movedFrom = new Set<string>()
  const missingFolders: string[] = []
  const stats = { foldersChecked: 0, foldersListed: 0, foldersSkippedUnchanged: 0, unreadable: 0, newEntriesVisited: 0 }

  const flush = (): void => {
    if (!added.length && !moved.length && !changed.length && !safeFolders.length) return
    emit({ type: 'batch', added: added.splice(0), moved: moved.splice(0), changed: changed.splice(0), folders: safeFolders.splice(0) })
  }

  const considerNewFile = (dir: string, name: string): void => {
    const ext = extOf(name)
    if (!exts.has(ext)) return
    const path = join(dir, name)
    if (knownPaths.has(lc(path))) return
    if (input.isExcluded?.(path)) return
    const st = fsx.stat(path)
    if (!st.ok || !st.isFile) return
    if (photoExts.has(ext) && st.size < input.minPhotoSize) return
    const found: FoundFile = { path, name, ext, size: st.size, mtime: Math.round(st.mtimeMs), ino: st.ino }
    // Same file id and size as a known file whose old path is gone: a move or
    // a rename, not a new file.
    const prior = st.ino ? byIno.get(st.ino) : undefined
    if (prior && prior.size === st.size && !movedFrom.has(lc(prior.path))) {
      const old = fsx.stat(prior.path)
      const oldGone = !old.ok && old.code === 'ENOENT'
      if (oldGone || lc(prior.path) === lc(path)) {
        movedFrom.add(lc(prior.path))
        removed.delete(lc(prior.path))
        moved.push({ from: prior.path, to: found })
        knownPaths.add(lc(path))
        return
      }
    }
    knownPaths.add(lc(path))
    added.push(found)
  }

  const subfolderNames = (entries: { name: string; isDir: boolean }[]): string[] =>
    entries.filter((e) => e.isDir && walkable(e.name)).map((e) => lc(e.name))

  /** Walks a folder that was not there before, bounded, recording what it holds. */
  let newBudget = input.maxNewEntries
  const walkNew = (dir: string): void => {
    if (newBudget <= 0 || tracked.has(lc(dir))) return
    tracked.add(lc(dir))
    const st = fsx.stat(dir)
    if (!st.ok || !st.isDir) return
    const ls = fsx.list(dir)
    if (!ls.ok) {
      stats.unreadable++
      return
    }
    newBudget -= ls.entries.length
    stats.newEntriesVisited += ls.entries.length
    for (const e of ls.entries) if (e.isFile) considerNewFile(dir, e.name)
    // Recorded only if the walk of this folder completed within budget, so a
    // walk cut short is picked up again next time rather than marked done.
    if (newBudget > 0) safeFolders.push([dir, Math.round(st.mtimeMs), subfolderNames(ls.entries)])
    for (const e of ls.entries) if (e.isDir && walkable(e.name)) walkNew(join(dir, e.name))
    fsx.pace?.()
    if (added.length + moved.length >= 200) flush()
  }

  // Shallowest first, so a missing parent is found before its children are
  // each reported missing on their own.
  const ordered = [...realCase.values()].sort((a, b) => a.length - b.length)
  for (const dir of ordered) {
    if (missingFolders.some((m) => isUnder(dir, m))) continue
    stats.foldersChecked++
    const st = fsx.stat(dir)
    if (!st.ok) {
      if (st.code === 'ENOENT') missingFolders.push(dir)
      else stats.unreadable++
      continue
    }
    if (!st.isDir) continue
    const mtime = Math.round(st.mtimeMs)
    const rec = records.get(lc(dir))
    if (!input.full && rec && rec.mtime === mtime && rec.children) {
      stats.foldersSkippedUnchanged++
      continue
    }
    const ls = fsx.list(dir)
    if (!ls.ok) {
      stats.unreadable++
      continue
    }
    stats.foldersListed++
    const names = new Map<string, { isFile: boolean; isDir: boolean }>()
    for (const e of ls.entries) names.set(lc(e.name), e)

    let removalsHere = 0
    for (const f of byDir.get(lc(dir)) ?? []) {
      const entry = names.get(lc(baseOf(f.path)))
      if (!entry || !entry.isFile) {
        if (!movedFrom.has(lc(f.path))) {
          removed.add(lc(f.path))
          removalsHere++
        }
        continue
      }
      // Present. Only a changed folder, or a full run, pays for a stat.
      const fst = fsx.stat(f.path)
      if (fst.ok && (fst.size !== f.size || (f.mtime !== null && Math.round(fst.mtimeMs) !== f.mtime))) {
        changed.push({ path: f.path, name: baseOf(f.path), ext: extOf(f.path), size: fst.size, mtime: Math.round(fst.mtimeMs), ino: fst.ino })
      }
    }
    for (const e of ls.entries) if (e.isFile) considerNewFile(dir, e.name)

    // Which untracked subfolders to walk:
    //   - recorded last time: only the names that were not there then;
    //   - never recorded: none, unless a tracked subfolder of this one has
    //     vanished - then a renamed folder is the likely story, and walking
    //     the untracked ones is how its files are followed;
    //   - a full run: all of them.
    const subs = subfolderNames(ls.entries)
    const lostChild = (childrenOf.get(lc(dir)) ?? []).some((c) => !names.has(c))
    const prev = rec?.children ? new Set(rec.children) : null
    for (const s of subs) {
      const child = join(dir, ls.entries.find((e) => lc(e.name) === s)!.name)
      if (tracked.has(lc(child))) continue
      if (input.full || (prev ? !prev.has(s) : lostChild)) walkNew(child)
    }
    ;(removalsHere > 0 ? pendingFolders : safeFolders).push([dir, mtime, subs])
    fsx.pace?.()
    if (safeFolders.length >= 200 || added.length + moved.length >= 200) flush()
  }

  // A folder that has vanished is only believed gone if the folder above it
  // was listed and does not hold it. Anything less - the root itself gone,
  // a permission error on the parent - proves nothing.
  const goneFolders: string[] = []
  for (const dir of missingFolders) {
    let parent = dirOf(dir)
    let child = baseOf(dir)
    let st = fsx.stat(parent)
    while (!st.ok && st.code === 'ENOENT' && parent.length > 3) {
      child = baseOf(parent)
      parent = dirOf(parent)
      st = fsx.stat(parent)
    }
    if (!st.ok) continue
    const ls = fsx.list(parent)
    if (!ls.ok) continue
    if (ls.entries.some((e) => lc(e.name) === lc(child))) continue
    goneFolders.push(dir)
    for (const f of input.files) {
      if (isUnder(f.path, dir) && !movedFrom.has(lc(f.path))) removed.add(lc(f.path))
    }
  }

  flush()
  // The volume has to still be there at the end for any of it to count.
  if (!rootPresent()) {
    emit({ type: 'aborted', reason: `volume root ${driveRoot} disappeared during the run` })
    return
  }
  const removedPaths = input.files.filter((f) => removed.has(lc(f.path)) && !movedFrom.has(lc(f.path))).map((f) => f.path)
  emit({ type: 'done', removed: removedPaths, folders: pendingFolders, goneFolders, stats })
}
