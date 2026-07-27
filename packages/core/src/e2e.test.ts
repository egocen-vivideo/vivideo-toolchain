import { describe, it, expect } from 'vitest'
import { VivideoClient } from './client.js'
import { waitForVideo } from './poll.js'
import { estimateCredits } from './estimate.js'

/**
 * Required end-to-end verification flow, fully MOCKED (no production calls):
 *   account check → resource discovery → video creation → status waiting → completed result
 */
describe('end-to-end flow (mocked)', () => {
  it('runs account → discover → create → wait → completed', async () => {
    let polls = 0
    const fn = (async (url: URL | string, init?: RequestInit) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

      if (u.endsWith('/v1/me')) return json(200, { object: 'account', plan: 'pro', premium: true, credits: 100, free_video_available: false, first_video_comp_used: false, links: {} })
      if (u.endsWith('/v1/models')) return json(200, { object: 'list', data: [{ id: 'vivideo-auto', object: 'model', name: 'Auto', mode: 'auto', operations: ['text_to_video'], credits_per_second: {}, durations: [], resolutions: [], aspect_ratios: [], credits_per_5_seconds: 3 }] })
      if (u.endsWith('/v1/videos') && method === 'POST') return json(201, { id: 'vid_1', object: 'video', mode: 'auto', status: 'processing', credits_charged: 18, poll_interval_seconds: 0 })
      if (u.includes('/v1/videos/vid_1')) {
        polls += 1
        return polls < 2
          ? json(200, { id: 'vid_1', object: 'video', mode: 'auto', status: 'processing', poll_interval_seconds: 0, credits_charged: 18 })
          : json(200, { id: 'vid_1', object: 'video', mode: 'auto', status: 'completed', credits_charged: 18, video_url: 'https://cdn/x.mp4', duration_seconds: 30 })
      }
      return json(404, { error: { code: 'not_found', message: 'no', retryable: false, request_id: 'r' } })
    }) as unknown as typeof fetch

    const c = new VivideoClient({ apiKey: 'vv_live_e2e_key_1234567890', requestsPerSecond: 1000, burst: 1000, fetchImpl: fn })

    // 1. account
    const me = await c.me()
    expect(me.premium).toBe(true)
    expect(me.credits).toBe(100)

    // 2. discovery + estimate
    const { data: models } = await c.listModels()
    const est = estimateCredits(models, { mode: 'auto', duration_seconds: 30 })
    expect(est.credits).toBe(18)
    expect(est.credits!).toBeLessThanOrEqual(me.credits)

    // 3. create
    const created = await c.createVideo({ mode: 'auto', prompt: 'a demo' })
    expect(created.status).toBe('processing')
    expect(created.credits_charged).toBe(18)

    // 4. wait (safe polling)
    const { video, timedOut } = await waitForVideo(c, created.id, { minIntervalMs: 1, timeoutMs: 5000 })
    expect(timedOut).toBe(false)

    // 5. completed result
    expect(video.status).toBe('completed')
    expect(video.video_url).toBe('https://cdn/x.mp4')
  })

  it('waitForVideo returns timedOut without throwing when it never completes', async () => {
    const fn = (async () => new Response(JSON.stringify({ id: 'v', object: 'video', mode: 'auto', status: 'processing', poll_interval_seconds: 0 }), { status: 200 })) as unknown as typeof fetch
    const c = new VivideoClient({ apiKey: 'vv_live_x_1234567890', requestsPerSecond: 1000, burst: 1000, fetchImpl: fn })
    const { timedOut, video } = await waitForVideo(c, 'v', { minIntervalMs: 1, timeoutMs: 40 })
    expect(timedOut).toBe(true)
    expect(video.status).toBe('processing')
  })
})
