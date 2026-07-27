import { describe, it, expect } from 'vitest'
import { VivideoClient } from './client.js'
import { VivideoError } from './errors.js'

interface Recorded { url: string; method: string; headers: Record<string, string>; body?: string }

/** Build a mock fetch that replays a queue of [status, body] and records requests. */
function mockFetch(queue: Array<[number, unknown, Record<string, string>?]>) {
  const calls: Recorded[] = []
  const fn = (async (url: URL | string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body as string | undefined,
    })
    const [status, body, headers] = queue.shift() ?? [500, { error: { code: 'internal_error', message: 'no more', retryable: true, request_id: '' } }]
    return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: headers ?? {} })
  }) as unknown as typeof fetch
  return { fn, calls }
}

const fast = { apiKey: 'vv_live_test_key_1234567890', requestsPerSecond: 1000, burst: 1000, maxConcurrent: 50 }

describe('VivideoClient request layer', () => {
  it('sends the bearer key and parses JSON', async () => {
    const { fn, calls } = mockFetch([[200, { object: 'account', plan: 'pro', premium: true, credits: 100, free_video_available: false, first_video_comp_used: false, links: {} }]])
    const c = new VivideoClient({ ...fast, fetchImpl: fn })
    const me = await c.me()
    expect(me.plan).toBe('pro')
    expect(calls[0].headers.Authorization).toBe('Bearer vv_live_test_key_1234567890')
    expect(calls[0].url).toContain('/v1/me')
  })

  it('createVideo sends an Idempotency-Key and REUSES it across a retry', async () => {
    const { fn, calls } = mockFetch([
      [429, { error: { code: 'rate_limited', message: 'slow down', retryable: true, request_id: 'req_1', retry_after_seconds: 0 } }],
      [201, { id: 'v1', object: 'video', mode: 'manual', status: 'processing', credits_charged: 8 }],
    ])
    const c = new VivideoClient({ ...fast, fetchImpl: fn, maxRetries: 2 })
    const v = await c.createVideo({ mode: 'manual', model: 'veo31_fast', prompt: 'x' })
    expect(v.id).toBe('v1')
    expect(calls.length).toBe(2) // retried once
    const k0 = calls[0].headers['Idempotency-Key']
    const k1 = calls[1].headers['Idempotency-Key']
    expect(k0).toBeTruthy()
    expect(k1).toBe(k0) // same key on retry → no duplicate charge
  })

  it('honors a non-retryable 402 without retrying and maps it', async () => {
    const { fn, calls } = mockFetch([
      [402, { error: { code: 'insufficient_credits', message: 'need more', retryable: false, request_id: 'req_x', links: { buy_credits: 'https://app.vivideo.ai/subscription' } } }],
    ])
    const c = new VivideoClient({ ...fast, fetchImpl: fn, maxRetries: 3 })
    await expect(c.createVideo({ mode: 'auto', prompt: 'x' })).rejects.toMatchObject({ kind: 'insufficient_credits' })
    expect(calls.length).toBe(1) // NOT retried
    try {
      await new VivideoClient({ ...fast, fetchImpl: mockFetch([[402, { error: { code: 'insufficient_credits', message: 'need more', retryable: false, request_id: 'r', links: { buy_credits: 'https://x' } } }]]).fn }).me()
    } catch (e) {
      expect((e as VivideoError).links?.buy_credits).toBe('https://x')
    }
  })

  it('retries retryable 5xx up to maxRetries then throws', async () => {
    const { fn, calls } = mockFetch([
      [503, { error: { code: 'upstream_error', message: 'down', retryable: true, request_id: 'r' } }],
      [503, { error: { code: 'upstream_error', message: 'down', retryable: true, request_id: 'r' } }],
      [503, { error: { code: 'upstream_error', message: 'down', retryable: true, request_id: 'r' } }],
    ])
    const c = new VivideoClient({ ...fast, fetchImpl: fn, maxRetries: 1 })
    await expect(c.me()).rejects.toMatchObject({ kind: 'server' })
    expect(calls.length).toBe(2) // 1 initial + 1 retry
  })

  it('retries a network error then succeeds', async () => {
    let n = 0
    const fn = (async () => {
      n += 1
      if (n === 1) throw new Error('ECONNRESET vv_live_should_be_redacted')
      return new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 })
    }) as unknown as typeof fetch
    const c = new VivideoClient({ ...fast, fetchImpl: fn, maxRetries: 2 })
    const res = await c.listModels()
    expect(res.data).toEqual([])
    expect(n).toBe(2)
  })
})
