/**
 * Which drive letters are independent storage, and which are aliases of another.
 *
 * Windows will hand out a drive letter for things that are not volumes. A SUBST
 * mapping is the common one: `subst T: C:\some\folder` makes T: enumerate in
 * Win32_LogicalDisk as DriveType 3 (Local Disk) with C:'s volume name, C:'s
 * volume serial and C:'s capacity and free space - because it IS C:. Reporting
 * it as a third drive tells the user they have storage they do not have, and
 * the capacity figures look like a bug in the free-space calculation.
 *
 * The honest discriminator is volume identity, not capacity and not the letter:
 *
 *   Win32_LogicalDisk  lists T:, because it is a letter you can open.
 *   Win32_Volume       does not, because it is not a volume.
 *
 * So a letter with no volume identity, whose filesystem serial matches exactly
 * one letter that does have one, is an alias of that letter and is resolved to
 * it rather than presented as separate storage.
 *
 * What this deliberately does NOT do:
 *   - match on capacity, free space, label or model. Two genuine partitions can
 *     be the same size, and a 1 TB external can be partitioned into two 500 GB
 *     halves that are both real.
 *   - special-case any letter. C:, D: and T: are treated identically.
 *   - hide a letter whose identity simply could not be read. getVolumeId does
 *     fail in the wild (WMI down, no PowerShell), and the app's rule everywhere
 *     else is to say it cannot verify rather than to hide or to guess. Such a
 *     letter stays visible and is marked unverified.
 *
 * A genuine separate partition has its own entry in Win32_Volume with its own
 * GUID and its own serial, so it is always independent here.
 *
 * Pure and dependency-free, so `node --test` can exercise it without WMI.
 */

export interface RawDriveLetter {
  /** 'C:' form. */
  letter: string
  /**
   * The volume GUID path or volume serial reported by Win32_Volume for this
   * letter, or null/'' when this letter is not a volume in its own right.
   */
  volumeId: string | null
  /**
   * Win32_LogicalDisk.VolumeSerialNumber - the serial of the filesystem the
   * letter resolves to. An alias reports the serial of the volume behind it,
   * which is what makes the alias resolvable to its backing letter.
   */
  fsSerial: string | null
}

export interface ResolvedDriveLetter {
  letter: string
  volumeId: string | null
  /**
   * The letter whose volume actually backs this one, when this letter is an
   * alias of it. null when this letter is storage in its own right.
   */
  aliasOf: string | null
  /** Shown as its own drive. False only for a resolved alias. */
  independent: boolean
  /**
   * True when no volume identity could be read for this letter AND no backing
   * volume was found for it. It is still shown - the app cannot tell whether it
   * is real - but nothing about it is treated as verified.
   */
  identityUnverified: boolean
}

function normalizeSerial(s: string | null | undefined): string | null {
  if (typeof s !== 'string') return null
  const t = s.trim().toUpperCase()
  // '0' and all-zero serials are what some drivers report for "no serial"; they
  // must never make two unrelated letters look like the same filesystem.
  if (!t || /^0+$/.test(t)) return null
  return t
}

export function resolveDriveLetters(raw: RawDriveLetter[]): ResolvedDriveLetter[] {
  const hasVolume = (d: RawDriveLetter): boolean =>
    typeof d.volumeId === 'string' && d.volumeId.trim().length > 0

  // Letters that are volumes in their own right, indexed by filesystem serial.
  // A serial claimed by more than one real volume is not usable as a backing
  // key - that would be a serial collision between two genuine volumes, and
  // resolving one into the other would hide real storage.
  const backingBySerial = new Map<string, string[]>()
  for (const d of raw) {
    if (!hasVolume(d)) continue
    const serial = normalizeSerial(d.fsSerial)
    if (!serial) continue
    const list = backingBySerial.get(serial)
    if (list) list.push(d.letter)
    else backingBySerial.set(serial, [d.letter])
  }

  return raw.map((d) => {
    if (hasVolume(d)) {
      return {
        letter: d.letter,
        volumeId: d.volumeId,
        aliasOf: null,
        independent: true,
        identityUnverified: false
      }
    }

    const serial = normalizeSerial(d.fsSerial)
    const candidates = serial ? backingBySerial.get(serial) : undefined
    // Exactly one backing volume, and never itself.
    const backing =
      candidates && candidates.length === 1 && candidates[0] !== d.letter ? candidates[0] : null

    if (backing) {
      return {
        letter: d.letter,
        volumeId: null,
        aliasOf: backing,
        independent: false,
        identityUnverified: false
      }
    }

    // No identity and nothing to resolve it to. Shown, but unverified.
    return {
      letter: d.letter,
      volumeId: null,
      aliasOf: null,
      independent: true,
      identityUnverified: true
    }
  })
}

/** The letters that should be presented as drives. */
export function independentLetters(resolved: ResolvedDriveLetter[]): string[] {
  return resolved.filter((r) => r.independent).map((r) => r.letter)
}
