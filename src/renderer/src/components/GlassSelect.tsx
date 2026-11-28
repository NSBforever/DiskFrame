import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import './GlassSelect.css'

export interface GlassSelectOption<T extends string> {
  value: T
  label: string
}

interface Props<T extends string> {
  value: T
  options: GlassSelectOption<T>[]
  onChange: (value: T) => void
  /** Accessible name, also used as the button tooltip. */
  label: string
}

/**
 * A themed replacement for `<select>`.
 *
 * A native select's popup is drawn by the OS, so it cannot take the app's
 * glass, spacing or colours - which is why the grouping dropdown looked like
 * it belonged to a different program. This renders the list itself: arrow keys
 * and Home/End move, Enter or Space choose, Escape closes and returns focus,
 * the current option carries a check, and a click anywhere outside dismisses.
 *
 * The list is portalled to <body> at a fixed position under the button. Drawn
 * inside the toolbar it shared the toolbar's stacking context, so the gallery
 * tiles painted over it whatever its z-index - and took its clicks.
 */
export default function GlassSelect<T extends string>({
  value,
  options,
  onChange,
  label
}: Props<T>): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number } | null>(null)
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      options.findIndex((o) => o.value === value)
    )
  )
  const rootRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const id = useId()

  const selected = options.find((o) => o.value === value) ?? options[0]

  const close = useCallback((focusButton = true) => {
    setOpen(false)
    if (focusButton) btnRef.current?.focus()
  }, [])

  const commit = useCallback(
    (i: number) => {
      const opt = options[i]
      if (opt) onChange(opt.value)
      close()
    },
    [options, onChange, close]
  )

  // Click outside dismisses. Pointerdown rather than click so it fires before
  // the button's own handler would toggle it straight back open.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node
      if (!rootRef.current?.contains(t) && !listRef.current?.contains(t)) setOpen(false)
    }
    // A fixed menu would drift from its button; closing is what native menus do.
    const onResize = (): void => setOpen(false)
    // Only when the scroll actually moves the button. This listener sees every
    // scroll in the window (scroll does not bubble, so it has to capture), and
    // the gallery scrolls continuously under the toolbar - wheel momentum,
    // smooth scrolling, a date jump settling. Closing on all of them made the
    // menu vanish on the next frame while the gallery moved, so it could not
    // be used at all mid-scroll. The toolbar is not inside the gallery's
    // scroller, so those scrolls leave the button, and the menu, where they are.
    const onScroll = (e: Event): void => {
      const t = e.target
      const root = rootRef.current
      if (!root) return
      if (t === document || t === window || (t instanceof Node && t.contains(root))) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  const openMenu = (): void => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 6, left: r.left, minWidth: r.width })
    // Each opening starts on the current choice, wherever the pointer left it last time.
    setActive(selectedIndex)
    setOpen(true)
  }

  useEffect(() => {
    if (open) listRef.current?.focus()
  }, [open])

  // Keyed on the selected index, not the options array: callers pass a fresh
  // array literal on every render, and the toolbar re-renders whenever a
  // gallery page lands - constantly while scrolling. Each of those reset the
  // highlighted option back to the selected one under the user's pointer or
  // arrow keys, so Enter could choose an option they had moved off.
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  )
  useEffect(() => {
    setActive(selectedIndex)
  }, [selectedIndex])

  const onListKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(options.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActive(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActive(options.length - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      commit(active)
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div className="glass-select" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        className="glass-select-button"
        title={label}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            openMenu()
          }
        }}
      >
        <span className="glass-select-value">{selected?.label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={listRef}
            className="glass-select-menu glass-panel"
            style={{ top: pos.top, left: pos.left, minWidth: pos.minWidth }}
            role="listbox"
            tabIndex={-1}
            aria-label={label}
            aria-activedescendant={id + '-' + active}
            onKeyDown={onListKey}
          >
            {options.map((o, i) => {
              const isSel = o.value === value
              return (
                <div
                  key={o.value}
                  id={id + '-' + i}
                  role="option"
                  aria-selected={isSel}
                  className={
                    'glass-select-option' +
                    (i === active ? ' is-active' : '') +
                    (isSel ? ' is-selected' : '')
                  }
                  onPointerEnter={() => setActive(i)}
                  onClick={() => commit(i)}
                >
                  <span className="glass-select-check">
                    {isSel && <Check size={12} aria-hidden="true" />}
                  </span>
                  <span>{o.label}</span>
                </div>
              )
            })}
          </div>,
          document.body
        )}
    </div>
  )
}
