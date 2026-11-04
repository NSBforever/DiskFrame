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
    const onMove = (): void => setOpen(false)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [open])

  const openMenu = (): void => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 6, left: r.left, minWidth: r.width })
    setOpen(true)
  }

  useEffect(() => {
    if (open) listRef.current?.focus()
  }, [open])

  useEffect(() => {
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value)
      )
    )
  }, [value, options])

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
