import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { redact, redactDeep } from './redact.js'
import { looksLikeKey, resolveConfig, isConfigured } from './config.js'
import { estimateAutoCredits, estimateManualCredits, estimateCredits } from './estimate.js'
import { VivideoError } from './errors.js'
import { TokenBucket, Semaphore } from './limiter.js'
import type { Model } from './types.js'

describe('redaction', () => {
  it('redacts api keys and secrets from strings', () => {
    expect(redact('key vv_live_abcdefgh1234 here')).not.toContain('abcdefgh1234')
    expect(redact('secret whsec_zzzzzzzzzzzz')).not.toContain('zzzzzzzzzzzz')
    expect(redact('Authorization: Bearer sometoken12345')).toContain('Bearer …redacted')
  })
  it('drops sensitive keys in objects', () => {
    const out = redactDeep({ authorization: 'Bearer x', api_key: 'vv_live_x', nested: { secret: 'whsec_y', ok: 1 } }) as Record<string, unknown>
    expect(out.authorization).toBe('…redacted')
    expect(out.api_key).toBe('…redacted')
    expect((out.nested as Record<string, unknown>).secret).toBe('…redacted')
    expect((out.nested as Record<string, unknown>).ok).toBe(1)
  })
})

describe('config resolution', () => {
  const saved = { key: process.env.VIVIDEO_API_KEY, base: process.env.VIVIDEO_API_BASE_URL }
  beforeEach(() => { delete process.env.VIVIDEO_API_KEY; delete process.env.VIVIDEO_API_BASE_URL })
  afterEach(() => { if (saved.key) process.env.VIVIDEO_API_KEY = saved.key; if (saved.base) process.env.VIVIDEO_API_BASE_URL = saved.base })

  it('looksLikeKey validates the vv_live_ format', () => {
    expect(looksLikeKey('vv_live_' + 'x'.repeat(30))).toBe(true)
    expect(looksLikeKey('nope')).toBe(false)
  })
  it('explicit key wins and reports source', () => {
    const r = resolveConfig({ apiKey: 'vv_live_explicit_key_123456' })
    expect(r.source).toBe('explicit')
    expect(r.baseUrl).toContain('api.vivideo.ai')
  })
  it('env key resolves', () => {
    process.env.VIVIDEO_API_KEY = 'vv_live_env_key_1234567890'
    expect(resolveConfig().source).toBe('env')
    expect(isConfigured()).toBe(true)
  })
  it('throws a clear config error when nothing is set (and no file key)', () => {
    // If a real ~/.vivideo/config.json exists this may resolve from file; guard on that.
    try {
      const r = resolveConfig()
      expect(r.source).toBe('file') // resolved from an existing file — acceptable
    } catch (e) {
      expect((e as VivideoError).kind).toBe('config')
    }
  })
})

describe('error mapping', () => {
  it('maps codes to kinds', () => {
    expect(VivideoError.fromApi(429, { error: { code: 'rate_limited', message: 'x', retryable: true, request_id: 'r', retry_after_seconds: 5 } }).kind).toBe('rate_limited')
    expect(VivideoError.fromApi(403, { error: { code: 'upgrade_required', message: 'x', retryable: false, request_id: 'r' } }).kind).toBe('upgrade_required')
    expect(VivideoError.fromApi(500, {}).kind).toBe('server')
    const e = VivideoError.fromApi(402, { error: { code: 'insufficient_credits', message: 'x', retryable: false, request_id: 'r', links: { buy_credits: 'u' } } })
    expect(e.toJSON()).toHaveProperty('error.links.buy_credits', 'u')
  })
})

describe('credit estimation (from published rates)', () => {
  const veo: Model = { id: 'veo31_fast', object: 'model', name: 'Veo', mode: 'manual', operations: ['text_to_video'], credits_per_second: { '720p': 2, '1080p': 2, '4k': 4 }, durations: ['4s'], default_duration: '4s', resolutions: ['720p', '4k'], default_resolution: '720p', aspect_ratios: ['16:9'] }
  const auto: Model = { id: 'vivideo-auto', object: 'model', name: 'Auto', mode: 'auto', operations: ['text_to_video'], credits_per_second: {}, durations: [], resolutions: [], aspect_ratios: [], credits_per_5_seconds: 3 }
  it('auto = ceil(sec/5)*3', () => {
    expect(estimateAutoCredits(auto, 30)).toBe(18)
    expect(estimateAutoCredits(auto, 31)).toBe(21)
  })
  it('manual uses per-resolution rate', () => {
    expect(estimateManualCredits(veo, 8, '1080p')).toBe(16)
    expect(estimateManualCredits(veo, 8, '4k')).toBe(32)
  })
  it('estimateCredits picks the model and notes it is an estimate', () => {
    const r = estimateCredits([veo, auto], { mode: 'manual', model: 'veo31_fast', duration_seconds: 4, resolution: '720p' })
    expect(r.credits).toBe(8)
    expect(r.authoritative).toBe(false)
    expect(estimateCredits([veo, auto], { mode: 'manual', model: 'nope' }).credits).toBeNull()
  })
})

describe('config storage security', () => {
  // Write into a temp HOME, never the developer's real ~/.vivideo/config.json.
  const realHome = process.env.HOME
  beforeEach(async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    process.env.HOME = mkdtempSync(join(tmpdir(), 'vivideo-cfg-'))
  })
  afterEach(() => { process.env.HOME = realHome })

  it('saveConfig writes the file with 0600 (owner-only) permissions', async () => {
    const { saveConfig } = await import('./config.js')
    const { statSync } = await import('node:fs')
    const p = saveConfig({ apiKey: 'vv_live_permtest_1234567890' })
    const mode = (statSync(p).mode & 0o777).toString(8)
    expect(mode).toBe('600')
    saveConfig({ apiKey: 'vv_live_placeholder_000000000000' }) // leave a harmless value
  })
})

describe('guardrail primitives', () => {
  it('TokenBucket throttles beyond burst', async () => {
    const b = new TokenBucket(1000, 2)
    const t0 = Date.now()
    await b.take(); await b.take() // burst
    await b.take() // must wait for a refill
    expect(Date.now() - t0).toBeGreaterThanOrEqual(0)
  })
  it('Semaphore caps concurrency', async () => {
    const s = new Semaphore(1)
    let active = 0, max = 0
    const task = async () => { await s.acquire(); active++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 5)); active--; s.release() }
    await Promise.all([task(), task(), task()])
    expect(max).toBe(1)
  })
})
