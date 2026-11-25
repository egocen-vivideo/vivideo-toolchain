// V3 client for agent sign-up, login code and checkout; same guardrails as VivideoClient.
// GETs and Idempotency-Key POSTs retry transient failures; other POSTs retry only a short 429 (refused before any work).
import { randomUUID } from 'node:crypto'
import { resolveV3BaseUrl, tryResolveApiKey } from './config.js'
import { VivideoError } from './errors.js'
import { TokenBucket, Semaphore, sleep, backoffMs } from './limiter.js'
import { redact } from './redact.js'

export type AgentPlan = 'pro' | 'max'
export type AgentPeriod = 'weekly' | 'yearly'

export interface AgentStartInput {
  email: string
  plan: AgentPlan
  period: AgentPeriod
  /** Names the key "Agent: <key_name>"; ^[A-Za-z0-9 _-]{1,40}$. */
  key_name?: string
}

export interface AgentStartResult {
  checkout_id: string
  checkout_url: string
  /** Secret, shown once: the only way to the key. Never log or print it. */
  claim_token: string
  expires_at?: number | string
  status_url?: string
  next?: Record<string, unknown>
}

export type SignupStatusValue = 'pending' | 'expired' | 'failed' | 'ready' | 'claimed' | 'needs_code'

export interface AgentAccountSummary {
  plan?: string
  credits?: number
  free_video_available?: boolean
  [k: string]: unknown
}

export interface AgentStartStatus {
  status: SignupStatusValue | string
  checkout_id?: string
  /** Only on `ready`, exactly once. Save it immediately. */
  api_key?: string
  key_id?: string
  account?: AgentAccountSummary
  next?: Record<string, unknown>
  [k: string]: unknown
}

export interface LoginCodeSent {
  status: 'code_sent' | string
  message?: string
  expires_in?: number
  next?: Record<string, unknown>
}

export interface LoginVerified {
  api_key: string
  key_id: string
  account: AgentAccountSummary
  next?: Record<string, unknown>
}

export type AgentCheckoutInput =
  | { mode: 'subscription'; plan: AgentPlan; period: AgentPeriod }
  | { mode: 'credits'; credits: number }

export interface AgentCheckout {
  checkout_id: string
  checkout_url: string
  status_url: string
  expires_at: number | string
  mode: 'subscription' | 'credits'
  value_usd?: number
  [k: string]: unknown
}

export type CheckoutStatusValue = 'pending' | 'paid' | 'expired' | 'failed'

export interface CheckoutStatus {
  checkout_id: string
  status: CheckoutStatusValue | string
  state?: string
  mode?: string
  plan?: string
  period?: string
  credits?: number
  value_usd?: number
  created_at?: number
  paid_at?: number
  fulfilled_at?: number
  channel?: string
  session_expires_at?: number
  [k: string]: unknown
}

export interface V3ClientOptions {
  apiKey?: string
  baseUrl?: string
  requestsPerSecond?: number
  burst?: number
  maxConcurrent?: number
  maxRetries?: number
  timeoutMs?: number
  /** A 429 asking to wait longer than this is returned, not slept on (default 30 s). */
  maxRetryAfterSeconds?: number
  userAgent?: string
  fetchImpl?: typeof fetch
}

interface V3RequestOpts {
  body?: unknown
  auth?: boolean
  headers?: Record<string, string>
  /** True for GETs and Idempotency-Key POSTs: safe to resend after a failure. */
  retrySafe?: boolean
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

export class VivideoV3Client {
  readonly baseUrl: string
  private readonly explicitKey?: string
  private readonly bucket: TokenBucket
  private readonly sem: Semaphore
  private readonly maxRetries: number
  private readonly timeoutMs: number
  private readonly maxRetryAfter: number
  private readonly ua: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: V3ClientOptions = {}) {
    this.explicitKey = opts.apiKey
    this.baseUrl = resolveV3BaseUrl(opts.baseUrl)
    this.bucket = new TokenBucket(opts.requestsPerSecond ?? 8, opts.burst ?? 8)
    this.sem = new Semaphore(opts.maxConcurrent ?? 4)
    this.maxRetries = Math.max(0, opts.maxRetries ?? 4)
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this.maxRetryAfter = opts.maxRetryAfterSeconds ?? 30
    this.ua = opts.userAgent ?? 'vivideo-toolchain/1.1'
    const f = opts.fetchImpl ?? globalThis.fetch
    if (!f) throw VivideoError.config('global fetch is unavailable — Node 18.17+ is required.')
    this.fetchImpl = f
  }

  /** True when a key resolves (explicit → VIVIDEO_API_KEY → ~/.vivideo/config.json). */
  hasApiKey(): boolean {
    return !!tryResolveApiKey(this.explicitKey)
  }

  private key(): string {
    const k = tryResolveApiKey(this.explicitKey)
    if (!k) {
      throw VivideoError.config(
        'No Vivideo API key configured. Sign up with `vivideo signup` (or the start_signup tool), sign in with ' +
          '`vivideo login --email`, or set VIVIDEO_API_KEY.',
      )
    }
    return k
  }

  private async request<T>(method: string, path: string, opts: V3RequestOpts = {}): Promise<T> {
    const url = new URL(this.baseUrl + path)
    const headers: Record<string, string> = { 'User-Agent': this.ua, Accept: 'application/json', ...(opts.headers ?? {}) }
    if (opts.auth) headers.Authorization = `Bearer ${this.key()}`
    let payload: string | undefined
    if (opts.body !== undefined) {
      payload = JSON.stringify(opts.body)
      headers['Content-Type'] = 'application/json'
    }
    const retrySafe = opts.retrySafe ?? method === 'GET'

    let attempt = 0
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await this.bucket.take()
      await this.sem.acquire()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
      let res: Response
      try {
        res = await this.fetchImpl(url, { method, headers, body: payload, signal: controller.signal })
      } catch (e) {
        clearTimeout(timeout)
        this.sem.release()
        const netErr = VivideoError.network(
          controller.signal.aborted ? `Request timed out after ${this.timeoutMs}ms` : `Network error: ${redact(String((e as Error)?.message ?? e))}`,
        )
        if (retrySafe && attempt < this.maxRetries) {
          await sleep(backoffMs(attempt))
          attempt += 1
          continue
        }
        throw netErr
      }
      clearTimeout(timeout)
      this.sem.release()

      if (res.status === 204) return undefined as T
      const text = await res.text()
      const json = text ? safeJson(text) : undefined
      if (res.ok) return json as T

      const err = VivideoError.fromV3(res.status, json, res.headers.get('retry-after'))
      const shortWait = err.retryAfterSeconds == null || err.retryAfterSeconds <= this.maxRetryAfter
      const canRetry =
        attempt < this.maxRetries &&
        err.retryable &&
        RETRYABLE_STATUS.has(res.status) &&
        shortWait &&
        (retrySafe || res.status === 429)
      if (canRetry) {
        const waitMs =
          err.retryAfterSeconds != null ? err.retryAfterSeconds * 1000 + Math.floor(Math.random() * 250) : backoffMs(attempt)
        await sleep(waitMs)
        attempt += 1
        continue
      }
      throw err
    }
  }

  // ------------------------------------------------------------- public (no key)

  /** POST /v3/agent-start: a Stripe link + claim token for a NEW email. 409 account_exists → use the code flow. */
  agentStart(input: AgentStartInput): Promise<AgentStartResult> {
    return this.request<AgentStartResult>('POST', '/v3/agent-start', { body: stripUndefined(input) })
  }

  /** GET /v3/agent-start/{id} with X-Claim-Token. `ready` (with the key) is returned exactly once. */
  agentStartStatus(checkoutId: string, claimToken: string): Promise<AgentStartStatus> {
    return this.request<AgentStartStatus>('GET', `/v3/agent-start/${encodeURIComponent(checkoutId)}`, {
      headers: { 'X-Claim-Token': claimToken },
    })
  }

  /** POST /v3/agent-signup: email a 6-digit sign-in code (same 202 whether or not the account exists). */
  requestLoginCode(email: string): Promise<LoginCodeSent> {
    return this.request<LoginCodeSent>('POST', '/v3/agent-signup', { body: { email } })
  }

  /** POST /v3/agent-signup/verify: trade the code for one new API key. */
  verifyLoginCode(input: { email: string; code: string; key_name?: string }): Promise<LoginVerified> {
    return this.request<LoginVerified>('POST', '/v3/agent-signup/verify', { body: stripUndefined(input) })
  }

  // ------------------------------------------------------------- with a key

  /** POST /v3/agent-checkout: a Stripe link for a plan or a credit top-up. Retry-safe via Idempotency-Key. */
  agentCheckout(input: AgentCheckoutInput, idempotencyKey?: string): Promise<AgentCheckout> {
    return this.request<AgentCheckout>('POST', '/v3/agent-checkout', {
      body: input,
      auth: true,
      headers: { 'Idempotency-Key': idempotencyKey ?? randomUUID() },
      retrySafe: true,
    })
  }

  /** GET /v3/checkout/{id}: status pending | paid | expired | failed. */
  checkoutStatus(checkoutId: string): Promise<CheckoutStatus> {
    return this.request<CheckoutStatus>('GET', `/v3/checkout/${encodeURIComponent(checkoutId)}`, { auth: true })
  }
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return { error: 'invalid_response', message: 'Non-JSON response from API.' }
  }
}
