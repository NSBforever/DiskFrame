import React, { useEffect, useRef, useState } from 'react'
import { ImagePlus } from 'lucide-react'
import { internalDrag } from '../dragPreview'
import './DropOverlay.css'

/**
 * The drop target for files dragged in from Explorer.
 *
 * Window-level listeners, one overlay. It shows only while an external drag of
 * files is over the window - never for DiskFrame's own drags (internalDrag),
 * text or links - and it can never stick: every dragover re-arms a short
 * timer, so leaving, Esc and a drop elsewhere all clear it even when Windows
 * sends no dragleave. The overlay takes no pointer input, so the drop lands on
 * the window and is handled here.
 */
export default function DropOverlay({ onDropPaths }: { onDropPaths: (paths: string[]) => void }): React.JSX.Element {
  const [shown, setShown] = useState(false)
  const onDropRef = useRef(onDropPaths)
  onDropRef.current = onDropPaths

  useEffect(() => {
    let hideTimer = 0
    const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
    const hide = (): void => {
      window.clearTimeout(hideTimer)
      setShown(false)
    }
    const over = (e: DragEvent): void => {
      if (!hasFiles(e) || internalDrag.active) return
      e.preventDefault() // without this Chromium refuses the drop
      e.dataTransfer!.dropEffect = 'copy'
      setShown(true)
      window.clearTimeout(hideTimer)
      hideTimer = window.setTimeout(hide, 250)
    }
    const leave = (e: DragEvent): void => {
      if (!e.relatedTarget) hide() // left the window, not just moved between elements
    }
    const drop = (e: DragEvent): void => {
      hide()
      if (!hasFiles(e)) return
      e.preventDefault() // never let a dropped file navigate the window
      if (internalDrag.active) {
        internalDrag.active = false // our own drag, dropped back on the app: nothing to add
        return
      }
      const paths = Array.from(e.dataTransfer!.files)
        .map((f) => window.api.pathForFile(f))
        .filter(Boolean)
      if (paths.length) onDropRef.current(paths)
    }
    // Mouse events resume only once an OS drag is over: our drag has ended.
    const settle = (e: MouseEvent): void => {
      if (e.buttons === 0) internalDrag.active = false
    }
    window.addEventListener('dragenter', over)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    window.addEventListener('mousemove', settle, true)
    return () => {
      window.clearTimeout(hideTimer)
      window.removeEventListener('dragenter', over)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
      window.removeEventListener('mousemove', settle, true)
    }
  }, [])

  return (
    <div className={'drop-overlay' + (shown ? ' is-on' : '')} aria-hidden={!shown}>
      <div className="drop-card" role="status" aria-live="polite">
        <span className="drop-icon">
          <ImagePlus size={24} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="drop-title">Drop files to add to DiskFrame</div>
        <div className="drop-sub">Photos, videos and supported files</div>
      </div>
    </div>
  )
}
