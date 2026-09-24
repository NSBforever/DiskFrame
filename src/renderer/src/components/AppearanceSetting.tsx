import React, { useCallback, useEffect, useState } from 'react'
import { Sun, Moon } from 'lucide-react'
import { useReducedMotionPref } from '../hooks/useReducedMotionPref'
import './AppearanceSetting.css'

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

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Resolves `system` against the OS and writes it where the CSS can see it. */
export function applyThemePref(pref: ThemePref): void {
  const dark = pref === 'dark' || (pref === 'system' && systemPrefersDark())
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.documentElement.dataset.themePref = pref
}

/**
 * Light/Dark capsule with a sliding thumb, plus a separate "use system theme"
 * control so following the OS is still reachable.
 *
 * The value is stored in localStorage rather than the database because
 * index.html reads it synchronously before the bundle parses - an async round
 * trip would paint the old theme first and then repaint, which is the flash
 * this is meant to avoid.
 */
export default function AppearanceSetting(): React.JSX.Element {
  const reducedMotion = useReducedMotionPref()
  const [pref, setPref] = useState<ThemePref>(readThemePref)
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark)

  // Track the OS so the capsule shows what "system" currently resolves to.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => {
      setSystemDark(mq.matches)
      if (readThemePref() === 'system') applyThemePref('system')
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const choose = useCallback((next: ThemePref) => {
    setPref(next)
    try {
      localStorage.setItem(KEY, next)
    } catch {
      /* not persisting is survivable; applying it is not */
    }
    applyThemePref(next)
  }, [])

  const usingSystem = pref === 'system'
  const isDark = pref === 'dark' || (usingSystem && systemDark)

  return (
    <section
      aria-labelledby="appearance-heading"
      className="glass-panel appearance-card"
    >
      <h3 id="appearance-heading" className="appearance-title">
        Appearance
      </h3>
      <div className="appearance-sub">
        Media keeps its own colours in every theme, and the viewer background stays dark.
      </div>

      <div className="appearance-row">
        <div
          className={
            'theme-switch' +
            (isDark ? ' is-dark' : '') +
            (usingSystem ? ' is-system' : '') +
            (reducedMotion ? ' no-anim' : '')
          }
          role="radiogroup"
          aria-label="Theme"
        >
          {/* One thumb that slides between the two halves. */}
          <span className="theme-switch-thumb" aria-hidden="true" />
          <button
            type="button"
            role="radio"
            aria-checked={!isDark}
            className={'theme-switch-half' + (!isDark ? ' is-on' : '')}
            onClick={() => choose('light')}
          >
            <Sun size={14} aria-hidden="true" />
            <span>Light</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={isDark}
            className={'theme-switch-half' + (isDark ? ' is-on' : '')}
            onClick={() => choose('dark')}
          >
            <Moon size={14} aria-hidden="true" />
            <span>Dark</span>
          </button>
        </div>

        <label className="theme-system">
          <input
            type="checkbox"
            checked={usingSystem}
            onChange={(e) => choose(e.target.checked ? 'system' : systemDark ? 'dark' : 'light')}
          />
          <span>
            Use system theme
            {usingSystem && (
              <span className="theme-system-hint"> — currently {systemDark ? 'dark' : 'light'}</span>
            )}
          </span>
        </label>
      </div>
    </section>
  )
}
