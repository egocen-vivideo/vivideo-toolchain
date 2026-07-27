import { describe, it, expect, beforeAll } from 'vitest'
import { TOOLS } from './tools.js'

// Stub global fetch + a key so tool handlers can execute without network.
let nextResponse: [number, unknown] = [200, {}]
beforeAll(() => {
  process.env.VIVIDEO_API_KEY = 'vv_live_tooltest_1234567890'
  ;(globalThis as { fetch: unknown }).fetch = async () => new Response(JSON.stringify(nextResponse[1]), { status: nextResponse[0] })
})

function parse(result: { content: { text: string }[]; isError?: boolean }) {
  return { data: JSON.parse(result.content[0].text), isError: !!result.isError }
}

describe('MCP tool definitions', () => {
  it('all tools have unique names, object schemas and non-empty descriptions', () => {
    const names = new Set<string>()
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^[a-z_]+$/)
      expect(names.has(t.name)).toBe(false)
      names.add(t.name)
      expect(typeof t.schema).toBe('object')
      expect(t.description.length).toBeGreaterThan(30)
      expect(typeof t.handler).toBe('function')
    }
  })

  it('exposes the required agent capabilities (and no cancel — unsupported)', () => {
    const names = TOOLS.map((t) => t.name)
    for (const n of ['check_account', 'list_models', 'list_avatars', 'list_voices', 'list_brand_kits', 'estimate_credits', 'create_auto_video', 'create_manual_video', 'get_video', 'wait_for_video', 'list_videos']) {
      expect(names).toContain(n)
    }
    expect(names).not.toContain('cancel_video') // API has no cancel endpoint
  })
})

describe('MCP tool execution (mocked)', () => {
  it('check_configuration reports configured=true when a key is set', async () => {
    const t = TOOLS.find((x) => x.name === 'check_configuration')!
    const { data } = parse(await t.handler({}))
    expect(data.configured).toBe(true)
  })

  it('check_account returns structured account data', async () => {
    nextResponse = [200, { object: 'account', plan: 'pro', premium: true, credits: 42, free_video_available: false, first_video_comp_used: false, links: {} }]
    const t = TOOLS.find((x) => x.name === 'check_account')!
    const { data, isError } = parse(await t.handler({}))
    expect(isError).toBe(false)
    expect(data.plan).toBe('pro')
    expect(data.credits).toBe(42)
  })

  it('errors are returned as structured isError results with code + links (not thrown)', async () => {
    nextResponse = [402, { error: { code: 'insufficient_credits', message: 'need more', retryable: false, request_id: 'req_1', links: { buy_credits: 'https://app.vivideo.ai/subscription' } } }]
    const t = TOOLS.find((x) => x.name === 'create_manual_video')!
    const { data, isError } = parse(await t.handler({ model: 'veo31_fast', prompt: 'x' }))
    expect(isError).toBe(true)
    expect(data.error.code).toBe('insufficient_credits')
    expect(data.error.kind).toBe('insufficient_credits')
    expect(data.error.links.buy_credits).toContain('vivideo.ai')
  })

  it('tool results never leak an api key', async () => {
    nextResponse = [200, { object: 'account', plan: 'pro', premium: true, credits: 1, free_video_available: false, first_video_comp_used: false, links: {} }]
    const t = TOOLS.find((x) => x.name === 'check_account')!
    const res = await t.handler({})
    expect(res.content[0].text).not.toContain('vv_live_tooltest')
  })
})
