import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calendarCard, calendarStatusLine } from './calendarView.ts'
import type { CalendarState, CalendarStatus } from './calendarTypes.ts'

const NOW = Date.parse('2026-11-19T12:00:00Z')
const status = (state: CalendarState, more: Partial<CalendarStatus> = {}): CalendarStatus => ({
  state,
  email: null,
  connectedAt: null,
  lastSyncAt: null,
  message: null,
  eventCount: 0,
  autoSync: true,
  bufferMin: 30,
  ...more
})

test('every calendar state lands in exactly one of the five card states', () => {
  const kinds: Record<CalendarState, string> = {
    unconfigured: 'unavailable',
    disconnected: 'disconnected',
    connecting: 'disconnected',
    connected: 'connected',
    syncing: 'connected',
    offline: 'failed',
    expired: 'expired',
    error: 'failed'
  }
  for (const [state, kind] of Object.entries(kinds))
    assert.equal(calendarCard(status(state as CalendarState)).kind, kind, state)
})

test('a build without Google set up says so, and offers nothing to connect', () => {
  const c = calendarCard(
    status('unconfigured', { message: 'Google Calendar is not set up in this build.' })
  )
  assert.equal(c.chip, 'Not available')
  assert.equal(c.tone, 'neutral')
  assert.equal(c.canConnect, false)
  assert.equal(
    calendarStatusLine(
      status('unconfigured', { message: 'Google Calendar is not set up in this build.' }),
      NOW
    ),
    'Google Calendar is not set up in this build.'
  )
  // No message from main still explains it.
  assert.match(calendarStatusLine(status('unconfigured'), NOW), /not available/i)
})

test('configured but not connected can connect; while connecting it cannot be pressed twice', () => {
  assert.equal(calendarCard(status('disconnected')).canConnect, true)
  assert.equal(calendarCard(status('disconnected')).chip, 'Not connected')
  assert.equal(calendarCard(status('connecting')).canConnect, false)
  assert.equal(calendarCard(status('connecting')).chip, 'Connecting…')
})

test('connected shows the account and when it last synced', () => {
  const s = status('connected', {
    email: 'me@example.com',
    lastSyncAt: new Date(NOW - 5 * 60_000).toISOString(),
    eventCount: 1234
  })
  const c = calendarCard(s)
  assert.equal(c.chip, 'Connected')
  assert.equal(c.tone, 'ok')
  assert.equal(c.canConnect, false)
  const line = calendarStatusLine(s, NOW)
  assert.match(line, /me@example\.com/)
  assert.match(line, /Last synced 5 min ago/)
  // The count in the user's own number format, as before (1,234 / 1.234 / 1 234).
  assert.match(line, /1\D?234 events/)
  assert.equal(calendarCard(status('syncing')).chip, 'Syncing…')
})

test('an expired sign-in asks to reconnect', () => {
  const c = calendarCard(status('expired', { message: 'Google needs you to sign in again.' }))
  assert.equal(c.chip, 'Sign-in expired')
  assert.equal(c.tone, 'warn')
  assert.equal(c.canConnect, true)
  assert.match(
    calendarStatusLine(status('expired', { message: 'Google needs you to sign in again.' }), NOW),
    /sign in again/
  )
})

test('a failed sync says it failed and keeps the last good sync time', () => {
  const last = new Date(NOW - 3 * 3600_000).toISOString()
  const err = calendarCard(
    status('error', { message: 'Sync failed. Showing saved events.', lastSyncAt: last })
  )
  assert.equal(err.chip, 'Sync failed')
  assert.equal(err.tone, 'danger')
  assert.equal(err.canConnect, false)
  assert.match(
    calendarStatusLine(
      status('error', { message: 'Sync failed. Showing saved events.', lastSyncAt: last }),
      NOW
    ),
    /Last synced 3 h ago/
  )
  // Offline is a failed sync too, but a softer one: it retries by itself.
  const off = calendarCard(
    status('offline', { message: 'You appear to be offline. Showing saved events.' })
  )
  assert.equal(off.chip, 'Offline')
  assert.equal(off.tone, 'warn')
})

test('a sync that never happened reads as "not yet", not a date', () => {
  assert.match(calendarStatusLine(status('connected'), NOW), /Last synced not yet/)
})
