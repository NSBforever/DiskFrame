import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Google OAuth 2.0 for an installed app (checked against Google's docs on
 * 2026-11-18): the system browser, a loopback redirect on 127.0.0.1, PKCE S256
 * and a random state. Custom URI schemes and copy/paste (OOB) are no longer
 * accepted by Google. A desktop client "cannot keep secrets confidential", so
 * the optional client secret is sent when the build has one and is not
 * treated as one.
 *
 * Main process only: nothing here, and no token, ever crosses into the
 * renderer. Network access and opening the browser are injected so the whole
 * flow runs against a local mock in tests.
 */

/** Read-only events on calendars the user owns (the primary one included).
 *  The narrowest scope that can read them (design decision D3). */
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned.readonly'

export interface GoogleConfig {
  clientId: string
  clientSecret: string | null
  authUrl: string
  tokenUrl: string
  revokeUrl: string
  apiBase: string
  /** Endpoints are the local test mock (DF_GOOGLE_API_BASE). */
  isMock: boolean
}

declare const __DF_GOOGLE_CLIENT_ID__: string | undefined
declare const __DF_GOOGLE_CLIENT_SECRET__: string | undefined

/**
 * The OAuth client baked into this build (DF_GOOGLE_CLIENT_ID at build time),
 * or null: a build without one shows Calendar as unavailable instead of
 * failing. DF_GOOGLE_* in the environment override it for development, and
 * DF_GOOGLE_API_BASE points every endpoint at a local mock - only a loopback
 * http URL is accepted, so no environment variable can send a token anywhere
 * but Google or this machine.
 */
export function googleConfig(env: NodeJS.ProcessEnv = process.env): GoogleConfig | null {
  const baked = typeof __DF_GOOGLE_CLIENT_ID__ === 'string' ? __DF_GOOGLE_CLIENT_ID__ : ''
  const bakedSecret = typeof __DF_GOOGLE_CLIENT_SECRET__ === 'string' ? __DF_GOOGLE_CLIENT_SECRET__ : ''
  const clientId = env.DF_GOOGLE_CLIENT_ID || baked
  if (!clientId) return null
  const clientSecret = env.DF_GOOGLE_CLIENT_SECRET || bakedSecret || null
  const mock = env.DF_GOOGLE_API_BASE
  if (mock && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(mock)) {
    return { clientId, clientSecret, authUrl: `${mock}/o/oauth2/v2/auth`, tokenUrl: `${mock}/token`, revokeUrl: `${mock}/revoke`, apiBase: `${mock}/calendar/v3`, isMock: true }
  }
  return {
    clientId,
    clientSecret,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    apiBase: 'https://www.googleapis.com/calendar/v3',
    isMock: false
  }
}

export type OAuthFailure = 'denied' | 'timeout' | 'invalid_grant' | 'network' | 'http' | 'state'

export class OAuthError extends Error {
  readonly code: OAuthFailure
  constructor(code: OAuthFailure, message: string) {
    super(message)
    this.code = code
  }
}

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

export interface Tokens {
  accessToken: string
  /** Absent on a refresh, which keeps the existing refresh token. */
  refreshToken: string | null
  expiresAt: number
  scope: string
}

const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

async function tokenRequest(cfg: GoogleConfig, fetch: Fetch, form: Record<string, string>, now: number): Promise<Tokens> {
  const body = new URLSearchParams({ client_id: cfg.clientId, ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}), ...form })
  let res: Awaited<ReturnType<Fetch>>
  try {
    res = await fetch(cfg.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() })
  } catch {
    throw new OAuthError('network', 'Could not reach Google')
  }
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    // invalid_grant: the refresh token was revoked, expired (7 days for an app
    // still in Testing), or the user changed something on their account.
    if (j.error === 'invalid_grant') throw new OAuthError('invalid_grant', 'Google no longer accepts this sign-in')
    throw new OAuthError('http', `Google sign-in failed (${res.status})`)
  }
  if (typeof j.access_token !== 'string') throw new OAuthError('http', 'Google sent no access token')
  return {
    accessToken: j.access_token,
    refreshToken: typeof j.refresh_token === 'string' ? j.refresh_token : null,
    expiresAt: now + (typeof j.expires_in === 'number' ? j.expires_in : 3600) * 1000,
    scope: typeof j.scope === 'string' ? j.scope : ''
  }
}

const DONE_PAGE = (ok: boolean): string =>
  `<!doctype html><meta charset="utf-8"><title>DiskFrame</title><body style="font:15px system-ui;background:#0c0c0f;color:#f2f2f0;display:grid;place-items:center;height:90vh;margin:0"><p>${
    ok ? 'DiskFrame is connected to Google Calendar. You can close this tab.' : 'Google Calendar was not connected. You can close this tab and try again from DiskFrame.'
  }</p>`

/**
 * The whole sign-in: one-shot loopback listener, browser, code for tokens.
 * Resolves with tokens including a refresh token, or rejects with OAuthError.
 */
export async function authorize(
  cfg: GoogleConfig,
  deps: { fetch: Fetch; openUrl: (url: string) => void | Promise<void>; timeoutMs?: number; now?: () => number }
): Promise<Tokens> {
  const { verifier, challenge } = pkcePair()
  const state = b64url(randomBytes(24))
  let finish: (r: { code?: string; error?: OAuthError }) => void = () => {}
  const result = new Promise<{ code?: string; error?: OAuthError }>((r) => (finish = r))
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (u.pathname !== '/oauth2/callback') {
      res.writeHead(404).end()
      return
    }
    // A request without our state is not Google answering us - ignore it and
    // keep waiting rather than let any local page end the sign-in.
    if (u.searchParams.get('state') !== state) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Unexpected request')
      return
    }
    const code = u.searchParams.get('code')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(DONE_PAGE(!!code))
    finish(code ? { code } : { error: new OAuthError('denied', u.searchParams.get('error') === 'access_denied' ? 'Access was not granted' : 'Google did not complete sign-in') })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth2/callback`
  const timer = setTimeout(() => finish({ error: new OAuthError('timeout', 'Sign-in timed out') }), deps.timeoutMs ?? 5 * 60_000)
  try {
    const url = new URL(cfg.authUrl)
    url.search = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: CALENDAR_SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent'
    }).toString()
    await deps.openUrl(url.toString())
    const r = await result
    if (r.error) throw r.error
    const tokens = await tokenRequest(
      cfg,
      deps.fetch,
      { grant_type: 'authorization_code', code: r.code!, code_verifier: verifier, redirect_uri: redirectUri },
      (deps.now ?? Date.now)()
    )
    if (!tokens.refreshToken) throw new OAuthError('http', 'Google sent no refresh token')
    return tokens
  } finally {
    clearTimeout(timer)
    server.close()
  }
}

export function refreshAccess(cfg: GoogleConfig, fetch: Fetch, refreshToken: string, now = Date.now()): Promise<Tokens> {
  return tokenRequest(cfg, fetch, { grant_type: 'refresh_token', refresh_token: refreshToken }, now)
}

/** Best effort: revoking the refresh token revokes its access tokens too. */
export async function revokeToken(cfg: GoogleConfig, fetch: Fetch, token: string): Promise<boolean> {
  try {
    const res = await fetch(cfg.revokeUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() })
    return res.ok
  } catch {
    return false
  }
}
