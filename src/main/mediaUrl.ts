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

export function mediaUrl(path: string): string {
  return PREFIX + path.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
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
