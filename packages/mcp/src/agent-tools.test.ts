import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentTools } from './agent-tools.js'
import { INSTRUCTIONS } from './server.js'
import { TOOLS } from './tools.js'

const KEY = 'vv_live_mcp_signup_key_1234567890abcd'
const CLAIM = 'ct_mcp_claim_token_secret_7'

interface Seen { url: string; method: string; headers: Record<string, string>; body?: string }
let seen: Seen[] = []
let routes: Record<string, () => [number, unknown]> = {}
const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
  const u = new URL(String(url))
  seen.push({ url: u.pathname, method: init?.method ?? 'GET', headers: (init?.headers as Record<string, string>) ?? {}, body: init?.body as string | undefined })
  const h = routes[`${init?.method ?? 'GET'} ${u.pathname}`]
  const [status, body] = h ? h() : [404, { error: 'not_found', message: 'no route' }]
  return new Response(JSON.stringify(body), { status })
}) as unknown as typeof fetch

const saved = { home: process.env.HOME, key: process.env.VIVIDEO_API_KEY }
beforeAll(() => { delete process.env.VIVIDEO_API_KEY })
afterAll(() => { process.env.HOME = saved.home; if (saved.key) process.env.VIVIDEO_API_KEY = saved.key })

let issued: string | undefined
let tools: ReturnType<typeof agentTools>
beforeEach(() => {
  process.env.HOME = mkdtempSync(join(tmpdir(), 'vivideo-mcp-'))
  seen = []
  routes = {}
  issued = undefined
  tools = agentTools({ onKey: (k) => { issued = k }, currentKey: () => issued, fetchImpl })
})

const tool = (name: string) => tools.find((t) => t.name === name)!
const parse = (r: { content: { text: string }[]; isError?: boolean }) => ({ data: JSON.parse(r.content[0].text), isError: !!r.isError, text: r.content[0].text })

describe('agent tools: definitions', () => {
  it('adds the six sign-up / payment tools', () => {
    expect(tools.map((t) => t.name)).toEqual(['start_signup', 'get_signup_status', 'request_login_code', 'verify_login_code', 'start_checkout', 'get_checkout'])
    for (const t of tools) expect(t.description.length).toBeGreaterThan(30)
  })
  it('keeps the 13 existing tools and appends the new ones (19 total)', () => {
    const names = TOOLS.map((t) => t.name)
    expect(names.slice(0, 13)).toEqual(['check_configuration', 'check_account', 'list_models', 'list_avatars', 'list_voices', 'list_brand_kits', 'estimate_credits', 'create_auto_video', 'create_manual_video', 'get_video', 'wait_for_video', 'list_videos', 'render_preview'])
    expect(names.slice(13)).toEqual(tools.map((t) => t.name))
  })
  it('server instructions explain the flow and secrecy', () => {
    expect(INSTRUCTIONS).toContain('start_signup')
    expect(INSTRUCTIONS).toContain('account_exists')
    expect(INSTRUCTIONS).toContain('request_login_code')
    expect(INSTRUCTIONS.toLowerCase()).toContain('claim tokens and api keys stay inside')
  })
})

describe('agent tools: sign-up', () => {
  it('start_signup returns the link but never the claim token; status ready saves + activates the key without showing it', async () => {
    routes['POST /v3/agent-start'] = () => [201, { checkout_id: 'co_1', checkout_url: 'https://checkout.stripe.com/c/pay/cs_1', claim_token: CLAIM, expires_at: 1900000000 }]
    const s = parse(await tool('start_signup').handler({ email: 'new@user.co', plan: 'pro', period: 'weekly' }))
    expect(s.isError).toBe(false)
    expect(s.data).toMatchObject({ status: 'pending', checkout_id: 'co_1', checkout_url: 'https://checkout.stripe.com/c/pay/cs_1' })
    expect(s.text).not.toContain(CLAIM)
    expect(seen[0].headers.Authorization).toBeUndefined()

    routes['GET /v3/agent-start/co_1'] = () => [200, { status: 'ready', api_key: KEY, key_id: 'key_1', account: { plan: 'pro', credits: 150 } }]
    const r = parse(await tool('get_signup_status').handler({ checkout_id: 'co_1' }))
    expect(r.data).toMatchObject({ status: 'ready', key_id: 'key_1', key_saved: true })
    expect(r.text).not.toContain(KEY)
    expect(seen[1].headers['X-Claim-Token']).toBe(CLAIM)
    expect(issued).toBe(KEY)
    expect(JSON.parse(readFileSync(join(process.env.HOME!, '.vivideo', 'config.json'), 'utf8')).api_key).toBe(KEY)
    expect(readFileSync(join(process.env.HOME!, '.vivideo', 'claims.json'), 'utf8')).not.toContain(CLAIM)
  })

  it('a restarted server finds the claim token on disk', async () => {
    routes['POST /v3/agent-start'] = () => [201, { checkout_id: 'co_2', checkout_url: 'https://checkout.stripe.com/x', claim_token: CLAIM, expires_at: 1 }]
    routes['GET /v3/agent-start/co_2'] = () => [200, { status: 'pending' }]
    await tool('start_signup').handler({ email: 'new@user.co', plan: 'max', period: 'yearly' })
    const fresh = agentTools({ onKey: () => {}, currentKey: () => undefined, fetchImpl })
    const r = parse(await fresh.find((t) => t.name === 'get_signup_status')!.handler({ checkout_id: 'co_2' }))
    expect(r.data.status).toBe('pending')
    expect(seen.at(-1)!.headers['X-Claim-Token']).toBe(CLAIM)
  })

  it('account_exists is a structured error that points to the login-code tools', async () => {
    routes['POST /v3/agent-start'] = () => [409, { error: 'account_exists', message: 'exists', next: { signup: { method: 'POST', url: '/v3/agent-signup' } } }]
    const r = parse(await tool('start_signup').handler({ email: 'old@user.co', plan: 'pro', period: 'weekly' }))
    expect(r.isError).toBe(true)
    expect(r.data.error.code).toBe('account_exists')
    expect(r.data.next_step).toContain('request_login_code')
  })

  it('needs_code points to the login-code tools', async () => {
    routes['POST /v3/agent-start'] = () => [201, { checkout_id: 'co_3', checkout_url: 'https://x', claim_token: CLAIM }]
    routes['GET /v3/agent-start/co_3'] = () => [200, { status: 'needs_code' }]
    await tool('start_signup').handler({ email: 'race@user.co', plan: 'pro', period: 'weekly' })
    const r = parse(await tool('get_signup_status').handler({ checkout_id: 'co_3' }))
    expect(r.data.status).toBe('needs_code')
    expect(r.data.next).toContain('request_login_code')
  })

  it('an unknown checkout without a claim token is a config error, with no request', async () => {
    const r = parse(await tool('get_signup_status').handler({ checkout_id: 'co_x' }))
    expect(r.isError).toBe(true)
    expect(r.data.error.kind).toBe('config')
    expect(seen.length).toBe(0)
  })

  it('status calls for one checkout are spaced >= 10 s apart even in a tight loop', async () => {
    let t = 1_000_000
    const sleeps: number[] = []
    const clocked = agentTools({ onKey: () => {}, currentKey: () => undefined, fetchImpl, clock: { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms } } })
    const get = clocked.find((x) => x.name === 'get_signup_status')!
    routes['GET /v3/agent-start/co_4'] = () => [200, { status: 'pending' }]
    await get.handler({ checkout_id: 'co_4', claim_token: CLAIM })
    t += 2_000
    await get.handler({ checkout_id: 'co_4', claim_token: CLAIM })
    await get.handler({ checkout_id: 'co_4', claim_token: CLAIM })
    expect(sleeps).toEqual([8_000, 10_000])
    expect(seen.filter((s) => s.method === 'GET').length).toBe(3)
  })
})

describe('agent tools: login code', () => {
  it('request_login_code then verify_login_code saves the key and never returns it or the code', async () => {
    routes['POST /v3/agent-signup'] = () => [202, { status: 'code_sent', expires_in: 600 }]
    routes['POST /v3/agent-signup/verify'] = () => [201, { api_key: KEY, key_id: 'key_2', account: { plan: 'free', credits: 0, free_video_available: true } }]
    const a = parse(await tool('request_login_code').handler({ email: 'old@user.co' }))
    expect(a.data.status).toBe('code_sent')
    const v = parse(await tool('verify_login_code').handler({ email: 'old@user.co', code: '123456' }))
    expect(v.data).toMatchObject({ status: 'signed_in', key_id: 'key_2', key_saved: true })
    expect(v.text).not.toContain(KEY)
    expect(v.text).not.toContain('123456')
    expect(issued).toBe(KEY)
  })

  it('a wrong code comes back as a structured error', async () => {
    routes['POST /v3/agent-signup/verify'] = () => [400, { error: 'invalid_code', message: 'The code is wrong.' }]
    const v = parse(await tool('verify_login_code').handler({ email: 'old@user.co', code: '000000' }))
    expect(v.isError).toBe(true)
    expect(v.data.error.code).toBe('invalid_code')
  })
})

describe('agent tools: checkout', () => {
  it('needs a key: config error, no request', async () => {
    const r = parse(await tool('start_checkout').handler({ plan: 'pro', period: 'weekly' }))
    expect(r.isError).toBe(true)
    expect(r.data.error.kind).toBe('config')
    expect(seen.length).toBe(0)
    expect(existsSync(join(process.env.HOME!, '.vivideo'))).toBe(false)
  })

  it('uses the key issued in this process; credits and plan are exclusive', async () => {
    issued = KEY
    routes['POST /v3/agent-checkout'] = () => [201, { checkout_id: 'ck_1', checkout_url: 'https://checkout.stripe.com/y', status_url: '/v3/checkout/ck_1', expires_at: 1, mode: 'credits', value_usd: 20 }]
    routes['GET /v3/checkout/ck_1'] = () => [200, { checkout_id: 'ck_1', status: 'paid', mode: 'credits', credits: 100 }]
    const c = parse(await tool('start_checkout').handler({ credits: 100 }))
    expect(c.data).toMatchObject({ checkout_id: 'ck_1', checkout_url: 'https://checkout.stripe.com/y', status: 'pending' })
    expect(seen[0].headers.Authorization).toBe(`Bearer ${KEY}`)
    expect(seen[0].headers['Idempotency-Key']).toBeTruthy()
    expect(JSON.parse(seen[0].body!)).toEqual({ mode: 'credits', credits: 100 })
    const g = parse(await tool('get_checkout').handler({ checkout_id: 'ck_1' }))
    expect(g.data.status).toBe('paid')
    const both = parse(await tool('start_checkout').handler({ credits: 100, plan: 'pro' }))
    expect(both.isError).toBe(true)
    expect(both.data.error.code).toBe('invalid_request')
  })
})
