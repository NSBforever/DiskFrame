import { useEffect } from 'react'

export interface ShortcutProps {
  onNext: () => void
  onPrev: () => void
  onFirst: () => void
  onLast: () => void
  onZoomIn: () => void
  onZoomOut: () => void
  onZoomReset: () => void
  onToggleFullscreen: () => void
  isOpen: boolean
}

export function useShortcuts({
  onNext,
  onPrev,
  onFirst,
  onLast,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onToggleFullscreen,
  isOpen
}: ShortcutProps) {
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      // Anything the user is typing into, or a slider they are nudging, keeps
      // its own arrow behaviour. role="slider" covers the custom seek bar,
      // which is a div rather than an <input type="range">.
      const activeEl = document.activeElement as HTMLElement | null
      if (
        activeEl &&
        (activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.tagName === 'SELECT' ||
          activeEl.getAttribute('contenteditable') === 'true' ||
          activeEl.getAttribute('role') === 'slider')
      ) {
        return
      }

      switch (e.key) {
        // Left/Right always move between FILES, photo or video alike.
        // Space is play/pause on a video (handled in the player), so it must
        // not also mean "next file".
        case 'ArrowLeft':
        case 'Backspace':
          e.preventDefault()
          onPrev()
          break
        case 'ArrowRight':
          e.preventDefault()
          onNext()
          break
        case 'Home':
          e.preventDefault()
          onFirst()
          break
        case 'End':
          e.preventDefault()
          onLast()
          break
        case '+':
        case '=':
          e.preventDefault()
          onZoomIn()
          break
        case '-':
        case '_':
          e.preventDefault()
          onZoomOut()
          break
        case '0':
          e.preventDefault()
          onZoomReset()
          break
        case 'f':
        case 'F':
          e.preventDefault()
          onToggleFullscreen()
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onNext, onPrev, onFirst, onLast, onZoomIn, onZoomOut, onZoomReset, onToggleFullscreen])
}
export default useShortcuts
