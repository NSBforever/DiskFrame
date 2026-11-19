/**
 * `media:` URLs for local paths, built and read back the same way everywhere.
 *
 * `media` is registered as a standard scheme, so URLs carry a fixed host
 * (`media://local/C%3A/DCIM/IMG_1.jpg`). Chromium's media loader only plays
 * video from a standard scheme: from the old opaque `media:///C:/...` form,
 * <video> failed with PIPELINE_ERROR_READ even when every range request was
 * answered correctly.
 *
 * Every path segment is percent-encoded. They used to be pasted in raw, so a
 * file named `clip #2.mp4` reached the handler as `clip ` (the rest was a URL
 * fragment) and `100%.jpg` made decodeURIComponent throw - both showed as a
 * broken tile. Shared with the renderer (tsconfig.web.json includes it).
 */
const PREFIX = 'media://local/'

/**
 * `volumeId` names the volume of the catalogue row being shown, as `?v=`.
 * All Drives can show two volumes' files at one literal path (both drives
 * were E: at different times); with it the media protocol serves only that
 * volume's file and refuses when another volume holds the letter now.
 */
export function mediaUrl(path: string, volumeId?: string | null): string {
  const url = PREFIX + path.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
  return volumeId ? url + '?v=' + encodeURIComponent(volumeId) : url
}

/** Appends a query parameter whether or not the URL already has one. */
export function withQuery(url: string, param: string): string {
  return url + (url.includes('?') ? '&' : '?') + param
}

/** The volume a `media:` URL names, or null. */
export function mediaUrlVolume(url: string): string | null {
  const q = url.indexOf('?')
  if (q === -1) return null
  return new URLSearchParams(url.slice(q + 1).split('#')[0]).get('v') || null
}

/** The Windows path a `media:` URL names, or null when it is not one of ours
 *  or not decodable. A query string names no part of the file (the viewer's
 *  Retry adds one). */
export function mediaUrlPath(url: string): string | null {
  if (!url.startsWith(PREFIX)) return null
  const raw = url.slice(PREFIX.length).split('?')[0].split('#')[0]
  try {
    return decodeURIComponent(raw).replace(/\//g, '\\')
  } catch {
    return null
  }
}
