import { useEffect, useState } from 'react'
import type { CalendarStatus, EventDetail, EventsList } from '../../../main/calendarTypes'

/**
 * Data for the Events section, fetched from the main process. Any sync,
 * disconnect or change to the user's links bumps the version, and every view
 * re-reads.
 */

let version = 0
const listeners = new Set<() => void>()

export function bumpCalendar(): void {
  version++
  listeners.forEach((l) => l())
}

function useVersion(): number {
  const [v, setV] = useState(version)
  useEffect(() => {
    const l = (): void => setV(version)
    listeners.add(l)
    let last = ''
    const off = window.api.onCalendarStatus((s) => {
      // A finished sync (or a disconnect) changes what the views show.
      const sig = `${s.state}|${s.lastSyncAt}|${s.eventCount}`
      if (sig !== last && s.state !== 'syncing') {
        last = sig
        bumpCalendar()
      }
    })
    return () => {
      listeners.delete(l)
      off()
    }
  }, [])
  return v
}

/** Loads `fetch()` for `key`; null while loading. Derived, never reset in an effect. */
function useLoaded<T>(key: string | null, fetch: () => Promise<T>): T | null {
  const [loaded, setLoaded] = useState<{ key: string; value: T } | null>(null)
  useEffect(() => {
    if (!key) return
    let live = true
    fetch()
      .then((value) => live && setLoaded({ key, value }))
      .catch(() => {})
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` names everything fetch depends on
  }, [key])
  return key && loaded?.key === key ? loaded.value : null
}

export function useEventsList(drive: string | null): EventsList | null {
  const v = useVersion()
  return useLoaded(drive ? `${v}|${drive}` : null, () => window.api.calendarEvents(drive!))
}

export function useEventDetail(drive: string | null, ev: { calendarId: string; eventId: string } | null): EventDetail | null {
  const v = useVersion()
  return useLoaded(drive && ev ? `${v}|${drive}|${ev.calendarId}|${ev.eventId}` : null, () => window.api.calendarEvent(drive!, ev!.calendarId, ev!.eventId))
}

export function useCalendarStatus(): CalendarStatus | null {
  const [s, setS] = useState<CalendarStatus | null>(null)
  useEffect(() => {
    window.api.calendarStatus().then(setS).catch(() => {})
    return window.api.onCalendarStatus(setS)
  }, [])
  return s
}

/** A sharp cover for a card or hero; the thumbnail until (or unless) one exists. */
export function useCover(file: { path: string; thumb: string | null } | null): string | null {
  const made = useLoaded(file ? `cover|${file.path}` : null, () => window.api.calendarCover(file!.path))
  return made ?? file?.thumb ?? null
}
