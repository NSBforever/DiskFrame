import { useSyncExternalStore } from 'react'

// One MediaQueryList for the whole app. Every gallery tile reads this, and a
// matchMedia() per tile mount - two, counting the listener's - showed up in
// fast-scroll profiles as hundreds of query objects created per second.
const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
const subscribe = (onChange: () => void): (() => void) => {
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}
const read = (): boolean => mq.matches

export function useReducedMotionPref(): boolean {
  return useSyncExternalStore(subscribe, read)
}
