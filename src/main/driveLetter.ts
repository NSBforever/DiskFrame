/**
 * Brings a volume's records onto the letter it is mounted at now.
 *
 * Keyed on the letter in each row's PATH, never the `drive` column. The two
 * have been seen disagreeing: on the owner's catalogue 61,448 rows of a
 * 102,481-file volume said `drive = 'G:'` while their paths still began
 * `D:\` from when the drive had that letter. Keyed on `drive`, the repair saw
 * nothing to move, and every one of those files read as OFFLINE, never got a
 * thumbnail, and never had its capture date or GPS read.
 *
 * Three bulk statements rather than one UPDATE per row: a large volume is
 * moved in one pass at drive open. `OR IGNORE` keeps the old per-row failure
 * semantics - a row whose new path is already taken in this volume (the
 * (volume_id, path) identity index) stays where it was instead of failing the
 * rest. Favourites follow only files that actually moved. The folder snapshot
 * follows too: same folders, same mtimes, so it stays valid under the new
 * letter; anything that could not follow is dropped and costs one re-listing.
 *
 * Pure SQL over the passed connection so `npm test` can run it on SQLite.
 */
export interface LetterDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): { changes: number | bigint } }
}

export function moveVolumeToLetter(
  db: LetterDb,
  volumeId: string,
  newLetter: string
): { oldLetters: string[]; moved: number; left: number } {
  const L = newLetter.slice(0, 2).toUpperCase()
  // One pass over the volume: which letters its paths use, and on the current
  // letter, how many rows carry some other `drive` value.
  const byLetter = db
    .prepare(
      `SELECT upper(substr(path, 1, 2)) AS l, COUNT(*) AS n, SUM(drive IS NOT ?) AS wrongDrive
       FROM files WHERE volume_id = ? GROUP BY l`
    )
    .all(L, volumeId) as { l: string; n: number; wrongDrive: number }[]

  const old = byLetter.filter((r) => r.l !== L && /^[A-Z]:$/.test(r.l))
  let moved = 0
  for (const { l } of old) {
    moved += Number(
      db
        .prepare(
          `UPDATE OR IGNORE files SET path = ? || substr(path, 3), drive = ?
           WHERE volume_id = ? AND upper(substr(path, 1, 2)) = ?`
        )
        .run(L, L, volumeId, l).changes
    )
    db.prepare(
      `UPDATE OR IGNORE favourite_paths SET path = ? || substr(path, 3)
       WHERE volume_id = ? AND upper(substr(path, 1, 2)) = ?
         AND EXISTS (SELECT 1 FROM files f WHERE f.volume_id = favourite_paths.volume_id AND f.path = ? || substr(favourite_paths.path, 3))
         AND NOT EXISTS (SELECT 1 FROM files f WHERE f.volume_id = favourite_paths.volume_id AND f.path = favourite_paths.path)`
    ).run(L, volumeId, l, L)
    db.prepare(
      `UPDATE OR IGNORE folder_snapshot SET path = ? || substr(path, 3) WHERE volume_id = ? AND upper(substr(path, 1, 2)) = ?`
    ).run(L, volumeId, l)
    db.prepare(`DELETE FROM folder_snapshot WHERE volume_id = ? AND upper(substr(path, 1, 2)) = ?`).run(volumeId, l)
  }

  if ((byLetter.find((r) => r.l === L)?.wrongDrive ?? 0) > 0) {
    db.prepare(
      `UPDATE files SET drive = ? WHERE volume_id = ? AND drive IS NOT ? AND upper(substr(path, 1, 2)) = ?`
    ).run(L, volumeId, L, L)
  }

  const total = old.reduce((s, r) => s + r.n, 0)
  return { oldLetters: old.map((r) => r.l), moved, left: total - moved }
}
