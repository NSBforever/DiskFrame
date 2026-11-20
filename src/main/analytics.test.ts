import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildEvent, canSend, newInstallId, FEATURES, type Consent } from './analytics.ts'

const ID = 'a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f607'
const on: Consent = { analytics: true, crashes: true }

test('nothing is sent without consent, without a key, or without an install id', () => {
  assert.equal(canSend({ analytics: false, crashes: false }, 'phc_key', ID, 'app_started'), false)
  assert.equal(canSend({ analytics: null, crashes: null }, 'phc_key', ID, 'app_started'), false, 'never asked = no')
  assert.equal(canSend(on, '', ID, 'app_started'), false, 'a build without a key never sends')
  assert.equal(canSend(on, 'phc_key', '', 'app_started'), false)
  assert.equal(canSend(on, 'phc_key', ID, 'app_started'), true)
  // Crash summaries have their own consent.
  assert.equal(canSend({ analytics: true, crashes: false }, 'phc_key', ID, 'crash'), false)
  assert.equal(canSend({ analytics: false, crashes: true }, 'phc_key', ID, 'crash'), true)
  assert.equal(canSend({ analytics: false, crashes: true }, 'phc_key', ID, 'app_started'), false)
})

test('only known events with known, well-formed fields; anything else is dropped', () => {
  const e = buildEvent('app_started', { version: '1.6.0', os: 'win32-10.0.26300', path: 'C:\\Users\\me\\x.jpg' }, ID, 'phc_key')!
  assert.equal(e.event, 'app_started')
  assert.equal(e.distinct_id, ID)
  assert.equal(e.api_key, 'phc_key')
  assert.deepEqual(Object.keys(e.properties).sort(), ['$geoip_disable', '$process_person_profile', 'os', 'version'])
  assert.equal(e.properties.$geoip_disable, true)
  assert.equal(e.properties.$process_person_profile, false)
  assert.equal(buildEvent('opened_photo', { name: 'x' }, ID, 'k'), null, 'unknown events are never built')
  assert.equal(buildEvent('feature_used', { feature: 'C:\\secret' }, ID, 'k'), null, 'feature names come from a fixed list')
  assert.ok(buildEvent('feature_used', { feature: FEATURES[0] }, ID, 'k'))
  assert.equal(buildEvent('update_installed', { from: '1.5.0', to: '../../etc' }, ID, 'k'), null, 'versions must be versions')
  assert.ok(buildEvent('update_installed', { from: '1.5.0', to: '1.6.0' }, ID, 'k'))
})

test('a crash summary carries no path, file name or free text', () => {
  const e = buildEvent('crash', { version: '1.6.0', process_type: 'renderer', reason: 'crashed', exit_code: -1073741819, detail: 'E:\\DCIM\\IMG_1.JPG' }, ID, 'k')!
  assert.deepEqual(Object.keys(e.properties).filter((k) => !k.startsWith('$')).sort(), ['exit_code', 'process_type', 'reason', 'version'])
  assert.equal(buildEvent('crash', { version: '1.6.0', process_type: 'C:\\x', reason: 'crashed' }, ID, 'k'), null)
})

test('no event payload can contain a path, coordinates or an e-mail address', () => {
  const samples = [
    buildEvent('app_started', { version: '1.6.0', os: 'win32-10.0.26300' }, ID, 'k'),
    buildEvent('update_installed', { from: '1.5.0', to: '1.6.0' }, ID, 'k'),
    ...FEATURES.map((f) => buildEvent('feature_used', { feature: f }, ID, 'k')),
    buildEvent('crash', { version: '1.6.0', process_type: 'gpu', reason: 'oom', exit_code: 1 }, ID, 'k')
  ]
  for (const s of samples) {
    const text = JSON.stringify(s)
    assert.ok(!/[A-Za-z]:\\|\/Users\/|\\\\/.test(text), text)
    assert.ok(!/-?\d{1,3}\.\d{4,}/.test(text.replace(/"version":"[^"]+"|"os":"[^"]+"|"from":"[^"]+"|"to":"[^"]+"/g, '')), text)
    assert.ok(!/@/.test(text), text)
  }
})

test('install ids are random v4 UUIDs, different every time', () => {
  const a = newInstallId()
  const b = newInstallId()
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(a, b)
})
