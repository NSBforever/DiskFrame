/**
 * The size a thumbnail is made at.
 *
 * Thumbnails keep the picture's own shape: the short side is `size` and the
 * long side follows the aspect ratio. They used to be a square centre crop,
 * which is all a grid tile needs - but the viewer opens a photo by growing its
 * thumbnail from the tile into the whole picture, and a square crop has
 * nothing outside the square to show. A tile still crops to a square itself
 * (object-fit: cover), so the grid looks exactly as it did.
 *
 * The long side is capped at three times the short one. A panorama beyond that
 * is centre-cropped to 3:1, so one very wide file cannot make a thumbnail many
 * times the size of the rest.
 */
export const THUMB_MAX_ASPECT = 3

export function thumbShape(width: number, height: number, size: number): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: size, height: size }
  const aspect = width / height
  if (aspect >= 1) return { width: Math.round(size * Math.min(aspect, THUMB_MAX_ASPECT)), height: size }
  return { width: size, height: Math.round(size * Math.min(1 / aspect, THUMB_MAX_ASPECT)) }
}
