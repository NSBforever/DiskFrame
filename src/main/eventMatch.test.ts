import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchFiles, timeFit, confidence, type MatchEvent, type MatchFile, type Decision } from './eventMatch.ts'

const T = (hhmm: string): number => Date.parse(`2026-11-18T${hhmm}:00Z`)
const ev = (key: string, from: string, to: string, all_day: 0 | 1 = 0): MatchEvent => ({ key, start_ms: T(from), end_ms: T(to), all_day })
const f = (name: string, at: string, source: string | null = 'exif', ext = '.jpg'): MatchFile => ({ path: `E:\\${name}`, volume_id: 'VOL', ext, t: T(at), source })
const names = (m: Map<string, { path: string; status: string }[]>, key: string): string[] => (m.get(key) ?? []).map((x) => `${x.path.slice(3)}:${x.status}`)

test("the brief's example: a meeting's photos and recording, not its PDF", () => {
  const meeting = ev('team', '10:00', '11:30')
  const m = matchFiles(
    [meeting],
    [f('IMG_1024.jpg', '10:15'), f('IMG_1025.jpg', '10:32'), f('Screen Recording.mp4', '10:45', 'quicktime', '.mp4'), f('Notes.pdf', '11:10', 'mtime', '.pdf')],
    [],
    30
  )
  assert.deepEqual(names(m, 'team'), ['IMG_1024.jpg:suggested', 'IMG_1025.jpg:suggested', 'Screen Recording.mp4:suggested'])
})

test('time fit: 1 inside, falling to 0.5 across the buffer, 0 beyond', () => {
  const e = ev('e', '10:00', '11:00')
  assert.equal(timeFit(T('10:30'), e, 30 * 60_000), 1)
  assert.equal(timeFit(T('09:45'), e, 30 * 60_000), 0.75)
  assert.equal(timeFit(T('11:30'), e, 30 * 60_000), 0.5)
  assert.equal(timeFit(T('11:31'), e, 30 * 60_000), 0)
  assert.equal(timeFit(T('09:59'), e, 0), 0, 'buffer 0 means inside only')
})

test('a camera photo shortly before counts; one far into the buffer does not', () => {
  const m = matchFiles([ev('e', '10:00', '11:00')], [f('near.jpg', '09:50'), f('far.jpg', '09:35')], [], 30)
  // 09:50: fit 0.833 x 0.85 = 0.71 -> yes. 09:35: fit 0.583 x 0.85 = 0.50 -> no.
  assert.deepEqual(names(m, 'e'), ['near.jpg:suggested'])
})

test('a file dated only by the filesystem is never suggested on time alone', () => {
  assert.equal(confidence('mtime'), 0.3)
  assert.equal(confidence(null), 0.3)
  const m = matchFiles([ev('e', '10:00', '11:00')], [f('copied.jpg', '10:30', 'mtime'), f('created.jpg', '10:30', 'birthtime'), f('legacy.jpg', '10:30', null)], [], 30)
  assert.deepEqual(names(m, 'e'), [])
})

test('a burst that reaches into the event stays together', () => {
  // Shoot from 10:55 to 11:20, event ends 11:00. 11:20 alone: fit 0.67 x 0.85 = 0.57.
  const shoot = ['10:55', '11:00', '11:05', '11:10', '11:15', '11:20'].map((t, i) => f(`s${i}.jpg`, t))
  const m = matchFiles([ev('e', '10:00', '11:00')], shoot, [], 30)
  assert.equal((m.get('e') ?? []).length, 6)
  // The same late photos with no member inside the event are not lifted:
  // 11:05/11:10/11:15 qualify on their own (0.78/0.71/0.64), 11:20 (0.57) does not.
  const alone = matchFiles([ev('e', '10:00', '11:00')], shoot.slice(2), [], 30)
  assert.deepEqual(names(alone, 'e'), ['s2.jpg:suggested', 's3.jpg:suggested', 's4.jpg:suggested'])
})

test('the lift never reaches past the buffer, and never raises a filesystem date', () => {
  // A camera burst 10:20..10:52 reaching into a 10:00-10:30 event: all lifted
  // to fit 1 except z (11:05), which is beyond the 30 min buffer; b keeps its
  // filesystem date's 0.3 and is not suggested.
  const m = matchFiles([ev('e', '10:00', '10:30')], [f('in.jpg', '10:20'), f('a.jpg', '10:28'), f('b.jpg', '10:30', 'mtime'), f('c.jpg', '10:36'), f('d.jpg', '10:44'), f('x.jpg', '10:52'), f('z.jpg', '11:05')], [], 30)
  assert.deepEqual(names(m, 'e'), ['in.jpg:suggested', 'a.jpg:suggested', 'c.jpg:suggested', 'd.jpg:suggested', 'x.jpg:suggested'])
})

test('a file with only a filesystem date does not chain camera shots into a burst', () => {
  // Buffer 20 min. 10:57 inside; 11:06 a copy (mtime); 11:15 camera, alone
  // fit 0.58 x 0.85 = 0.49. Chained through the copy it would be lifted to
  // 0.85 - it must not be: the copy's time is not evidence.
  const m = matchFiles([ev('e', '10:30', '11:00')], [f('in.jpg', '10:57'), f('copy.jpg', '11:06', 'mtime'), f('late.jpg', '11:15')], [], 20)
  assert.deepEqual(names(m, 'e'), ['in.jpg:suggested'])
})

test('all-day and very long events give context, not suggestions', () => {
  const files = [f('a.jpg', '10:15'), f('b.jpg', '15:00')]
  const m = matchFiles([{ key: 'diwali', start_ms: T('00:00'), end_ms: T('23:59'), all_day: 1 }, ev('conference', '01:00', '20:00')], files, [], 30)
  assert.deepEqual(names(m, 'diwali'), [])
  assert.deepEqual(names(m, 'conference'), [], 'over 12 hours')
})

test('overlapping events: each file goes to one event, best fit, ties to the shorter', () => {
  const m = matchFiles([ev('workday', '09:00', '17:00'), ev('lunch', '12:00', '13:00'), ev('call', '16:50', '17:30')], [f('lunch.jpg', '12:30'), f('morning.jpg', '10:00'), f('late.jpg', '17:10')], [], 30)
  assert.deepEqual(names(m, 'lunch'), ['lunch.jpg:suggested'], 'inside both: the shorter wins')
  assert.deepEqual(names(m, 'workday'), ['morning.jpg:suggested'])
  assert.deepEqual(names(m, 'call'), ['late.jpg:suggested'], 'inside call (1.0) beats the workday buffer')
})

test("the user's decisions win: confirmed, manual, rejected, and a confirmed file leaves other suggestions", () => {
  const events = [ev('a', '10:00', '11:00'), ev('b', '10:30', '11:30')]
  const files = [f('x.jpg', '10:40'), f('y.jpg', '10:45'), f('doc.pdf', '08:00', 'mtime', '.pdf')]
  const decisions: Decision[] = [
    { path: 'E:\\x.jpg', volume_id: 'VOL', key: 'b', state: 'confirmed' },
    { path: 'E:\\y.jpg', volume_id: 'VOL', key: 'a', state: 'rejected' },
    { path: 'E:\\doc.pdf', volume_id: 'VOL', key: 'a', state: 'manual' }
  ]
  const m = matchFiles(events, files, decisions, 30)
  assert.deepEqual(names(m, 'a'), ['doc.pdf:manual'], 'x went to b, y was rejected here')
  assert.deepEqual(names(m, 'b'), ['x.jpg:confirmed', 'y.jpg:suggested'], 'a rejected file can still belong elsewhere')
})

test('the same path on another volume is a different file', () => {
  const m = matchFiles([ev('e', '10:00', '11:00')], [f('a.jpg', '10:30'), { ...f('a.jpg', '10:31'), volume_id: 'OTHER' }], [{ path: 'E:\\a.jpg', volume_id: 'VOL', key: 'e', state: 'rejected' }], 30)
  assert.deepEqual((m.get('e') ?? []).map((x) => x.volume_id), ['OTHER'])
})
