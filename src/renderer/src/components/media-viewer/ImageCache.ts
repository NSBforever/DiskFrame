class ImageCache {
  private cache = new Map<string, HTMLImageElement>()
  private maxItems = 15

  public get(path: string): HTMLImageElement | undefined {
    if (this.cache.has(path)) {
      // Move to end (LRU behavior)
      const img = this.cache.get(path)!
      this.cache.delete(path)
      this.cache.set(path, img)
      return img
    }
    return undefined
  }

  public set(path: string, img: HTMLImageElement): void {
    if (this.cache.has(path)) {
      this.cache.delete(path)
    } else if (this.cache.size >= this.maxItems) {
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) {
        this.cache.delete(firstKey)
      }
    }
    this.cache.set(path, img)
  }

  public preload(path: string, src: string): Promise<HTMLImageElement> {
    const cached = this.get(path)
    if (cached) {
      return Promise.resolve(cached)
    }

    return new Promise((resolve, reject) => {
      const img = new Image()
      img.src = src
      img.onload = () => {
        this.set(path, img)
        resolve(img)
      }
      img.onerror = (e) => {
        reject(e)
      }
    })
  }

  public clear(): void {
    this.cache.clear()
  }
}

export const imageCache = new ImageCache()
