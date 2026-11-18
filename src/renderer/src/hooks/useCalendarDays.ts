import { useEffect, useState } from 'react'
import type { DayEvent } from '../../../main/calendarTypes'

/**
 * Calendar data for the gallery: which days have events, and one day's events
 * with their files. Fetched from the main process on demand and cached per
 * day; any sync, disconnect or link change clears the cache.
 */

/** Bumped whenever events or the user's links change; keys every cache. */
let version = 0
const listeners = new Set<() => void>()
const dayCache = new Map<string, Promise<DayEvent[]>>()

export function bumpCalendar(): void {
  version++
  dayCache.clear()
  listeners.forEach((l) => l())
}

function loadDay(drive: string, day: string): Promise<DayEvent[]> {
  const key = `${drive}|${day}`
  let p = dayCache.get(key)
  if (!p) {
    p = window.api.calendarDay(drive, day).catch(() => [])
    dayCache.set(key, p)
  }
  return p
}

function useCalendarVersion(): number {
  const [v, setV] = useState(version)
  useEffect(() => {
    const l = (): void => setV(version)
    listeners.add(l)
    return () => void listeners.delete(l)
  }, [])
  return v
}

/** Which local days have events at all, refreshed after every sync. */
export function useCalendarEventDays(): { days: Set<string>; version: number } {
  const [state, setState] = useState<{ days: Set<string>; version: number }>({ days: new Set(), version: 0 })
  useEffect(() => {
    let live = true
    let last = ''
    const refresh = (): void => {
      window.api
        .calendarEventDays()
        .then((d) => live && setState({ days: new Set(d), version }))
        .catch(() => {})
    }
    refresh()
    listeners.add(refresh)
    const off = window.api.onCalendarStatus((s) => {
      // A finished sync (or a disconnect) changes what is cached.
      const sig = `${s.state}|${s.lastSyncAt}|${s.eventCount}`
      if (sig !== last && s.state !== 'syncing') {
        last = sig
        bumpCalendar()
      }
    })
    return () => {
      live = false
      listeners.delete(refresh)
      off()
    }
  }, [])
  return state
}

/** One day's events with their files; null while loading or when disabled. */
export function useDayEvents(drive: string | null, day: string | null, enabled: boolean): DayEvent[] | null {
  const v = useCalendarVersion()
  const key = enabled && drive && day ? `${v}|${drive}|${day}` : null
  const [loaded, setLoaded] = useState<{ key: string; events: DayEvent[] } | null>(null)
  useEffect(() => {
    if (!key || !drive || !day) return
    let live = true
    loadDay(drive, day).then((events) => live && setLoaded({ key, events }))
    return () => {
      live = false
    }
  }, [key, drive, day])
  // Derived rather than reset in the effect: a stale day never shows.
  return key && loaded?.key === key ? loaded.events : null
}
