/**
 * DiskFrame's published versions and their notes, from GitHub's public
 * releases list (the same repository the updater reads; anonymous, nothing
 * about the user's files is sent). Pure parsing, so `npm test` covers it;
 * the main process fetches and caches.
 */

export interface NoteSection {
  title: string
  items: string[]
}
export interface PublishedRelease {
  version: string
  name: string
  /** ISO time GitHub published it. */
  date: string
  url: string
  sections: NoteSection[]
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/

export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a)
  const pb = SEMVER.exec(b)
  if (!pa || !pb) return NaN
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i])
    if (d !== 0) return d
  }
  return 0
}

/** Our release-notes markdown as titled sections of plain-text items. */
export function noteSections(body: string): NoteSection[] {
  const out: NoteSection[] = []
  let cur: NoteSection | null = null
  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    const h = /^#{3,}\s+(.*)$/.exec(line)
    if (h) {
      cur = { title: h[1].trim(), items: [] }
      out.push(cur)
      continue
    }
    const item = /^[-*]\s+(.*)$/.exec(line)
    if (!item) continue
    if (!cur) {
      cur = { title: '', items: [] }
      out.push(cur)
    }
    cur.items.push(item[1].replace(/\*\*|__/g, '').replace(/`/g, '').trim())
  }
  return out.filter((s) => s.items.length > 0)
}

/** GitHub's /releases response as published, versioned releases, newest version first. Anything else: []. */
export function parseReleases(json: unknown): PublishedRelease[] {
  if (!Array.isArray(json)) return []
  const out: PublishedRelease[] = []
  for (const r of json) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    if (o.draft || o.prerelease || typeof o.tag_name !== 'string' || typeof o.published_at !== 'string') continue
    const m = SEMVER.exec(o.tag_name)
    if (!m) continue
    const version = `${m[1]}.${m[2]}.${m[3]}`
    out.push({
      version,
      name: typeof o.name === 'string' && o.name ? o.name : `DiskFrame ${version}`,
      date: validDate(o.published_at),
      url: typeof o.html_url === 'string' ? o.html_url : '',
      sections: typeof o.body === 'string' ? noteSections(o.body) : []
    })
  }
  return out.sort((a, b) => compareVersions(b.version, a.version))
}

function validDate(v: unknown): string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : ''
}

const isStr = (v: unknown): v is string => typeof v === 'string'

/** The saved release list (userData/release-history.json) as written by DiskFrame; anything else is dropped. */
export function cachedReleases(json: unknown): PublishedRelease[] {
  if (!Array.isArray(json)) return []
  const out: PublishedRelease[] = []
  for (const r of json) {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
    if (!isStr(o.version) || !SEMVER.test(o.version) || !isStr(o.name) || !isStr(o.url) || !Array.isArray(o.sections)) continue
    const sections = o.sections as unknown[]
    const ok = sections.every((x) => {
      const sec = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
      return isStr(sec.title) && Array.isArray(sec.items) && sec.items.every(isStr)
    })
    if (ok) out.push({ version: o.version, name: o.name, date: validDate(o.date), url: o.url, sections: sections as NoteSection[] })
  }
  return out
}

/** After an update only: not on a first install (nothing changed for this user), not after a downgrade. */
export function shouldShowWhatsNew(lastSeen: string | null, current: string): boolean {
  if (!lastSeen) return false
  return compareVersions(current, lastSeen) > 0
}
