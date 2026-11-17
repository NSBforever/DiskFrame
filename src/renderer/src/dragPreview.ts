import { videoExts } from '../../main/validation'

/**
 * Starting an OS drag of files from the gallery, with DiskFrame's own preview.
 *
 * The drag is a real Windows drag (Electron's startDrag), so Explorer, the
 * desktop and other apps accept the files. Windows draws the image it is
 * given; until now that was a fixed red "play" icon for every file. This draws
 * one from the tile itself: its thumbnail on a rounded card, a stack and a
 * count when several files go, a small play mark for video. What Windows adds
 * on top - the "Copy to Desktop" label over a target - belongs to Windows and
 * the target, not to DiskFrame.
 */

/** Set while one of our own drags is in the air, so the drop overlay ignores it. */
export const internalDrag = { active: false }

const CARD = 96 // px, the front card's edge
const PAD = 14 // room for the stack and the shadow

/** Lucide paths, so the no-thumbnail card matches the rest of the app. */
const ICON_IMAGE = 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M21 15l-3.086-3.086a2 2 0 0 0-2.828 0L6 21 M9 9m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0'
const ICON_FILM = 'M4 2h16a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z M7 3v18 M3 7.5h4 M3 12h18 M3 16.5h4 M17 3v18 M17 7.5h4 M17 16.5h4'
const ICON_FILE = 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z M14 2v4a2 2 0 0 0 2 2h4'

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

/** The preview as a PNG data URL, or null if it cannot be drawn (the main process then uses a plain icon). */
export function drawDragPreview(source: Element | null, paths: string[]): { dataUrl: string; scale: number } | null {
  try {
    const scale = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
    const count = paths.length
    const size = CARD + PAD * 2
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(size * scale)
    canvas.height = Math.round(size * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.scale(scale, scale)
    const x = PAD - 4
    const y = PAD - 4

    // Cards behind the front one: a quiet stack for "more than one".
    for (let i = Math.min(2, count - 1); i >= 1; i--) {
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,0.35)'
      ctx.shadowBlur = 6
      roundRect(ctx, x + i * 5, y + i * 5, CARD, CARD, 10)
      ctx.fillStyle = i === 1 ? '#26262b' : '#1d1d21'
      ctx.fill()
      ctx.restore()
      roundRect(ctx, x + i * 5 + 0.5, y + i * 5 + 0.5, CARD - 1, CARD - 1, 10)
      ctx.strokeStyle = 'rgba(255,255,255,0.10)'
      ctx.stroke()
    }

    // Front card: the tile's own thumbnail when it has one.
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.5)'
    ctx.shadowBlur = 12
    ctx.shadowOffsetY = 3
    roundRect(ctx, x, y, CARD, CARD, 10)
    ctx.fillStyle = '#18181c'
    ctx.fill()
    ctx.restore()
    const img = source?.querySelector('img') as HTMLImageElement | null
    const ext = (paths[0].match(/\.[^.\\/]+$/)?.[0] ?? '').toLowerCase()
    const isVideo = videoExts.includes(ext)
    ctx.save()
    roundRect(ctx, x, y, CARD, CARD, 10)
    ctx.clip()
    if (img && img.complete && img.naturalWidth > 0) {
      const s = Math.max(CARD / img.naturalWidth, CARD / img.naturalHeight) // cover
      const w = img.naturalWidth * s
      const h = img.naturalHeight * s
      ctx.drawImage(img, x + (CARD - w) / 2, y + (CARD - h) / 2, w, h)
    } else {
      ctx.translate(x + CARD / 2 - 16, y + CARD / 2 - 16)
      ctx.scale(32 / 24, 32 / 24)
      ctx.strokeStyle = '#8a8a8f'
      ctx.lineWidth = 1.6
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.stroke(new Path2D(isVideo ? ICON_FILM : /\.(jpe?g|png|webp|heic|heif|gif|bmp|raw|cr2|nef)$/.test(ext) ? ICON_IMAGE : ICON_FILE))
    }
    ctx.restore()
    roundRect(ctx, x + 0.5, y + 0.5, CARD - 1, CARD - 1, 10)
    ctx.strokeStyle = 'rgba(255,255,255,0.16)'
    ctx.lineWidth = 1
    ctx.stroke()

    // Video: a small play mark, bottom left - not the old full-size red icon.
    if (isVideo && img && img.naturalWidth > 0) {
      ctx.beginPath()
      ctx.arc(x + 17, y + CARD - 17, 10, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(10,10,12,0.72)'
      ctx.fill()
      ctx.beginPath()
      ctx.moveTo(x + 14, y + CARD - 22)
      ctx.lineTo(x + 22, y + CARD - 17)
      ctx.lineTo(x + 14, y + CARD - 12)
      ctx.closePath()
      ctx.fillStyle = '#f2f2f0'
      ctx.fill()
    }

    // Count, top right, when several files go.
    if (count > 1) {
      const label = count > 999 ? '999+' : String(count)
      ctx.font = '600 12px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif'
      const w = Math.max(22, ctx.measureText(label).width + 14)
      const bx = x + CARD - w + 6
      const by = y - 6
      roundRect(ctx, bx, by, w, 22, 11)
      ctx.fillStyle = '#e11d2e'
      ctx.fill()
      ctx.strokeStyle = 'rgba(10,10,12,0.9)'
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.fillStyle = '#ffffff'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, bx + w / 2, by + 11.5)
    }
    return { dataUrl: canvas.toDataURL('image/png'), scale }
  } catch {
    return null
  }
}

/** Start the OS drag of these files from this tile. */
export function startFileDrag(paths: string[], source: Element | null): void {
  if (paths.length === 0) return
  internalDrag.active = true
  window.api.startNativeDrag(paths, drawDragPreview(source, paths) ?? undefined)
}
