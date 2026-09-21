/**
 * Small LRU of decoded full-resolution images, used to make next/previous in
 * the viewer instant.
 *
 * Size matters more here than the entry count suggests: these are originals,
 * not thumbnails, and a 12-megapixel photo costs ~48MB as a decoded bitmap
 * regardless of how small its JPEG is on disk. The cache previously held 15 of
 * them and dropped evicted entries without releasing them, so Blink kept the
 * bitmaps alive in its own resource cache - hundreds of MB of renderer memory
 * that never came back during a browsing session.
 *
 * Three is enough for the only access pattern that benefits: previous, current,
 * next.
 */
const MAX_ITEMS = 3

class ImageCache {
  private cache = new Map<string, HTMLImageElement>()

  public get(path: string): HTMLImageElement | undefined {
    const img = this.cache.get(path)
    if (!img) return undefined
    // Re-insert to mark as most recently used.
    this.cache.delete(path)
    this.cache.set(path, img)
    return img
  }

  public set(path: string, img: HTMLImageElement): void {
    this.cache.delete(path)
    while (this.cache.size >= MAX_ITEMS) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey === undefined) break
      this.release(oldestKey)
    }
    this.cache.set(path, img)
  }

  /**
   * Blanking src is what actually frees the decoded bitmap. Dropping the Map
   * entry alone only removes our reference - Blink's resource cache is keyed on
   * "recently used", not "currently referenced", and holds on regardless.
   */
  private release(path: string): void {
    const img = this.cache.get(path)
    if (img) {
      img.onload = null
      img.onerror = null
      img.src = ''
    }
    this.cache.delete(path)
  }

  public preload(path: string, src: string): Promise<HTMLImageElement> {
    const cached = this.get(path)
    if (cached) return Promise.resolve(cached)

    return new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        this.set(path, img)
        resolve(img)
      }
      img.onerror = (e) => {
        img.src = ''
        reject(e)
      }
      img.src = src
    })
  }

  /** Called when the viewer closes - nothing on screen needs these any more. */
  public clear(): void {
    for (const path of [...this.cache.keys()]) this.release(path)
    this.cache.clear()
  }
}

export const imageCache = new ImageCache()
