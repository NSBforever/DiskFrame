import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeEvent, localDay, plainText, type EventRow } from './eventNormalize.ts'

// Days are this machine's local days, so expectations are computed the same
// way the gallery labels them; the instants themselves are exact.
const row = (e: Parameters<typeof normalizeEvent>[0]): EventRow => {
  const c = normalizeEvent(e)
  assert.equal(c.kind, 'upsert')
  return (c as { row: EventRow }).row
}
const midnight = (y: number, m: number, d: number): number => new Date(y, m - 1, d).getTime()

test('a timed event keeps its exact instants whatever zone it was written in', () => {
  const r = row({
    id: 'a',
    summary: 'Team Meeting',
    start: { dateTime: '2026-11-18T10:00:00+05:30', timeZone: 'Asia/Kolkata' },
    end: { dateTime: '2026-11-18T11:30:00+05:30' }
  })
  assert.equal(r.start_ms, Date.parse('2026-11-18T04:30:00Z'))
  assert.equal(r.end_ms, Date.parse('2026-11-18T06:00:00Z'))
  assert.equal(r.all_day, 0)
  assert.equal(r.start_day, localDay(r.start_ms))
  assert.equal(r.event_tz, 'Asia/Kolkata')
  // The same meeting written from New York is the same instant.
  const ny = row({ id: 'b', start: { dateTime: '2026-11-17T23:30:00-05:00' }, end: { dateTime: '2026-11-18T01:00:00-05:00' } })
  assert.equal(ny.start_ms, r.start_ms)
  assert.equal(ny.end_ms, r.end_ms)
})

test('an all-day event covers its dates, and Google\'s end date is exclusive', () => {
  const one = row({ id: 'c', summary: 'Diwali', start: { date: '2026-11-08' }, end: { date: '2026-11-09' } })
  assert.equal(one.all_day, 1)
  assert.equal(one.start_day, '2026-11-08')
  assert.equal(one.end_day, '2026-11-08', 'a one-day event does not reach the 9th')
  assert.equal(one.start_ms, midnight(2026, 11, 8))
  assert.equal(one.end_ms, midnight(2026, 11, 9))
  const trip = row({ id: 'd', start: { date: '2026-12-29' }, end: { date: '2027-01-03' } })
  assert.equal(trip.start_day, '2026-12-29')
  assert.equal(trip.end_day, '2027-01-02', 'multi-day, across a year')
})

test('a timed event ending at midnight does not spill into the next day', () => {
  const s = new Date(2026, 10, 18, 22, 0).getTime()
  const e = new Date(2026, 10, 19, 0, 0).getTime()
  const r = row({ id: 'e', start: { dateTime: new Date(s).toISOString() }, end: { dateTime: new Date(e).toISOString() } })
  assert.equal(r.start_day, '2026-11-18')
  assert.equal(r.end_day, '2026-11-18')
  const multi = row({ id: 'f', start: { dateTime: new Date(s).toISOString() }, end: { dateTime: new Date(2026, 10, 20, 9, 0).toISOString() } })
  assert.equal(multi.end_day, '2026-11-20', 'a timed event over several days')
})

test('DST transition days keep exact instants (US and EU)', () => {
  // 2026-03-08 02:00 New York springs forward; 2026-10-25 03:00 Berlin falls back.
  const spring = row({ id: 'g', start: { dateTime: '2026-03-08T01:30:00-05:00' }, end: { dateTime: '2026-03-08T03:30:00-04:00' } })
  assert.equal(spring.end_ms - spring.start_ms, 60 * 60 * 1000, 'one real hour across the jump')
  const fall = row({ id: 'h', start: { dateTime: '2026-10-25T02:30:00+02:00' }, end: { dateTime: '2026-10-25T02:30:00+01:00' } })
  assert.equal(fall.end_ms - fall.start_ms, 60 * 60 * 1000, 'the repeated hour is a real hour')
})

test('recurring instances, moved instances and cancellations', () => {
  const inst = row({
    id: 'series_20261118T043000Z',
    recurringEventId: 'series',
    originalStartTime: { dateTime: '2026-11-18T10:00:00+05:30' },
    start: { dateTime: '2026-11-18T12:00:00+05:30' },
    end: { dateTime: '2026-11-18T13:00:00+05:30' }
  })
  assert.equal(inst.recurring_event_id, 'series')
  assert.equal(inst.original_start_ms, Date.parse('2026-11-18T04:30:00Z'), 'the occurrence it replaced')
  assert.deepEqual(normalizeEvent({ id: 'series_20261125T043000Z', status: 'cancelled', recurringEventId: 'series' }), {
    kind: 'delete',
    event_id: 'series_20261125T043000Z'
  })
  assert.deepEqual(normalizeEvent({ id: 'x', status: 'cancelled' }), { kind: 'delete', event_id: 'x' })
})

test('malformed items are skipped, never stored with invented times', () => {
  assert.equal(normalizeEvent({}).kind, 'skip')
  assert.equal(normalizeEvent({ id: 'n', start: {} }).kind, 'skip')
  assert.equal(normalizeEvent({ id: 'n', start: { dateTime: 'nonsense' } }).kind, 'skip')
  assert.equal(normalizeEvent({ id: 'n', start: { date: '2026-13-45x' } }).kind, 'skip')
  const noEnd = row({ id: 'n', start: { dateTime: '2026-11-18T10:00:00Z' } })
  assert.equal(noEnd.end_ms, noEnd.start_ms)
})

test('event text is plain text only - no markup reaches the renderer', () => {
  assert.equal(plainText('<b>Hi</b> <img src=x onerror=alert(1)>there', 100), 'Hi there')
  assert.equal(plainText('a<br>b<p>c</p>d', 100), 'a\nbc\nd')
  assert.equal(plainText('Agenda<script>alert(1)</script><style>p{}</style> done', 100), 'Agenda done', 'no script or style text')
  assert.equal(plainText('&lt;script&gt; &amp; &quot;x&quot;', 100), '<script> & "x"')
  assert.equal(plainText('x'.repeat(50), 10).length, 10)
  assert.equal(row({ id: 't', start: { date: '2026-11-18' } }).summary, '(No title)')
})
