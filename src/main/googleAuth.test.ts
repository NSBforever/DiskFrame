import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { authorize, refreshAccess, revokeToken, googleConfig, OAuthError, CALENDAR_SCOPE, type GoogleConfig } from './googleAuth.ts'
import { credentialStore, type Encryptor } from './credentialStore.ts'
import { startGoogleMock, MOCK_REQUIRED_SCOPE } from './googleMock.ts'

const cfgFor = (base: string): GoogleConfig => googleConfig({ DF_GOOGLE_CLIENT_ID: 'test-client', DF_GOOGLE_API_BASE: base })!
// What a browser does with the consent page: follow Google's redirect back to us.
const browser = async (url: string): Promise<void> => {
  await fetch(url)
}

test('sign-in: PKCE, state and the read-only scope; tokens come back', async () => {
  const g = await startGoogleMock()
  try {
    const t = await authorize(cfgFor(g.base), { fetch, openUrl: browser })
    assert.ok(t.accessToken && t.refreshToken)
    assert.ok(t.expiresAt > Date.now())
    const auth = g.requests.find((r) => r.path === '/o/oauth2/v2/auth')!.query
    assert.equal(auth.scope, CALENDAR_SCOPE)
    assert.equal(CALENDAR_SCOPE, MOCK_REQUIRED_SCOPE)
    assert.ok(!/calendar(\.events)?$|calendar\.events(?!\.owned\.readonly)/.test(auth.scope), 'never a write scope')
    assert.equal(auth.code_challenge_method, 'S256')
    assert.match(auth.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/oauth2\/callback$/)
    assert.ok(auth.state.length >= 24)
  } finally {
    await g.close()
  }
})

test('a request to the listener without our state is ignored, not trusted', async () => {
  const g = await startGoogleMock()
  try {
    const t = await authorize(cfgFor(g.base), {
      fetch,
      openUrl: async (url) => {
        const redirect = new URL(url).searchParams.get('redirect_uri')!
        const forged = await fetch(`${redirect}?code=attacker&state=wrong`)
        assert.equal(forged.status, 400)
        await browser(url)
      }
    })
    assert.ok(t.refreshToken, 'the real answer still completes sign-in')
  } finally {
    await g.close()
  }
})

test('the user saying no, and nobody answering, both end cleanly', async () => {
  const g = await startGoogleMock({ deny: true })
  try {
    await assert.rejects(authorize(cfgFor(g.base), { fetch, openUrl: browser }), (e: OAuthError) => e.code === 'denied')
    let redirect = ''
    await assert.rejects(
      authorize(cfgFor(g.base), { fetch, openUrl: (u) => void (redirect = new URL(u).searchParams.get('redirect_uri')!), timeoutMs: 150 }),
      (e: OAuthError) => e.code === 'timeout'
    )
    await assert.rejects(fetch(redirect), 'the listener is closed afterwards')
  } finally {
    await g.close()
  }
})

test('refresh works until Google revokes; then it is invalid_grant', async () => {
  const g = await startGoogleMock()
  try {
    const cfg = cfgFor(g.base)
    const t = await authorize(cfg, { fetch, openUrl: browser })
    const r = await refreshAccess(cfg, fetch, t.refreshToken!)
    assert.ok(r.accessToken && r.accessToken !== t.accessToken)
    assert.equal(r.refreshToken, null, 'a refresh keeps the existing refresh token')
    assert.equal(await revokeToken(cfg, fetch, t.refreshToken!), true)
    assert.deepEqual(g.revoked, [t.refreshToken])
    await assert.rejects(refreshAccess(cfg, fetch, t.refreshToken!), (e: OAuthError) => e.code === 'invalid_grant')
  } finally {
    await g.close()
  }
})

test('offline: a network failure is reported as such, revoke does not throw', async () => {
  const cfg = cfgFor('http://127.0.0.1:9')
  await assert.rejects(refreshAccess(cfg, fetch, 'rt'), (e: OAuthError) => e.code === 'network')
  assert.equal(await revokeToken(cfg, fetch, 'rt'), false)
})

test('config: no client id means unavailable; the mock override only accepts loopback', () => {
  assert.equal(googleConfig({}), null)
  const real = googleConfig({ DF_GOOGLE_CLIENT_ID: 'x', DF_GOOGLE_API_BASE: 'https://evil.example.com' })!
  assert.equal(real.tokenUrl, 'https://oauth2.googleapis.com/token', 'a non-loopback override is ignored')
  assert.equal(real.clientSecret, null)
  assert.equal(googleConfig({ DF_GOOGLE_CLIENT_ID: 'x', DF_GOOGLE_API_BASE: 'http://127.0.0.1:4000' })!.tokenUrl, 'http://127.0.0.1:4000/token')
})

const fakeEnc = (available = true): Encryptor => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString()
})

test('the refresh token is stored encrypted, and never in plain text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-cred-'))
  try {
    const file = path.join(dir, 'google-calendar.bin')
    const store = credentialStore(file, fakeEnc())
    assert.equal(store.load(), null)
    store.save('1//secret-refresh-token')
    assert.ok(!fs.readFileSync(file).includes('secret-refresh-token'), 'file holds ciphertext')
    assert.equal(store.load(), '1//secret-refresh-token')
    store.clear()
    assert.equal(fs.existsSync(file), false)
    assert.throws(() => credentialStore(file, fakeEnc(false)).save('x'), /cannot encrypt/)
    assert.equal(fs.existsSync(file), false, 'no plain-text fallback')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
