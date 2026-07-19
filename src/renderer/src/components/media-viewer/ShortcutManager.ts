import { useEffect } from 'react'

export interface ShortcutProps {
  onNext: () => void
  onPrev: () => void
  onFirst: () => void
  onLast: () => void
  onClose: () => void
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
  onClose,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onToggleFullscreen,
  isOpen
}: ShortcutProps) {
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.getAttribute('contenteditable') === 'true')) {
        return
      }

      switch (e.key) {
        case 'ArrowLeft':
        case 'Backspace':
          e.preventDefault()
          onPrev()
          break
        case 'ArrowRight':
        case ' ':
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
        case 'Escape':
          e.preventDefault()
          onClose()
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
  }, [isOpen, onNext, onPrev, onFirst, onLast, onClose, onZoomIn, onZoomOut, onZoomReset, onToggleFullscreen])
}
export default useShortcuts
