import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Sun, Moon, MonitorCog, Palette } from 'lucide-react'
import { useReducedMotionPref } from '../hooks/useReducedMotionPref'
import { SettingsCard } from './SettingsCard'
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

const OPTIONS: { value: ThemePref; label: string; icon: React.ReactNode }[] = [
  { value: 'light', label: 'Light', icon: <Sun size={14} aria-hidden="true" /> },
  { value: 'dark', label: 'Dark', icon: <Moon size={14} aria-hidden="true" /> },
  { value: 'system', label: 'System', icon: <MonitorCog size={14} aria-hidden="true" /> }
]

/**
 * Light / Dark / System as one segmented control with a sliding thumb. It is a
 * radio group: one tab stop, arrow keys move the choice (and apply it, as
 * radios do).
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
  const groupRef = useRef<HTMLDivElement>(null)

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

  const index = OPTIONS.findIndex((o) => o.value === pref)

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0
    const to =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? OPTIONS.length - 1
          : step
            ? (index + step + OPTIONS.length) % OPTIONS.length
            : -1
    if (to < 0) return
    e.preventDefault()
    choose(OPTIONS[to].value)
    groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[to]?.focus()
  }

  return (
    <SettingsCard
      id="appearance"
      icon={<Palette size={16} />}
      title="Appearance"
      description="Media keeps its own colours in every theme, and the viewer background stays dark."
    >
      <div className="settings-row settings-row--stack">
        <div className="settings-row-head">
          <span className="settings-label" id="theme-label">
            Theme
          </span>
          <span className="settings-hint" id="theme-hint">
            {pref === 'system'
              ? `Following Windows, currently ${systemDark ? 'dark' : 'light'}`
              : `Always ${pref}`}
          </span>
        </div>
        <div
          ref={groupRef}
          className={'theme-seg' + (reducedMotion ? ' no-anim' : '')}
          role="radiogroup"
          aria-labelledby="theme-label"
          aria-describedby="theme-hint"
          style={{ '--seg-i': index } as React.CSSProperties}
          onKeyDown={onKeyDown}
        >
          {/* One thumb that slides under the chosen option. */}
          <span className="theme-seg-thumb" aria-hidden="true" />
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={pref === o.value}
              tabIndex={pref === o.value ? 0 : -1}
              className="theme-seg-opt"
              onClick={() => choose(o.value)}
            >
              {o.icon}
              <span>{o.label}</span>
            </button>
          ))}
        </div>
      </div>
    </SettingsCard>
  )
}
