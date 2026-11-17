/**
 * Which kinds of file a volume's index was built to include.
 *
 * An index only ever grows by the folders an incremental sync re-lists, and
 * that sync skips folders whose contents have not changed. So when DiskFrame
 * starts indexing a new kind of file (1.2.0: MPG, VOB, MTS and the other
 * video containers), files of that kind in untouched folders would never be
 * found. Each volume records the format its index was last fully walked at;
 * one below the current format gets one full walk the next time it is opened.
 *
 * Pure: the main process keeps the record in userData/index-format.json.
 */

/** 1: up to 1.1.x. 2: 1.2.0, every video container in validation.videoExts. */
export const INDEX_FORMAT = 2

export type IndexFormats = Record<string, number>

export function parseIndexFormats(raw: string | null | undefined): IndexFormats {
  try {
    const v = JSON.parse(raw ?? '{}') as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: IndexFormats = {}
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      if (typeof n === 'number' && Number.isFinite(n)) out[k] = n
    }
    return out
  } catch {
    return {}
  }
}

/** A volume never recorded was indexed by a version before this record existed: format 1. */
export function needsFullWalk(formats: IndexFormats, volumeId: string): boolean {
  return (formats[volumeId] ?? 1) < INDEX_FORMAT
}

export function withFormat(formats: IndexFormats, volumeId: string): IndexFormats {
  return { ...formats, [volumeId]: INDEX_FORMAT }
}
