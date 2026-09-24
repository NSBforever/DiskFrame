import React, { useCallback, useEffect, useState } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'

const KEY = 'diskframe-theme'

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* private window / blocked storage: fall through to the default */
  }
  return 'system'
}

/** Resolves `system` against the OS and writes it where the CSS can see it. */
export function applyThemePref(pref: ThemePref): void {
  const dark =
    pref === 'dark' ||
    (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.documentElement.dataset.themePref = pref
}

const OPTIONS: { id: ThemePref; label: string; hint: string }[] = [
  { id: 'system', label: 'System', hint: 'Follow Windows' },
  { id: 'light', label: 'Light', hint: 'Always light' },
  { id: 'dark', label: 'Dark', hint: 'Always dark' }
]

/**
 * Appearance picker. The value is stored in localStorage rather than the
 * database because index.html reads it synchronously before the bundle parses
 * - an async round trip would paint the old theme first and then repaint.
 */
export default function AppearanceSetting(): React.JSX.Element {
  const [pref, setPref] = useState<ThemePref>(readThemePref)

  // Track the OS only while the choice is "system".
  useEffect(() => {
    if (pref !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => applyThemePref('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [pref])

  const choose = useCallback((next: ThemePref) => {
    setPref(next)
    try {
      localStorage.setItem(KEY, next)
    } catch {
      /* not persisting is survivable; applying it is not */
    }
    applyThemePref(next)
  }, [])

  return (
    <section
      aria-labelledby="appearance-heading"
      style={{
        background: 'var(--app-panel, var(--app-surface, var(--app-surface, #111114)))',
        border: '1px solid var(--app-hairline, rgba(255,255,255,0.06))',
        borderRadius: '8px',
        padding: '18px 20px'
      }}
    >
      <h3
        id="appearance-heading"
        style={{
          margin: 0,
          fontSize: '11px',
          fontWeight: 700,
          letterSpacing: '0.5px',
          textTransform: 'uppercase',
          color: 'var(--app-accent, #e11d2e)'
        }}
      >
        Appearance
      </h3>
      <div style={{ fontSize: '12px', color: 'var(--app-fg-dim, var(--app-fg-dim, #8a8a8f))', margin: '6px 0 14px' }}>
        Media keeps its own colours in every theme, and the viewer background stays dark.
      </div>
      <div role="radiogroup" aria-labelledby="appearance-heading" style={{ display: 'flex', gap: '8px' }}>
        {OPTIONS.map((o) => {
          const active = pref === o.id
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => choose(o.id)}
              style={{
                flex: '1 1 0',
                padding: '10px 12px',
                borderRadius: '8px',
                cursor: 'pointer',
                textAlign: 'left',
                background: active
                  ? 'var(--dock-item-active, rgba(225,29,46,0.18))'
                  : 'var(--dock-item-hover, rgba(255,255,255,0.05))',
                border: active
                  ? '1px solid var(--app-accent, #e11d2e)'
                  : '1px solid var(--app-hairline, rgba(255,255,255,0.08))',
                color: 'var(--app-fg, var(--app-fg, #f2f2f0))'
              }}
            >
              <div style={{ fontSize: '13px', fontWeight: 600 }}>{o.label}</div>
              <div style={{ fontSize: '10px', color: 'var(--app-fg-dim, var(--app-fg-dim, #8a8a8f))', marginTop: '2px' }}>
                {o.hint}
              </div>
            </button>
          )
        })}
      </div>
    </section>
  )
}
