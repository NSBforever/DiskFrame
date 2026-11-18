import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { CALENDAR_SCHEMA_SQL, syncTokenOf } from './calendarStore.ts'
import { syncCalendar, SyncError, type SyncDeps } from './calendarSync.ts'
import { authorize, refreshAccess, googleConfig, OAuthError } from './googleAuth.ts'
import { startGoogleMock, type GoogleMock } from './googleMock.ts'
import type { GoogleEvent } from './eventNormalize.ts'

async function setup(): Promise<{ g: GoogleMock; db: DatabaseSync; deps: SyncDeps }> {
  const g = await startGoogleMock()
  const cfg = googleConfig({ DF_GOOGLE_CLIENT_ID: 'test-client', DF_GOOGLE_API_BASE: g.base })!
  const t = await authorize(cfg, { fetch, openUrl: async (u) => void (await fetch(u)) })
  let access = t.accessToken
  const db = new DatabaseSync(':memory:')
  db.exec(CALENDAR_SCHEMA_SQL)
  const deps: SyncDeps = {
    db,
    fetch,
    apiBase: cfg.apiBase,
    accessToken: async (force) => {
      if (force) access = (await refreshAccess(cfg, fetch, t.refreshToken!)).accessToken
      return access
    },
    now: () => Date.parse('2026-11-18T00:00:00Z')
  }
  return { g, db, deps }
}
const at = (id: string, iso: string, extra: Partial<GoogleEvent> = {}): GoogleEvent => ({ id, summary: id, start: { dateTime: iso }, end: { dateTime: iso }, ...extra })
const ids = (db: DatabaseSync): string[] => (db.prepare('SELECT event_id FROM calendar_events ORDER BY event_id').all() as { event_id: string }[]).map((r) => r.event_id)
const calls = (g: GoogleMock): GoogleMock['requests'] => g.requests.filter((r) => r.path.startsWith('/calendar/'))

test('full sync pages through everything and saves the sync token and account name', async () => {
  const { g, db, deps } = await setup()
  try {
    g.pageSize = 2
    for (let i = 1; i <= 5; i++) g.put(at(`e${i}`, `2026-11-1${i}T04:30:00Z`))
    const r = await syncCalendar(deps)
    assert.deepEqual({ full: r.full, upserted: r.upserted, pages: r.pages, summary: r.summary }, { full: true, upserted: 5, pages: 3, summary: 'owner@example.com' })
    assert.deepEqual(ids(db), ['e1', 'e2', 'e3', 'e4', 'e5'])
    assert.ok(syncTokenOf(db, 'primary'))
    assert.ok(calls(g).every((c) => c.query.singleEvents === 'true' && !('timeMin' in c.query)))
  } finally {
    await g.close()
  }
})

test('incremental sync applies only changes, deletions and cancelled instances included', async () => {
  const { g, db, deps } = await setup()
  try {
    g.put(at('keep', '2026-11-18T04:30:00Z'))
    g.put(at('edit', '2026-11-18T05:30:00Z'))
    g.put(at('gone', '2026-11-18T06:30:00Z'))
    g.put(at('series_1', '2026-11-18T07:30:00Z', { recurringEventId: 'series' }))
    await syncCalendar(deps)
    g.put(at('edit', '2026-11-18T08:30:00Z', { summary: 'edited' }))
    g.put(at('new', '2026-11-19T04:30:00Z'))
    g.cancel('gone')
    g.cancel('series_1')
    const r = await syncCalendar(deps)
    assert.deepEqual({ full: r.full, upserted: r.upserted, deleted: r.deleted }, { full: false, upserted: 2, deleted: 2 })
    assert.ok(calls(g).at(-1)!.query.syncToken, 'used the saved token')
    assert.deepEqual(ids(db), ['edit', 'keep', 'new'])
    assert.equal((db.prepare("SELECT summary FROM calendar_events WHERE event_id='edit'").get() as { summary: string }).summary, 'edited')
    const again = await syncCalendar(deps)
    assert.deepEqual({ upserted: again.upserted, deleted: again.deleted }, { upserted: 0, deleted: 0 }, 'nothing new, nothing written')
  } finally {
    await g.close()
  }
})

test('410 Gone: the cache is wiped and rebuilt by a full sync', async () => {
  const { g, db, deps } = await setup()
  try {
    g.put(at('a', '2026-11-18T04:30:00Z'))
    g.put(at('b', '2026-11-18T05:30:00Z'))
    await syncCalendar(deps)
    g.expireSyncTokens()
    g.cancel('b')
    g.put(at('c', '2026-11-18T06:30:00Z'))
    const r = await syncCalendar(deps)
    assert.equal(r.full, true)
    assert.deepEqual(ids(db), ['a', 'c'])
    const last = calls(g).slice(-2)
    assert.ok(last[0].query.syncToken && !last[1].query.syncToken, 'stale token, then a fresh full list')
  } finally {
    await g.close()
  }
})

test('a 410 whose resync then fails keeps every saved event (regression)', async () => {
  // Seen in the app: 410, cache wiped, the full resync then got 401 and the
  // user was left with nothing. The cache must survive until a resync completes.
  const { g, db, deps } = await setup()
  try {
    for (const id of ['a', 'b', 'c']) g.put(at(id, '2026-11-18T04:30:00Z'))
    await syncCalendar(deps)
    g.expireSyncTokens()
    const realFetch = deps.fetch
    let n = 0
    // The 410 arrives, then the full list fails (offline, a revoked grant, a 5xx).
    await assert.rejects(syncCalendar({ ...deps, fetch: (u, i) => (++n === 2 ? Promise.reject(new Error('offline')) : realFetch(u, i)) }))
    assert.deepEqual(ids(db), ['a', 'b', 'c'], 'saved events kept')
    assert.equal(syncTokenOf(db, 'primary'), null, 'the stale token is gone, so the next sync lists in full')
    g.cancel('b')
    const r = await syncCalendar(deps)
    assert.equal(r.full, true)
    assert.deepEqual(ids(db), ['a', 'c'], 'and the completed full list still removes what is gone')
  } finally {
    await g.close()
  }
})

test('an expired access token is refreshed once; a revoked grant surfaces as such', async () => {
  const { g, db, deps } = await setup()
  try {
    g.put(at('a', '2026-11-18T04:30:00Z'))
    g.expireAccessTokens()
    await syncCalendar(deps)
    assert.deepEqual(ids(db), ['a'])
    g.revokeAll()
    await assert.rejects(syncCalendar(deps), (e: OAuthError) => e instanceof OAuthError && e.code === 'invalid_grant')
    assert.deepEqual(ids(db), ['a'], 'the cache stays usable offline')
  } finally {
    await g.close()
  }
})

test('offline and server errors leave the cache as it was', async () => {
  const { g, db, deps } = await setup()
  try {
    g.put(at('a', '2026-11-18T04:30:00Z'))
    await syncCalendar(deps)
    g.failNext(503)
    await assert.rejects(syncCalendar(deps), (e: SyncError) => e.kind === 'http' && e.status === 503)
    await assert.rejects(syncCalendar({ ...deps, apiBase: 'http://127.0.0.1:9/calendar/v3' }), (e: SyncError) => e.kind === 'offline')
    assert.deepEqual(ids(db), ['a'])
    assert.ok(syncTokenOf(db, 'primary'), 'the token survives a failed attempt')
  } finally {
    await g.close()
  }
})

test('a full sync cut short and restarted does not keep events deleted in between', async () => {
  const { g, db, deps } = await setup()
  try {
    g.pageSize = 2
    for (const id of ['a', 'b', 'c', 'd']) g.put(at(id, '2026-11-18T04:30:00Z'))
    g.failNext(500) // first attempt: the very first page fails, nothing is written
    await assert.rejects(syncCalendar(deps))
    assert.deepEqual(ids(db), [])
    // Second attempt: page 1 lands, page 2 fails.
    const realFetch = deps.fetch
    let n = 0
    await assert.rejects(syncCalendar({ ...deps, fetch: (u, i) => (++n === 2 ? Promise.reject(new Error('cable pulled')) : realFetch(u, i)) }))
    assert.deepEqual(ids(db), ['a', 'b'], 'page 1 applied, no token saved')
    assert.equal(syncTokenOf(db, 'primary'), null)
    g.cancel('a') // deleted while we were offline; a full list will not mention it
    await syncCalendar(deps)
    assert.deepEqual(ids(db), ['b', 'c', 'd'])
  } finally {
    await g.close()
  }
})
