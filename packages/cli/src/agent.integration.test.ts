import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { execFile } from 'node:child_process'
import { createServer, type Server, type IncomingMessage } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')
const KEY = 'vv_live_cli_signup_key_1234567890abcd'
const CLAIM = 'ct_cli_claim_token_secret_42'

// --------------------------------------------------------- mock V3 API
type Handler = (req: IncomingMessage, body: string) => [number, unknown, Record<string, string>?]
interface Seen { method: string; url: string; headers: IncomingMessage['headers']; body: string }
let routes: Record<string, Handler> = {}
let seen: Seen[] = []
let server: Server
let base = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body })
      const h = routes[`${req.method} ${req.url}`]
      const [status, out, headers] = h ? h(req, body) : [404, { error: 'not_found', message: 'no route' }]
      res.writeHead(status, { 'content-type': 'application/json', ...(headers ?? {}) })
      res.end(JSON.stringify(out))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

let home = ''
beforeEach(() => {
  routes = {}
  seen = []
  home = mkdtempSync(join(tmpdir(), 'vivideo-agent-'))
})

function runCli(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('node', [CLI, ...args], { env: { ...process.env, HOME: home, VIVIDEO_API_KEY: undefined, VIVIDEO_V3_BASE_URL: base, ...env } }, (err, stdout, stderr) => {
      resolve({ code: (err as { code?: number } | null)?.code ?? 0, stdout, stderr })
    })
  })
}

const started = { checkout_id: 'co_1', checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_1', claim_token: CLAIM, expires_at: 1900000000, status_url: '/v3/agent-start/co_1' }
const configFile = () => join(home, '.vivideo', 'config.json')
const claimsFile = () => join(home, '.vivideo', 'claims.json')

describe('vivideo signup (pay-first)', () => {
  it('--no-wait prints the link, stores the claim token 0600, never prints it', async () => {
    routes['POST /v3/agent-start'] = () => [201, started]
    const r = await runCli(['--json', 'signup', '--email', 'new@user.co', '--plan', 'pro', '--period', 'weekly', '--no-wait'])
    expect(r.code).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out).toMatchObject({ status: 'pending', checkout_id: 'co_1', checkout_url: started.checkout_url, next: 'vivideo signup status co_1 --wait' })
    expect(r.stdout + r.stderr).not.toContain(CLAIM)
    expect(JSON.parse(seen[0].body)).toEqual({ email: 'new@user.co', plan: 'pro', period: 'weekly' })
    expect(seen[0].headers.authorization).toBeUndefined()
    expect((statSync(claimsFile()).mode & 0o777).toString(8)).toBe('600')
    expect(readFileSync(claimsFile(), 'utf8')).toContain(CLAIM)
  })

  it('waits, and on ready saves the key 0600 without printing it', async () => {
    routes['POST /v3/agent-start'] = () => [201, started]
    routes['GET /v3/agent-start/co_1'] = (req) =>
      req.headers['x-claim-token'] === CLAIM
        ? [200, { status: 'ready', api_key: KEY, key_id: 'key_1', account: { plan: 'pro', credits: 150 } }]
        : [404, { error: 'not_found', message: 'x' }]
    const r = await runCli(['--json', 'signup', '--email', 'new@user.co', '--plan', 'max', '--period', 'yearly', '--key-name', 'my bot'])
    expect(r.code).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out).toMatchObject({ status: 'ready', key_id: 'key_1', saved: true, account: { plan: 'pro', credits: 150 } })
    // the link arrives early on stderr as a JSON event
    const ev = JSON.parse(r.stderr.trim().split('\n')[0])
    expect(ev).toMatchObject({ event: 'checkout_created', checkout_url: started.checkout_url })
    expect(r.stdout + r.stderr).not.toContain(KEY)
    expect(r.stdout + r.stderr).not.toContain(CLAIM)
    expect(JSON.parse(readFileSync(configFile(), 'utf8')).api_key).toBe(KEY)
    expect((statSync(configFile()).mode & 0o777).toString(8)).toBe('600')
    expect(readFileSync(claimsFile(), 'utf8')).not.toContain(CLAIM) // used up → forgotten
    expect(JSON.parse(seen[0].body).key_name).toBe('my bot')
  })

  it('409 account_exists switches to the code flow (non-interactive: sends the code, prints the login command, exit 13)', async () => {
    routes['POST /v3/agent-start'] = () => [409, { error: 'account_exists', message: 'This email already has an account.', next: { signup: { method: 'POST', url: '/v3/agent-signup' } } }]
    routes['POST /v3/agent-signup'] = () => [202, { status: 'code_sent', expires_in: 600 }]
    const r = await runCli(['--json', 'signup', '--email', 'old@user.co', '--plan', 'pro', '--period', 'weekly'])
    expect(r.code).toBe(13)
    const out = JSON.parse(r.stdout)
    expect(out).toMatchObject({ status: 'account_exists', code_sent: true, next: 'vivideo login --email old@user.co --code <6-digit code>' })
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['POST /v3/agent-start', 'POST /v3/agent-signup'])
    expect(JSON.parse(seen[1].body)).toEqual({ email: 'old@user.co' })
  })

  it('signup status: needs_code forgets the claim and starts the code flow', async () => {
    routes['POST /v3/agent-start'] = () => [201, started]
    routes['GET /v3/agent-start/co_1'] = () => [200, { status: 'needs_code' }]
    routes['POST /v3/agent-signup'] = () => [202, { status: 'code_sent', expires_in: 600 }]
    await runCli(['--json', 'signup', '--email', 'race@user.co', '--plan', 'pro', '--period', 'weekly', '--no-wait'])
    const r = await runCli(['--json', 'signup', 'status', 'co_1'])
    expect(r.code).toBe(13)
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'needs_code', code_sent: true, email: 'race@user.co' })
    expect(readFileSync(claimsFile(), 'utf8')).not.toContain(CLAIM)
  })

  it('signup status: pending without --wait is a single check, exit 0', async () => {
    routes['POST /v3/agent-start'] = () => [201, started]
    routes['GET /v3/agent-start/co_1'] = () => [200, { status: 'pending' }]
    await runCli(['--json', 'signup', '--email', 'n@user.co', '--plan', 'pro', '--period', 'weekly', '--no-wait'])
    const r = await runCli(['--json', 'signup', 'status', 'co_1'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'pending', timed_out: false })
    expect(seen.filter((s) => s.method === 'GET').length).toBe(1)
  })

  it('signup status without a known claim token → config error, exit 3', async () => {
    const r = await runCli(['--json', 'signup', 'status', 'co_unknown'])
    expect(r.code).toBe(3)
    expect(seen.length).toBe(0)
  })

  it('missing --plan → usage exit 2, no request', async () => {
    const r = await runCli(['signup', '--email', 'a@b.co', '--period', 'weekly'])
    expect(r.code).toBe(2)
    expect(seen.length).toBe(0)
  })

  it('an invalid --plan is rejected by the CLI (exit 2)', async () => {
    const r = await runCli(['signup', '--email', 'a@b.co', '--plan', 'gold', '--period', 'weekly'])
    expect(r.code).toBe(2)
  })
})

describe('vivideo login', () => {
  it('--email --code verifies and saves the key', async () => {
    routes['POST /v3/agent-signup/verify'] = () => [201, { api_key: KEY, key_id: 'key_2', account: { plan: 'free', credits: 0, free_video_available: true } }]
    const r = await runCli(['--json', 'login', '--email', 'old@user.co', '--code', '123456'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'signed_in', key_id: 'key_2', saved: true })
    expect(JSON.parse(seen[0].body)).toEqual({ email: 'old@user.co', code: '123456' })
    expect(r.stdout + r.stderr).not.toContain(KEY)
    expect(JSON.parse(readFileSync(configFile(), 'utf8')).api_key).toBe(KEY)
  })

  it('--email alone (non-interactive) sends a code and prints the finish command, exit 0', async () => {
    routes['POST /v3/agent-signup'] = () => [202, { status: 'code_sent', expires_in: 600 }]
    const r = await runCli(['--json', 'login', '--email', 'old@user.co'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'code_sent', next: 'vivideo login --email old@user.co --code <6-digit code>' })
  })

  it('a wrong code → invalid_request exit 9; a malformed code → usage exit 2 without a request', async () => {
    routes['POST /v3/agent-signup/verify'] = () => [400, { error: 'invalid_code', message: 'The code is wrong.' }]
    const bad = await runCli(['--json', 'login', '--email', 'old@user.co', '--code', '000000'])
    expect(bad.code).toBe(9)
    expect(JSON.parse(bad.stdout).error.code).toBe('invalid_code')
    expect(bad.stdout).not.toContain('000000')
    seen = []
    const malformed = await runCli(['login', '--email', 'old@user.co', '--code', '12'])
    expect(malformed.code).toBe(2)
    expect(seen.length).toBe(0)
  })

  it('without --email it still stores a key (the old `login` = `configure` alias)', async () => {
    const r = await runCli(['--json', 'login', '--api-key', KEY])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).saved).toBe(true)
    expect(JSON.parse(readFileSync(configFile(), 'utf8')).api_key).toBe(KEY)
  })
})

describe('vivideo checkout', () => {
  const created = { checkout_id: 'ck_1', checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_2', status_url: '/v3/checkout/ck_1', expires_at: 1900000000, mode: 'subscription', value_usd: 9.99 }

  it('needs a key: exit 3 and no request', async () => {
    const r = await runCli(['--json', 'checkout', '--plan', 'pro', '--period', 'weekly'])
    expect(r.code).toBe(3)
    expect(seen.length).toBe(0)
  })

  it('--no-wait creates the checkout with Bearer + Idempotency-Key and prints the link', async () => {
    routes['POST /v3/agent-checkout'] = () => [201, created]
    const r = await runCli(['--json', 'checkout', '--plan', 'max', '--period', 'yearly', '--no-wait'], { VIVIDEO_API_KEY: KEY })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'pending', checkout_id: 'ck_1', checkout_url: created.checkout_url, next: 'vivideo checkout status ck_1 --wait' })
    expect(seen[0].headers.authorization).toBe(`Bearer ${KEY}`)
    expect(seen[0].headers['idempotency-key']).toBeTruthy()
    expect(JSON.parse(seen[0].body)).toEqual({ mode: 'subscription', plan: 'max', period: 'yearly' })
    expect(r.stdout).not.toContain(KEY)
  })

  it('--credits N sends a credits checkout; --credits with --plan is a usage error', async () => {
    routes['POST /v3/agent-checkout'] = () => [201, { ...created, mode: 'credits', value_usd: 20 }]
    routes['GET /v3/checkout/ck_1'] = () => [200, { checkout_id: 'ck_1', status: 'paid', mode: 'credits', credits: 100 }]
    const r = await runCli(['--json', 'checkout', '--credits', '100'], { VIVIDEO_API_KEY: KEY })
    expect(r.code).toBe(0)
    expect(JSON.parse(seen[0].body)).toEqual({ mode: 'credits', credits: 100 })
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'paid', credits: 100 })
    const both = await runCli(['checkout', '--credits', '100', '--plan', 'pro'], { VIVIDEO_API_KEY: KEY })
    expect(both.code).toBe(2)
  })

  it('402 plan_required maps to exit 6', async () => {
    routes['POST /v3/agent-checkout'] = () => [402, { error: 'plan_required', message: 'Credits need a plan.', next: { checkout: { method: 'POST', url: '/v3/agent-checkout' } } }]
    const r = await runCli(['--json', 'checkout', '--credits', '100'], { VIVIDEO_API_KEY: KEY })
    expect(r.code).toBe(6)
    expect(JSON.parse(r.stdout).error.next.checkout.url).toBe('/v3/agent-checkout')
  })

  it('checkout status: paid → 0, expired → 14', async () => {
    routes['GET /v3/checkout/ck_1'] = () => [200, { checkout_id: 'ck_1', status: 'paid', mode: 'subscription', plan: 'pro', period: 'weekly' }]
    const paid = await runCli(['--json', 'checkout', 'status', 'ck_1'], { VIVIDEO_API_KEY: KEY })
    expect(paid.code).toBe(0)
    expect(JSON.parse(paid.stdout).status).toBe('paid')
    routes['GET /v3/checkout/ck_1'] = () => [200, { checkout_id: 'ck_1', status: 'expired' }]
    const expired = await runCli(['--json', 'checkout', 'status', 'ck_1'], { VIVIDEO_API_KEY: KEY })
    expect(expired.code).toBe(14)
  })
})

describe('no stray files', () => {
  it('a usage error writes nothing to ~/.vivideo', async () => {
    await runCli(['signup', '--email', 'a@b.co'])
    expect(existsSync(join(home, '.vivideo'))).toBe(false)
  })
})
