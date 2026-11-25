import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VivideoV3Client } from './v3.js'
import { waitForStatus, waitForSignup, MIN_STATUS_POLL_MS, SIGNUP_TERMINAL } from './v3poll.js'
import { VivideoError } from './errors.js'
import { redact, redactDeep } from './redact.js'
import { savePendingClaim, getPendingClaim, removePendingClaim, claimsPath, resolveV3BaseUrl, DEFAULT_V3_BASE_URL } from './config.js'

interface Recorded { url: string; method: string; headers: Record<string, string>; body?: string }

function mockFetch(queue: Array<[number, unknown, Record<string, string>?]>) {
  const calls: Recorded[] = []
  const fn = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers: (init?.headers as Record<string, string>) ?? {}, body: init?.body as string | undefined })
    const [status, body, headers] = queue.shift() ?? [500, { error: 'internal_error', message: 'no more' }]
    return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: headers ?? {} })
  }) as unknown as typeof fetch
  return { fn, calls }
}

const fast = { baseUrl: 'https://v3.test', requestsPerSecond: 1000, burst: 1000, maxConcurrent: 50 }
const KEY = 'vv_live_v3test_key_1234567890'

// Never touch the real ~/.vivideo: point HOME at a temp dir for this file.
const saved = { home: process.env.HOME, key: process.env.VIVIDEO_API_KEY, base: process.env.VIVIDEO_V3_BASE_URL }
beforeAll(() => { process.env.HOME = mkdtempSync(join(tmpdir(), 'vivideo-v3-')); delete process.env.VIVIDEO_API_KEY })
afterAll(() => {
  process.env.HOME = saved.home
  if (saved.key) process.env.VIVIDEO_API_KEY = saved.key
  if (saved.base) process.env.VIVIDEO_V3_BASE_URL = saved.base
  else delete process.env.VIVIDEO_V3_BASE_URL
})

describe('V3 base URL', () => {
  it('defaults to v3.api.vivideo.ai, env and explicit override it', () => {
    delete process.env.VIVIDEO_V3_BASE_URL
    expect(resolveV3BaseUrl()).toBe(DEFAULT_V3_BASE_URL)
    expect(DEFAULT_V3_BASE_URL).toBe('https://v3.api.vivideo.ai')
    process.env.VIVIDEO_V3_BASE_URL = 'https://stg.example/'
    expect(resolveV3BaseUrl()).toBe('https://stg.example')
    expect(resolveV3BaseUrl('https://x.example')).toBe('https://x.example')
    expect(new VivideoV3Client().baseUrl).toBe('https://stg.example')
    delete process.env.VIVIDEO_V3_BASE_URL
  })
})

describe('VivideoV3Client public routes (no key)', () => {
  it('agentStart posts the body without any Authorization header', async () => {
    const { fn, calls } = mockFetch([[201, { checkout_id: 'co_1', checkout_url: 'https://checkout.stripe.com/c/pay/cs_1', claim_token: 'ct_secret_abc', expires_at: 1, status_url: '/v3/agent-start/co_1' }]])
    const c = new VivideoV3Client({ ...fast, fetchImpl: fn })
    const r = await c.agentStart({ email: 'a@b.co', plan: 'pro', period: 'weekly' })
    expect(r.checkout_id).toBe('co_1')
    expect(calls[0].url).toBe('https://v3.test/v3/agent-start')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].headers.Authorization).toBeUndefined()
    expect(JSON.parse(calls[0].body!)).toEqual({ email: 'a@b.co', plan: 'pro', period: 'weekly' }) // no key_name: undefined
  })

  it('409 account_exists → conflict error with next preserved, not retried', async () => {
    const { fn, calls } = mockFetch([[409, { error: 'account_exists', message: 'exists', request_id: 'r1', next: { signup: { method: 'POST', url: '/v3/agent-signup' } } }]])
    const c = new VivideoV3Client({ ...fast, fetchImpl: fn, maxRetries: 3 })
    const e = await c.agentStart({ email: 'a@b.co', plan: 'max', period: 'yearly' }).catch((x) => x)
    expect(e).toBeInstanceOf(VivideoError)
    expect(e.code).toBe('account_exists')
    expect(e.kind).toBe('conflict')
    expect(e.requestId).toBe('r1')
    expect(e.next.signup.url).toBe('/v3/agent-signup')
    expect(e.toJSON().error.next.signup.url).toBe('/v3/agent-signup')
    expect(calls.length).toBe(1)
  })

  it('agentStartStatus sends X-Claim-Token and no Authorization', async () => {
    const { fn, calls } = mockFetch([[200, { status: 'pending' }]])
    const c = new VivideoV3Client({ ...fast, apiKey: KEY, fetchImpl: fn })
    await c.agentStartStatus('co/1', 'ct_secret_abc')
    expect(calls[0].url).toBe('https://v3.test/v3/agent-start/co%2F1')
    expect(calls[0].headers['X-Claim-Token']).toBe('ct_secret_abc')
    expect(calls[0].headers.Authorization).toBeUndefined()
  })

  it('code flow: requestLoginCode then verifyLoginCode', async () => {
    const { fn, calls } = mockFetch([
      [202, { status: 'code_sent', expires_in: 600 }],
      [201, { api_key: KEY, key_id: 'k1', account: { plan: 'pro', credits: 10, free_video_available: false } }],
    ])
    const c = new VivideoV3Client({ ...fast, fetchImpl: fn })
    expect((await c.requestLoginCode('a@b.co')).status).toBe('code_sent')
    const v = await c.verifyLoginCode({ email: 'a@b.co', code: '123456' })
    expect(v.key_id).toBe('k1')
    expect(calls[0].url).toBe('https://v3.test/v3/agent-signup')
    expect(calls[1].url).toBe('https://v3.test/v3/agent-signup/verify')
    expect(JSON.parse(calls[1].body!)).toEqual({ email: 'a@b.co', code: '123456' })
  })
})

describe('VivideoV3Client retry rules', () => {
  it('a non-idempotent POST is NOT retried on 5xx (no duplicate code / key / session)', async () => {
    const { fn, calls } = mockFetch([[503, { error: 'unavailable', message: 'x' }, { 'Retry-After': '0' }], [202, { status: 'code_sent' }]])
    const c = new VivideoV3Client({ ...fast, fetchImpl: fn, maxRetries: 3 })
    await expect(c.requestLoginCode('a@b.co')).rejects.toMatchObject({ kind: 'server', retryable: true })
    expect(calls.length).toBe(1)
  })

  it('a POST is retried on a short 429 (refused before any work)', async () => {
    const { fn, calls } = mockFetch([[429, { error: 'rate_limited', message: 'x' }, { 'Retry-After': '0' }], [202, { status: 'code_sent' }]])
    const c = new VivideoV3Client({ ...fast, fetchImpl: fn, maxRetries: 2 })
    expect((await c.requestLoginCode('a@b.co')).status).toBe('code_sent')
    expect(calls.length).toBe(2)
  })

  it('a long Retry-After is returned to the caller, not slept on', async () => {
    const { fn, calls } = mockFetch([[429, { error: 'rate_limited', message: 'x' }, { 'Retry-After': '3600' }]])
    const c = new VivideoV3Client({ ...fast, fetchImpl: fn, maxRetries: 3 })
    await expect(c.agentStart({ email: 'a@b.co', plan: 'pro', period: 'weekly' })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 3600 })
    expect(calls.length).toBe(1)
  })

  it('a GET is retried on 503, bounded', async () => {
    const { fn, calls } = mockFetch([
      [503, { error: 'unavailable', message: 'x' }, { 'Retry-After': '0' }],
      [503, { error: 'unavailable', message: 'x' }, { 'Retry-After': '0' }],
      [503, { error: 'unavailable', message: 'x' }, { 'Retry-After': '0' }],
    ])
    const c = new VivideoV3Client({ ...fast, fetchImpl: fn, maxRetries: 1 })
    await expect(c.agentStartStatus('co_1', 't')).rejects.toMatchObject({ kind: 'server' })
    expect(calls.length).toBe(2)
  })

  it('agent_access_disabled is never retried', async () => {
    const { fn, calls } = mockFetch([[503, { error: 'agent_access_disabled', message: 'off' }]])
    const c = new VivideoV3Client({ ...fast, fetchImpl: fn, maxRetries: 3 })
    await expect(c.agentStartStatus('co_1', 't')).rejects.toMatchObject({ code: 'agent_access_disabled', retryable: false })
    expect(calls.length).toBe(1)
  })

  it('agentCheckout sends Bearer + Idempotency-Key and reuses the key on a retry', async () => {
    const { fn, calls } = mockFetch([
      [503, { error: 'unavailable', message: 'x' }, { 'Retry-After': '0' }],
      [201, { checkout_id: 'ck_1', checkout_url: 'https://checkout.stripe.com/x', status_url: '/v3/checkout/ck_1', expires_at: 1, mode: 'credits', value_usd: 20 }],
    ])
    const c = new VivideoV3Client({ ...fast, apiKey: KEY, fetchImpl: fn, maxRetries: 2 })
    const r = await c.agentCheckout({ mode: 'credits', credits: 100 })
    expect(r.checkout_id).toBe('ck_1')
    expect(calls.length).toBe(2)
    expect(calls[0].headers.Authorization).toBe(`Bearer ${KEY}`)
    expect(calls[0].headers['Idempotency-Key']).toBeTruthy()
    expect(calls[1].headers['Idempotency-Key']).toBe(calls[0].headers['Idempotency-Key'])
    expect(JSON.parse(calls[0].body!)).toEqual({ mode: 'credits', credits: 100 })
  })

  it('checkout routes without a key fail with a config error before any request', async () => {
    const { fn, calls } = mockFetch([])
    const c = new VivideoV3Client({ ...fast, fetchImpl: fn })
    expect(c.hasApiKey()).toBe(false)
    await expect(c.checkoutStatus('ck_1')).rejects.toMatchObject({ kind: 'config' })
    expect(calls.length).toBe(0)
  })

  it('maps V3 codes to kinds', () => {
    expect(VivideoError.fromV3(403, { error: 'not_allowed', message: 'x' }).kind).toBe('forbidden')
    expect(VivideoError.fromV3(402, { error: 'plan_required', message: 'x' }).kind).toBe('upgrade_required')
    expect(VivideoError.fromV3(400, { error: 'invalid_code', message: 'x' }).kind).toBe('invalid_request')
    expect(VivideoError.fromV3(429, { error: 'too_many_attempts', message: 'x' }).kind).toBe('rate_limited')
    expect(VivideoError.fromV3(404, { error: 'not_found', message: 'x' }).kind).toBe('not_found')
    expect(VivideoError.fromV3(401, { error: 'unauthorized', message: 'x' }).kind).toBe('auth')
  })
})

describe('waitForStatus (safe waiter)', () => {
  function fakeClock() {
    let t = 0
    const sleeps: number[] = []
    return { sleeps, clock: { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms } } }
  }

  it('never polls faster than 10 s, even when asked to', async () => {
    const { sleeps, clock } = fakeClock()
    const seq = ['pending', 'pending', 'ready']
    const r = await waitForStatus(async () => ({ status: seq.shift()! }), SIGNUP_TERMINAL, { intervalMs: 1, timeoutMs: 600_000, clock })
    expect(r.result.status).toBe('ready')
    expect(r.timedOut).toBe(false)
    expect(r.polls).toBe(3)
    expect(sleeps).toEqual([MIN_STATUS_POLL_MS, MIN_STATUS_POLL_MS])
  })

  it('stops at the hard timeout and returns the last status (no throw)', async () => {
    const { sleeps, clock } = fakeClock()
    const r = await waitForStatus(async () => ({ status: 'pending' }), SIGNUP_TERMINAL, { timeoutMs: 60_000, clock })
    expect(r.timedOut).toBe(true)
    expect(r.result.status).toBe('pending')
    expect(r.polls).toBe(7) // t=0,10..60 s
    expect(sleeps.every((s) => s >= MIN_STATUS_POLL_MS)).toBe(true)
  })

  it('timeout 0 is a single check; a NaN timeout falls back to the default instead of looping', async () => {
    const { clock } = fakeClock()
    const once = await waitForStatus(async () => ({ status: 'pending' }), SIGNUP_TERMINAL, { timeoutMs: 0, clock })
    expect(once.polls).toBe(1)
    const c2 = fakeClock()
    const r = await waitForStatus(async () => ({ status: 'pending' }), SIGNUP_TERMINAL, { timeoutMs: NaN, clock: c2.clock })
    expect(r.timedOut).toBe(true)
    expect(r.polls).toBe(91) // 15 min default at 10 s
  })

  it('waits out a 429 (Retry-After) and continues; a non-transient error is thrown', async () => {
    const { sleeps, clock } = fakeClock()
    let n = 0
    const r = await waitForStatus(async () => {
      n += 1
      if (n === 1) throw VivideoError.fromV3(429, { error: 'rate_limited', message: 'x' }, '30')
      return { status: 'paid' }
    }, new Set(['paid']), { timeoutMs: 600_000, clock })
    expect(r.result.status).toBe('paid')
    expect(sleeps).toEqual([30_000])
    await expect(waitForStatus(async () => { throw VivideoError.fromV3(404, { error: 'not_found', message: 'x' }) }, new Set(['paid']), { clock })).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('waitForSignup sends the claim token on every poll', async () => {
    const { fn, calls } = mockFetch([[200, { status: 'pending' }], [200, { status: 'ready', api_key: KEY, key_id: 'k1', account: { plan: 'pro', credits: 1 } }]])
    const c = new VivideoV3Client({ ...fast, fetchImpl: fn })
    const { clock } = fakeClock()
    const r = await waitForSignup(c, 'co_1', 'ct_tok', { clock })
    expect(r.result.status).toBe('ready')
    expect(calls.map((x) => x.headers['X-Claim-Token'])).toEqual(['ct_tok', 'ct_tok'])
  })
})

describe('redaction of claim tokens and login codes', () => {
  it('redacts labelled claim tokens and 6-digit codes in strings', () => {
    expect(redact('X-Claim-Token: abcDEF123xyz')).not.toContain('abcDEF123xyz')
    expect(redact('{"claim_token":"ct_abcdef123"}')).not.toContain('ct_abcdef123')
    expect(redact('vivideo signup status co_1 --claim-token ct_abcdef123')).not.toContain('ct_abcdef123')
    expect(redact('vivideo login --email a@b.co --code 123456')).not.toContain('123456')
    expect(redact('{"email":"a@b.co","code":"654321"}')).not.toContain('654321')
    expect(redact('credits 123456 left')).toContain('123456') // unlabelled numbers stay
  })
  it('redactDeep drops claim_token keys and 6-digit codes, keeps error codes', () => {
    const out = redactDeep({ claim_token: 'ct_x', 'X-Claim-Token': 'ct_y', code: '123456', error: { code: 'invalid_code' } }) as Record<string, any>
    expect(out.claim_token).toBe('…redacted')
    expect(out['X-Claim-Token']).toBe('…redacted')
    expect(out.code).toBe('…redacted')
    expect(out.error.code).toBe('invalid_code')
  })
})

describe('pending claim storage', () => {
  it('stores claims owner-only (0600) and removes them', () => {
    const p = savePendingClaim({ checkout_id: 'co_9', claim_token: 'ct_secret_9', email: 'a@b.co', expires_at: 2 })
    expect(p).toBe(claimsPath())
    expect((statSync(p).mode & 0o777).toString(8)).toBe('600')
    expect(getPendingClaim('co_9')?.claim_token).toBe('ct_secret_9')
    removePendingClaim('co_9')
    expect(getPendingClaim('co_9')).toBeUndefined()
    expect(readFileSync(p, 'utf8')).not.toContain('ct_secret_9')
  })
})
