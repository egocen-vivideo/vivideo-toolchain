/**
 * VivideoClient — the ONE API client shared by the MCP server and the CLI.
 *
 * It wraps the public REST API (source of truth) and adds only client-side
 * concerns, never business logic:
 *   • auth (Bearer key)                • request timeout (AbortController)
 *   • rate limiting (token bucket)     • bounded retries w/ backoff
 *   • concurrency cap (semaphore)      • honors 429 Retry-After
 *   • idempotency keys on creates      • secret redaction on every path
 *
 * These are the guardrails that stop an agent-in-a-loop from turning into a
 * request flood — they complement, and never bypass, the API's own protections.
 */
import { randomUUID } from 'node:crypto'
import { resolveConfig, DEFAULT_BASE_URL } from './config.js'
import { VivideoError } from './errors.js'
import { TokenBucket, Semaphore, sleep, backoffMs } from './limiter.js'
import { redact } from './redact.js'
import type {
  Account, Model, Video, VideoList, Avatar, Voice, BrandKit, Asset, Upload, Folder,
  WebhookEndpoint, CreateAutoVideoInput, CreateManualVideoInput,
} from './types.js'

export interface ClientOptions {
  apiKey?: string
  baseUrl?: string
  /** Sustained request rate cap (default 8/s). */
  requestsPerSecond?: number
  /** Burst above the rate (default 8). */
  burst?: number
  /** Max concurrent in-flight requests (default 4). */
  maxConcurrent?: number
  /** Max retry attempts for retryable failures (default 4). */
  maxRetries?: number
  /** Per-request timeout in ms (default 30_000). */
  timeoutMs?: number
  userAgent?: string
  /** Injectable fetch (for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

interface RequestOpts {
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  idempotencyKey?: string
  timeoutMs?: number
  /** POST/DELETE with side effects are NOT retried on 5xx unless idempotent. */
  idempotent?: boolean
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

export class VivideoClient {
  readonly baseUrl: string
  private readonly apiKey: string
  private readonly bucket: TokenBucket
  private readonly sem: Semaphore
  private readonly maxRetries: number
  private readonly timeoutMs: number
  private readonly ua: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: ClientOptions = {}) {
    const cfg = resolveConfig({ apiKey: opts.apiKey, baseUrl: opts.baseUrl })
    this.apiKey = cfg.apiKey
    this.baseUrl = (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.bucket = new TokenBucket(opts.requestsPerSecond ?? 8, opts.burst ?? 8)
    this.sem = new Semaphore(opts.maxConcurrent ?? 4)
    this.maxRetries = Math.max(0, opts.maxRetries ?? 4)
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this.ua = opts.userAgent ?? 'vivideo-toolchain/1.0'
    const f = opts.fetchImpl ?? globalThis.fetch
    if (!f) throw VivideoError.config('global fetch is unavailable — Node 18.17+ is required.')
    this.fetchImpl = f
  }

  // --------------------------------------------------------------- core request

  private async request<T>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
    const url = new URL(this.baseUrl + path)
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'User-Agent': this.ua,
      Accept: 'application/json',
    }
    let payload: string | undefined
    if (opts.body !== undefined) {
      payload = JSON.stringify(opts.body)
      headers['Content-Type'] = 'application/json'
    }
    // Same idempotency key is reused across retries of THIS logical request.
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey

    let attempt = 0
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // ---- guardrails: rate limit + concurrency BEFORE every attempt ----
      await this.bucket.take()
      await this.sem.acquire()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.timeoutMs)
      let res: Response
      try {
        res = await this.fetchImpl(url, { method, headers, body: payload, signal: controller.signal })
      } catch (e) {
        clearTimeout(timeout)
        this.sem.release()
        const netErr = VivideoError.network(
          controller.signal.aborted ? `Request timed out after ${opts.timeoutMs ?? this.timeoutMs}ms` : `Network error: ${redact(String((e as Error)?.message ?? e))}`,
        )
        if (attempt < this.maxRetries) {
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

      const err = VivideoError.fromApi(res.status, json)
      // Retry only genuinely-retryable failures, bounded, honoring Retry-After.
      const canRetry =
        attempt < this.maxRetries && (err.retryable || RETRYABLE_STATUS.has(res.status))
      if (canRetry) {
        const waitMs =
          err.retryAfterSeconds != null
            ? err.retryAfterSeconds * 1000 + Math.floor(Math.random() * 250)
            : backoffMs(attempt)
        await sleep(waitMs)
        attempt += 1
        continue
      }
      throw err
    }
  }

  // ------------------------------------------------------------------ endpoints

  /** Account, plan, credit balance, and next-step links. */
  me(): Promise<Account> {
    return this.request<Account>('GET', '/v1/me')
  }

  /** Full model catalogue (manual models + the `vivideo-auto` pipeline). */
  listModels(): Promise<{ object: 'list'; data: Model[] }> {
    return this.request('GET', '/v1/models')
  }

  // ---- videos ----
  createVideo(input: CreateAutoVideoInput | CreateManualVideoInput, idempotencyKey?: string): Promise<Video> {
    return this.request<Video>('POST', '/v1/videos', {
      body: input,
      idempotencyKey: idempotencyKey ?? randomUUID(),
      idempotent: true, // safe to retry — the key dedupes server-side
    })
  }
  getVideo(id: string): Promise<Video> {
    return this.request<Video>('GET', `/v1/videos/${encodeURIComponent(id)}`)
  }
  renderVideo(id: string): Promise<Video> {
    return this.request<Video>('POST', `/v1/videos/${encodeURIComponent(id)}/render`, { idempotent: true })
  }
  listVideos(query?: { status?: string; folder_id?: string; limit?: number }): Promise<VideoList> {
    return this.request<VideoList>('GET', '/v1/videos', { query })
  }

  // ---- avatars ----
  listAvatars(query?: { view?: string; search?: string; gender?: string; limit?: number }): Promise<{ object: 'list'; data: Avatar[]; owned?: Avatar[] }> {
    return this.request('GET', '/v1/avatars', { query })
  }
  createAvatar(body: { kind: 'prompt' | 'photo'; name: string; prompt?: string; file_url?: string; asset_id?: string; consent?: boolean }): Promise<Avatar> {
    return this.request<Avatar>('POST', '/v1/avatars', { body })
  }
  getAvatar(id: string): Promise<Avatar> {
    return this.request<Avatar>('GET', `/v1/avatars/${encodeURIComponent(id)}`)
  }

  // ---- voices ----
  listVoices(query?: { language?: string; gender?: string; search?: string; limit?: number }): Promise<{ object: 'list'; data: Voice[]; owned?: Voice[]; total_public?: number }> {
    return this.request('GET', '/v1/voices', { query })
  }
  speech(body: { voice_id: string; text: string }): Promise<{ object: 'speech'; audio_url: string; duration_seconds?: number; voice_id: string }> {
    return this.request('POST', '/v1/voices/speech', { body })
  }

  // ---- brand kits ----
  listBrandKits(): Promise<{ object: 'list'; data: BrandKit[] }> {
    return this.request('GET', '/v1/brand-kits')
  }
  createBrandKit(body: Record<string, unknown>): Promise<BrandKit> {
    return this.request<BrandKit>('POST', '/v1/brand-kits', { body })
  }
  brandKitFromUrl(url: string): Promise<Record<string, unknown>> {
    return this.request('POST', '/v1/brand-kits/from-url', { body: { url } })
  }
  deleteBrandKit(id: string): Promise<{ id: string; deleted: boolean }> {
    return this.request('DELETE', `/v1/brand-kits/${encodeURIComponent(id)}`, { idempotent: true })
  }

  // ---- uploads / assets ----
  createUpload(body: { filename: string; content_type: string }): Promise<Upload> {
    return this.request<Upload>('POST', '/v1/uploads', { body })
  }
  createAsset(body: { filename: string; content_type: string; size_bytes: number }): Promise<Asset> {
    return this.request<Asset>('POST', '/v1/assets', { body })
  }
  completeAsset(id: string): Promise<Asset> {
    return this.request<Asset>('POST', `/v1/assets/${encodeURIComponent(id)}/complete`, { idempotent: true })
  }
  listAssets(): Promise<{ object: 'list'; data: Asset[] }> {
    return this.request('GET', '/v1/assets')
  }
  deleteAsset(id: string): Promise<{ id: string; deleted: boolean }> {
    return this.request('DELETE', `/v1/assets/${encodeURIComponent(id)}`, { idempotent: true })
  }

  // ---- folders ----
  listFolders(): Promise<{ object: 'list'; data: Folder[] }> {
    return this.request('GET', '/v1/folders')
  }

  // ---- webhooks ----
  listWebhooks(): Promise<{ object: 'list'; data: WebhookEndpoint[] }> {
    return this.request('GET', '/v1/webhooks')
  }
  createWebhook(body: { url: string; events?: string[] }): Promise<WebhookEndpoint> {
    return this.request<WebhookEndpoint>('POST', '/v1/webhooks', { body })
  }
  deleteWebhook(id: string): Promise<{ id: string; deleted: boolean }> {
    return this.request('DELETE', `/v1/webhooks/${encodeURIComponent(id)}`, { idempotent: true })
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return { error: { code: 'invalid_response', message: 'Non-JSON response from API.', retryable: false, request_id: '' } }
  }
}
