// Sign-up, sign-in and payment tools (V3). The first four need no key; claim tokens and keys
// stay in this process and ~/.vivideo (0600) and never appear in a tool result.
import { z } from 'zod'
import {
  VivideoV3Client, VivideoError, isVivideoError, redactDeep, saveConfig, tryResolveApiKey, savePendingClaim, getPendingClaim, removePendingClaim,
  waitForSignup, waitForCheckout, MIN_STATUS_POLL_MS, sleep,
  type AgentCheckoutInput, type AgentPlan, type AgentPeriod, type AgentStartStatus,
} from '@vivideo/core'
import type { ToolDef, ToolResult } from './tools.js'

const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(redactDeep(data), null, 2) }] })
const fail = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(redactDeep(data), null, 2) }], isError: true })

async function guarded(fn: () => Promise<unknown>, onError?: (e: unknown) => unknown): Promise<ToolResult> {
  try {
    return ok(await fn())
  } catch (e) {
    if (isVivideoError(e)) return fail({ ...e.toJSON(), ...((onError?.(e) as object) ?? {}) })
    return fail({ error: { code: 'internal_error', kind: 'server', message: 'Unexpected error.', retryable: true } })
  }
}

const MAX_WAIT_SECONDS = 300

export interface AgentToolsDeps {
  /** Called with a newly issued key so every tool in this process uses it at once. */
  onKey: (apiKey: string) => void
  /** Explicit key for checkout tools after a sign-up in this process (else env / config file). */
  currentKey: () => string | undefined
  fetchImpl?: typeof fetch
  /** Injectable clock (tests); the 10 s floor itself is fixed. */
  clock?: { now(): number; sleep(ms: number): Promise<void> }
}

export function agentTools(deps: AgentToolsDeps): ToolDef[] {
  const claims = new Map<string, { claim_token: string; email?: string }>()
  const lastPoll = new Map<string, number>()
  const v3 = () => new VivideoV3Client({ apiKey: deps.currentKey(), userAgent: 'vivideo-mcp/1.1', fetchImpl: deps.fetchImpl })
  let publicClient: VivideoV3Client | null = null
  const pub = () => (publicClient ??= new VivideoV3Client({ userAgent: 'vivideo-mcp/1.1', fetchImpl: deps.fetchImpl }))

  // An agent calling a status tool in a loop still polls at most once per 10 s per checkout.
  const clock = deps.clock ?? { now: () => Date.now(), sleep }
  async function throttle(id: string): Promise<void> {
    const since = clock.now() - (lastPoll.get(id) ?? -Infinity)
    if (since < MIN_STATUS_POLL_MS) await clock.sleep(MIN_STATUS_POLL_MS - since)
    lastPoll.set(id, clock.now())
  }

  // Adopt a new key only when no key is configured: an agent (possibly prompt-injected) must never
  // switch a configured server to another account; switching is the user's own `vivideo login`.
  function adoptKey(apiKey: string, who: string): Record<string, unknown> {
    if (!(deps.currentKey() || tryResolveApiKey())) return storeKey(apiKey)
    return {
      key_saved: false,
      key_activated: false,
      next: `A new API key was issued for ${who}, but it was NOT saved or used: this server already has a key. ` +
        'To switch accounts, the user must run `vivideo login --email <email>` (or ' +
        '`vivideo configure`) themselves. The unused key can be revoked in Settings > API keys.',
    }
  }

  function storeKey(apiKey: string): { key_saved: boolean; config_path?: string } {
    deps.onKey(apiKey)
    try {
      return { key_saved: true, config_path: saveConfig({ apiKey }) }
    } catch {
      return { key_saved: false } // still active for this server process
    }
  }

  const loginNext = (email?: string) =>
    `Call request_login_code with email${email ? ` "${email}"` : ''}, ask your user for the 6-digit code from that inbox, then call verify_login_code.`

  return [
    {
      name: 'start_signup',
      description:
        'Create a NEW Vivideo account for your user by paying for a plan (works without an API key). Returns a Stripe ' +
        'checkout_url: SHOW THIS LINK TO YOUR USER, who pays there (card, Link or Apple Pay) — the only human step. Then call ' +
        'get_signup_status with the checkout_id; once paid, the API key is saved and used automatically. If the email ' +
        'already has an account this returns error account_exists: use request_login_code + verify_login_code instead ' +
        '(payment never opens an existing account). The claim token stays inside this server and is never returned.',
      schema: {
        email: z.string().email().max(254).describe('Your user\'s email; the new account is created for it.'),
        plan: z.enum(['pro', 'max']).describe('Plan to buy.'),
        period: z.enum(['weekly', 'yearly']).describe('Billing period.'),
        key_name: z.string().regex(/^[A-Za-z0-9 _-]{1,40}$/).optional().describe('Names the key "Agent: <key_name>".'),
      },
      handler: (a) =>
        guarded(async () => {
          const r = await pub().agentStart({ email: a.email as string, plan: a.plan as AgentPlan, period: a.period as AgentPeriod, key_name: a.key_name as string | undefined })
          claims.set(r.checkout_id, { claim_token: r.claim_token, email: a.email as string })
          try {
            savePendingClaim({ checkout_id: r.checkout_id, claim_token: r.claim_token, email: a.email as string, expires_at: r.expires_at })
          } catch { /* memory copy still works for this process */ }
          return {
            status: 'pending',
            checkout_id: r.checkout_id,
            checkout_url: r.checkout_url,
            expires_at: r.expires_at,
            next: 'Show checkout_url to your user and ask them to pay. Then call get_signup_status with this checkout_id (wait_seconds up to 300).',
          }
        }, (e) => (isVivideoError(e) && e.code === 'account_exists' ? { next_step: `This email already has an account. ${loginNext(a.email as string)}` } : {})),
    },
    {
      name: 'get_signup_status',
      description:
        'Check a sign-up started with start_signup: pending | ready | claimed | needs_code | expired | failed. On "ready" the ' +
        'new API key is saved (~/.vivideo/config.json) and every Vivideo tool uses it right away — the key is never shown; ' +
        'if a key is already configured it is NOT replaced (key_issued_not_saved: the user runs `vivideo login`). ' +
        '"needs_code": the email had an account by payment time, the plan went to it; sign in with request_login_code. ' +
        'Pass wait_seconds (max 300) to wait for payment; polls at most every 10 s, so do not call it in a tight loop.',
      schema: {
        checkout_id: z.string().min(1).describe('From start_signup.'),
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe('Wait up to this long for payment (default 0: check once).'),
        claim_token: z.string().optional().describe('Only if this server did not start the sign-up. Treat as a secret.'),
      },
      handler: (a) =>
        guarded(async () => {
          const id = a.checkout_id as string
          const stored = claims.get(id) ?? getPendingClaim(id)
          const token = (a.claim_token as string | undefined) || stored?.claim_token
          if (!token) throw VivideoError.config(`No claim token for ${id} in this server. Start the sign-up with start_signup (or pass claim_token).`)
          await throttle(id)
          const { result, timedOut } = await waitForSignup(pub(), id, token, { timeoutMs: ((a.wait_seconds as number) ?? 0) * 1000, clock: deps.clock })
          lastPoll.set(id, clock.now())
          return settleSignup(id, result, timedOut, stored?.email)
        }),
    },
    {
      name: 'request_login_code',
      description:
        'Sign in to an EXISTING Vivideo account (works without an API key): emails a 6-digit code to the address. Ask your ' +
        'user to read it from their inbox, then call verify_login_code. Use this when start_signup says account_exists, ' +
        'when get_signup_status says needs_code, or to get a new key for an account you already use.',
      schema: { email: z.string().email().max(254) },
      handler: (a) =>
        guarded(async () => {
          const r = await pub().requestLoginCode(a.email as string)
          return { status: r.status ?? 'code_sent', expires_in: r.expires_in, next: 'Ask your user for the 6-digit code sent to this email, then call verify_login_code.' }
        }),
    },
    {
      name: 'verify_login_code',
      description:
        'Finish signing in with the 6-digit code from the email (works without an API key). Creates a new API key for the ' +
        'account, saves it (~/.vivideo/config.json) and uses it for every Vivideo tool — the key is never shown. Returns ' +
        'the account plan and credits; if there is no plan yet, start_checkout buys one. If a key is already configured, the ' +
        'new key is NOT saved or used (status key_issued_not_saved): the user switches accounts with `vivideo login`.',
      schema: {
        email: z.string().email().max(254),
        code: z.string().regex(/^[0-9]{6}$/).describe('The 6 digits from the email.'),
        key_name: z.string().regex(/^[A-Za-z0-9 _-]{1,40}$/).optional().describe('Names the key "Agent: <key_name>".'),
      },
      handler: (a) =>
        guarded(async () => {
          const r = await pub().verifyLoginCode({ email: a.email as string, code: a.code as string, key_name: a.key_name as string | undefined })
          const saved = adoptKey(r.api_key, a.email as string)
          return { status: saved.key_activated === false ? 'key_issued_not_saved' : 'signed_in', email: a.email, key_id: r.key_id, account: r.account, ...saved }
        }),
    },
    {
      name: 'start_checkout',
      description:
        'Buy a plan (plan + period) or a credit top-up (credits) for the signed-in account (needs an API key: from ' +
        'VIVIDEO_API_KEY, start_signup or verify_login_code). Returns a Stripe checkout_url: SHOW IT TO YOUR USER to pay. ' +
        'It never pays by itself. Then call get_checkout. Credits need a plan first (402 plan_required).',
      schema: {
        plan: z.enum(['pro', 'max']).optional(),
        period: z.enum(['weekly', 'yearly']).optional(),
        credits: z.number().int().positive().optional().describe('Credit top-up instead of a plan.'),
        idempotency_key: z.string().max(128).optional().describe('Reuse to get the same checkout back on a retry.'),
      },
      handler: (a) =>
        guarded(async () => {
          let input: AgentCheckoutInput
          if (a.credits != null) {
            if (a.plan || a.period) throw invalid('Use either credits or plan + period, not both.')
            input = { mode: 'credits', credits: a.credits as number }
          } else {
            if (!a.plan || !a.period) throw invalid('Pass plan (pro|max) and period (weekly|yearly), or credits.')
            input = { mode: 'subscription', plan: a.plan as AgentPlan, period: a.period as AgentPeriod }
          }
          const c = await v3().agentCheckout(input, a.idempotency_key as string | undefined)
          return { ...c, status: 'pending', next: 'Show checkout_url to your user and ask them to pay. Then call get_checkout with this checkout_id (wait_seconds up to 300).' }
        }),
    },
    {
      name: 'get_checkout',
      description:
        'Check a checkout from start_checkout: pending | paid | expired | failed (needs an API key). Pass wait_seconds ' +
        '(max 300) to wait for payment; polls at most every 10 s. After "paid", check_account shows the new plan/credits.',
      schema: {
        checkout_id: z.string().min(1),
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe('Default 0: check once.'),
      },
      handler: (a) =>
        guarded(async () => {
          const id = a.checkout_id as string
          await throttle(id)
          const { result, timedOut } = await waitForCheckout(v3(), id, { timeoutMs: ((a.wait_seconds as number) ?? 0) * 1000, clock: deps.clock })
          lastPoll.set(id, clock.now())
          return { ...result, timed_out: timedOut && result.status === 'pending' && !!a.wait_seconds ? true : undefined }
        }),
    },
  ]

  function settleSignup(id: string, s: AgentStartStatus, timedOut: boolean, email?: string): unknown {
    const base = { checkout_id: id, status: s.status }
    switch (s.status) {
      case 'ready': {
        if (!s.api_key) return { ...base, error: 'ready without a key; call request_login_code to sign in.' }
        const saved = adoptKey(s.api_key, email ?? 'the account of this sign-up') // `ready` comes once: decide now
        forget(id)
        if (saved.key_activated === false) return { ...base, status: 'key_issued_not_saved', key_id: s.key_id, account: s.account, ...saved }
        return { ...base, key_id: s.key_id, account: s.account, ...saved, next: 'Signed in. Use the Vivideo tools (check_account, create_auto_video, …).' }
      }
      case 'needs_code':
        forget(id)
        return { ...base, next: `The email already had an account when the payment arrived; the plan went to that account. ${loginNext(email)}` }
      case 'claimed':
        forget(id)
        return { ...base, key_id: s.key_id, next: `The key was already handed out. If it is lost: ${loginNext(email)}` }
      case 'expired':
      case 'failed':
        forget(id)
        return { ...base, next: 'The payment did not complete. Call start_signup again for a new link.' }
      default:
        return { ...base, timed_out: timedOut || undefined, next: 'Not paid yet. Remind your user of the link, then call get_signup_status again (wait_seconds up to 300).' }
    }
  }

  function forget(id: string): void {
    claims.delete(id)
    try {
      removePendingClaim(id)
    } catch { /* best effort */ }
  }
}

function invalid(message: string): VivideoError {
  return new VivideoError({ code: 'invalid_request', message, kind: 'invalid_request', status: 400, retryable: false })
}
