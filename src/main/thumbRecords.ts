/**
 * The catalogue writes that record a thumbnail's outcome, scoped to the volume
 * mounted at the path's letter, as file identity is everywhere else. Two cards
 * that both hold E:\DCIM\100APPLE\IMG_0001.JPG are different files, and a bare
 * `WHERE path = ?` wrote one card's thumbnail into the other's row.
 *
 * A row from before volume identity (NULL) still matches; an unverified letter
 * (volumeId null) is not scoped, as the thumbnail key itself is not then.
 *
 * Plain SQL so `npm test` can run it against SQLite without Electron.
 */
const THIS_VOLUME = '(? IS NULL OR volume_id IS ? OR volume_id IS NULL)'

/** Params: thumbPath, path, volumeId, volumeId. Success clears the failure history. */
export const UPDATE_THUMB_SQL = `UPDATE files SET thumb = ?, thumb_fail_count = 0, thumb_fail_sig = NULL
  WHERE path = ? AND ${THIS_VOLUME}`

/**
 * Params: signature, signature, path, volumeId, volumeId. Counts attempts
 * against the file as it was, so a changed file starts the count again.
 */
export const RECORD_THUMB_FAILURE_SQL = `UPDATE files SET
    thumb_fail_count = CASE WHEN thumb_fail_sig IS ? THEN IFNULL(thumb_fail_count, 0) + 1 ELSE 1 END,
    thumb_fail_sig = ?
  WHERE path = ? AND ${THIS_VOLUME}`
