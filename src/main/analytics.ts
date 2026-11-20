/**
 * Opt-in usage analytics and crash summaries (PostHog, EU). Pure: what may be
 * sent, and whether it may be sent at all. The main process does the sending.
 *
 * Privacy rules this file enforces, and analytics.test.ts pins:
 * - nothing is sent unless the user said yes (null = never asked = no), a
 *   project key was built in, and an install id exists;
 * - crash summaries have their own, separate yes;
 * - only the events below, each with a fixed set of fields whose values must
 *   match a pattern or a fixed list - so a file name, path, GPS coordinate,
 *   photo, thumbnail or Calendar detail can never be part of an event;
 * - the only identifier is a random install id the user can reset;
 * - PostHog is told not to look up location from the IP and not to build a
 *   person profile.
 */
import { randomUUID } from 'crypto'

export interface Consent {
  /** Usage analytics: true/false once asked, null before. */
  analytics: boolean | null
  /** Crash summaries, asked separately. */
  crashes: boolean | null
}

/** Features whose use is counted - names only, never what was opened. */
export const FEATURES = [
  'all_drives_opened',
  'events_opened',
  'place_opened',
  'trip_opened',
  'collection_created',
  'map_opened',
  'search_used',
  'viewer_opened',
  'update_history_opened'
] as const

const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,4}$/
const OS = /^(win32|darwin|linux)-\d{1,3}\.\d{1,3}\.\d{1,6}$/
const PROCESS_TYPES = ['browser', 'renderer', 'gpu', 'utility', 'zygote', 'sandbox_helper', 'pepper_plugin', 'unknown'] as const
const REASONS = ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction'] as const

type Check = (v: unknown) => boolean
const pattern = (re: RegExp): Check => (v) => typeof v === 'string' && re.test(v)
const oneOf = (list: readonly string[]): Check => (v) => typeof v === 'string' && list.includes(v)
const int: Check = (v) => Number.isSafeInteger(v)

const SCHEMAS: Record<string, Record<string, Check>> = {
  app_started: { version: pattern(VERSION), os: pattern(OS) },
  update_installed: { from: pattern(VERSION), to: pattern(VERSION) },
  feature_used: { feature: oneOf(FEATURES) },
  crash: { version: pattern(VERSION), process_type: oneOf(PROCESS_TYPES), reason: oneOf(REASONS), exit_code: int }
}
/** Fields an event must have; the rest of its schema is optional. */
const REQUIRED: Record<string, string[]> = {
  app_started: ['version'],
  update_installed: ['from', 'to'],
  feature_used: ['feature'],
  crash: ['version', 'process_type', 'reason']
}

export type EventName = keyof typeof SCHEMAS

export function canSend(consent: Consent, projectKey: string, installId: string, event: string): boolean {
  if (!projectKey || !installId) return false
  return event === 'crash' ? consent.crashes === true : consent.analytics === true
}

export interface CaptureEvent {
  api_key: string
  event: string
  distinct_id: string
  properties: Record<string, string | number | boolean>
}

/** A PostHog capture body with only allowlisted, validated fields - or null if the event is not allowed. */
export function buildEvent(event: string, props: Record<string, unknown>, installId: string, projectKey: string): CaptureEvent | null {
  const schema = SCHEMAS[event]
  if (!schema) return null
  const properties: CaptureEvent['properties'] = { $geoip_disable: true, $process_person_profile: false }
  for (const [key, check] of Object.entries(schema)) {
    if (props[key] === undefined) continue
    if (!check(props[key])) return null
    properties[key] = props[key] as string | number
  }
  if (REQUIRED[event].some((k) => properties[k] === undefined)) return null
  return { api_key: projectKey, event, distinct_id: installId, properties }
}

export function newInstallId(): string {
  return randomUUID()
}
