import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { GoogleEvent } from './eventNormalize.ts'

/**
 * A local stand-in for Google's OAuth and Calendar endpoints, for tests and for
 * driving the real app (DF_GOOGLE_API_BASE). It enforces what the real service
 * does where DiskFrame depends on it: the PKCE verifier must match the
 * challenge, the scope must be the read-only one, access tokens expire and can
 * be revoked, sync tokens return only changes (deletions included) and can go
 * stale (410), and results are paged. Never bundled into the app.
 */
export interface GoogleMock {
  base: string
  /** Replaces or adds an event (bumps the change version). */
  put(e: GoogleEvent): void
  /** Marks an event cancelled, as Google reports deletions to a sync. */
  cancel(id: string): void
  /** Every sync token issued so far now answers 410 Gone. */
  expireSyncTokens(): void
  /** Every access token now answers 401 (as if an hour passed). */
  expireAccessTokens(): void
  /** Revoke at Google's side: refresh tokens answer invalid_grant. */
  revokeAll(): void
  /** The next n calendar requests fail with this status. */
  failNext(status: number, n?: number): void
  pageSize: number
  calendarSummary: string
  requests: { path: string; query: Record<string, string> }[]
  revoked: string[]
  close(): Promise<void>
}

export const MOCK_REQUIRED_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned.readonly'

export async function startGoogleMock(opts: { deny?: boolean } = {}): Promise<GoogleMock> {
  let version = 0
  const events = new Map<string, { v: number; e: GoogleEvent }>()
  const codes = new Map<string, { challenge: string; redirect: string }>()
  const refreshTokens = new Set<string>()
  const accessTokens = new Set<string>()
  // Sync tokens are "v<version>e<epoch>"; expiring bumps the epoch, so only
  // tokens issued before it go stale - like Google, fresh ones keep working.
  let epoch = 0
  let fail: { status: number; n: number } | null = null
  let n = 0
  const id = (p: string): string => `${p}-${++n}-${Math.random().toString(36).slice(2, 8)}`
  const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  const mock: GoogleMock = {
    base: '',
    put(e) {
      events.set(e.id!, { v: ++version, e: { status: 'confirmed', ...e } })
    },
    cancel(eid) {
      const cur = events.get(eid)
      events.set(eid, { v: ++version, e: { ...(cur?.e ?? {}), id: eid, status: 'cancelled' } })
    },
    expireSyncTokens() {
      epoch++
    },
    expireAccessTokens() {
      accessTokens.clear()
    },
    revokeAll() {
      refreshTokens.clear()
      accessTokens.clear()
    },
    failNext(status, count = 1) {
      fail = { status, n: count }
    },
    pageSize: 250,
    calendarSummary: 'owner@example.com',
    requests: [],
    revoked: [],
    close: () => new Promise((r) => server.close(() => r()))
  }

  const readBody = (req: import('node:http').IncomingMessage): Promise<URLSearchParams> =>
    new Promise((r) => {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => r(new URLSearchParams(b)))
    })
  const json = (res: import('node:http').ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  }
  const issue = (): { access_token: string; expires_in: number; scope: string; token_type: string } => {
    const t = id('at')
    accessTokens.add(t)
    return { access_token: t, expires_in: 3600, scope: MOCK_REQUIRED_SCOPE, token_type: 'Bearer' }
  }

  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    const q = Object.fromEntries(u.searchParams)
    mock.requests.push({ path: u.pathname, query: q })
    if (u.pathname === '/o/oauth2/v2/auth') {
      const ok = q.scope === MOCK_REQUIRED_SCOPE && q.code_challenge_method === 'S256' && q.response_type === 'code' && q.access_type === 'offline' && !!q.state && !!q.code_challenge
      const back = new URL(q.redirect_uri)
      if (!ok || opts.deny) {
        back.search = new URLSearchParams({ error: ok ? 'access_denied' : 'invalid_request', state: q.state ?? '' }).toString()
      } else {
        const code = id('code')
        codes.set(code, { challenge: q.code_challenge, redirect: q.redirect_uri })
        back.search = new URLSearchParams({ code, state: q.state }).toString()
      }
      res.writeHead(302, { Location: back.toString() }).end()
      return
    }
    if (u.pathname === '/token' && req.method === 'POST') {
      const f = await readBody(req)
      if (f.get('grant_type') === 'authorization_code') {
        const c = codes.get(f.get('code') ?? '')
        codes.delete(f.get('code') ?? '')
        const verified = c && c.redirect === f.get('redirect_uri') && b64url(createHash('sha256').update(f.get('code_verifier') ?? '').digest()) === c.challenge
        if (!verified) return json(res, 400, { error: 'invalid_grant' })
        const rt = id('rt')
        refreshTokens.add(rt)
        return json(res, 200, { ...issue(), refresh_token: rt })
      }
      if (f.get('grant_type') === 'refresh_token') {
        if (!refreshTokens.has(f.get('refresh_token') ?? '')) return json(res, 400, { error: 'invalid_grant' })
        return json(res, 200, issue())
      }
      return json(res, 400, { error: 'unsupported_grant_type' })
    }
    if (u.pathname === '/revoke' && req.method === 'POST') {
      const f = await readBody(req)
      const t = f.get('token') ?? ''
      mock.revoked.push(t)
      refreshTokens.delete(t)
      accessTokens.clear()
      return json(res, 200, {})
    }
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(u.pathname)
    if (m) {
      const auth = (req.headers.authorization ?? '').replace(/^Bearer /, '')
      if (!accessTokens.has(auth)) return json(res, 401, { error: { code: 401, message: 'Invalid Credentials' } })
      if (fail && fail.n-- > 0) {
        const s = fail.status
        if (fail.n <= 0) fail = null
        return json(res, s, { error: { code: s } })
      }
      if (q.singleEvents !== 'true') return json(res, 400, { error: { message: 'mock expects singleEvents=true' } })
      // A page token is "<since>:<offset>:<head>".
      let since = 0
      if (q.syncToken) {
        const t = /^v(\d+)e(\d+)$/.exec(q.syncToken)
        if (!t || Number(t[2]) !== epoch) return json(res, 410, { error: { code: 410, message: 'Sync token is no longer valid' } })
        since = Number(t[1])
      }
      let offset = 0
      let head = version
      if (q.pageToken) [since, offset, head] = q.pageToken.split(':').map(Number)
      const changed = [...events.values()]
        .filter((x) => x.v > since && x.v <= head && (since > 0 || x.e.status !== 'cancelled'))
        .sort((a, b) => a.v - b.v)
      const size = Math.min(mock.pageSize, Number(q.maxResults ?? 250))
      const page = changed.slice(offset, offset + size)
      const more = offset + size < changed.length
      return json(res, 200, {
        kind: 'calendar#events',
        summary: mock.calendarSummary,
        timeZone: 'Asia/Kolkata',
        items: page.map((x) => x.e),
        ...(more ? { nextPageToken: `${since}:${offset + size}:${head}` } : { nextSyncToken: `v${head}e${epoch}` })
      })
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  mock.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return mock
}
