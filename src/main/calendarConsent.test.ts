import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { CONSENT_SCHEMA_SQL, ensureConsentSchema, isMatchingAllowed, setMatchingAllowed, consentList, type ConsentDb } from './calendarConsent.ts'

const NOW = new Date('2026-11-19T10:00:00Z')
const C = '\\\\?\\Volume{CCCC}\\'
const E = '\\\\?\\Volume{EEEE}\\'
const G = '\\\\?\\Volume{GGGG}\\'

function makeDb(links: [string, string | null][] = []): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE event_file_links (path TEXT NOT NULL, volume_id TEXT, calendar_id TEXT NOT NULL, event_id TEXT NOT NULL,
    state TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (path, volume_id, calendar_id, event_id))`)
  const ins = db.prepare("INSERT INTO event_file_links VALUES (?, ?, 'primary', 'e1', 'manual', 'T')")
  for (const [p, v] of links) ins.run(p, v)
  return db
}
const d = (db: DatabaseSync): ConsentDb => db as unknown as ConsentDb

test('a drive is never matched until the user allows it - new drives start excluded', () => {
  const db = makeDb()
  ensureConsentSchema(d(db), NOW)
  assert.equal(isMatchingAllowed(d(db), C), false)
  assert.equal(isMatchingAllowed(d(db), null), false)
  setMatchingAllowed(d(db), C, true, NOW)
  assert.equal(isMatchingAllowed(d(db), C), true)
  assert.equal(isMatchingAllowed(d(db), E), false, 'allowing one drive says nothing about another')
})

test('a choice can be taken back, and is remembered either way', () => {
  const db = makeDb()
  ensureConsentSchema(d(db), NOW)
  setMatchingAllowed(d(db), E, true, NOW)
  setMatchingAllowed(d(db), E, false, NOW)
  assert.equal(isMatchingAllowed(d(db), E), false)
  assert.deepEqual(consentList(d(db)), [{ volumeId: E, allowed: false, decidedAt: NOW.toISOString() }])
})

test('drives the user already matched in 1.4.0 keep working once; nothing else is granted', () => {
  const db = makeDb([
    ['C:\\a.jpg', C],
    ['C:\\b.jpg', C],
    ['G:\\c.jpg', G],
    ['X:\\legacy.jpg', null]
  ])
  ensureConsentSchema(d(db), NOW)
  assert.equal(isMatchingAllowed(d(db), C), true)
  assert.equal(isMatchingAllowed(d(db), G), true)
  assert.equal(isMatchingAllowed(d(db), E), false)
  // Only when the table is first made: a later "no" is not overridden on the next launch.
  setMatchingAllowed(d(db), G, false, NOW)
  ensureConsentSchema(d(db), NOW)
  assert.equal(isMatchingAllowed(d(db), G), false)
})

test('consent is keyed by volume: another drive given the same letter does not inherit it', () => {
  const db = makeDb()
  db.exec(CONSENT_SCHEMA_SQL)
  setMatchingAllowed(d(db), C, true, NOW)
  assert.equal(isMatchingAllowed(d(db), E), false)
})
