/**
 * One error type for everything. Preserves the API's error model verbatim —
 * stable `code`, `retryable` flag, `request_id`, `retry_after_seconds`, next-step
 * `links` — plus a `kind` so callers can branch without string-matching messages.
 */
import { redact } from './redact.js'
import type { Links } from './types.js'

export type ErrorKind =
  | 'auth' // missing/invalid/revoked key — not retryable
  | 'insufficient_credits' // 402 — buy credits (links.buy_credits)
  | 'upgrade_required' // 403 — premium/free-limit (links.upgrade)
  | 'rate_limited' // 429 — honor retry_after_seconds
  | 'not_found' // 404
  | 'invalid_request' // 400 — fix inputs (details)
  | 'duplicate' // 409 duplicate_request / idempotency_in_flight
  | 'payload_too_large' // 413
  | 'server' // 5xx / upstream_error — retryable
  | 'network' // transport failure / timeout — retryable
  | 'config' // client misconfiguration (no key etc.)

const CODE_TO_KIND: Record<string, ErrorKind> = {
  missing_api_key: 'auth',
  invalid_api_key: 'auth',
  api_key_revoked: 'auth',
  account_not_found: 'auth',
  insufficient_credits: 'insufficient_credits',
  upgrade_required: 'upgrade_required',
  free_limit_reached: 'upgrade_required',
  rate_limited: 'rate_limited',
  not_found: 'not_found',
  invalid_request: 'invalid_request',
  unknown_model: 'invalid_request',
  invalid_url: 'invalid_request',
  duplicate_request: 'duplicate',
  idempotency_in_flight: 'duplicate',
  payload_too_large: 'payload_too_large',
  upstream_error: 'server',
  internal_error: 'server',
}

export class VivideoError extends Error {
  readonly code: string
  readonly kind: ErrorKind
  readonly status: number
  readonly retryable: boolean
  readonly requestId?: string
  readonly retryAfterSeconds?: number
  readonly details?: Record<string, unknown>
  readonly links?: Links

  constructor(args: {
    code: string
    message: string
    kind: ErrorKind
    status: number
    retryable: boolean
    requestId?: string
    retryAfterSeconds?: number
    details?: Record<string, unknown>
    links?: Links
  }) {
    super(redact(args.message))
    this.name = 'VivideoError'
    this.code = args.code
    this.kind = args.kind
    this.status = args.status
    this.retryable = args.retryable
    this.requestId = args.requestId
    this.retryAfterSeconds = args.retryAfterSeconds
    this.details = args.details
    this.links = args.links
  }

  /** Build a VivideoError from an HTTP response body (the API error envelope). */
  static fromApi(status: number, body: unknown): VivideoError {
    const err = (body as { error?: Record<string, unknown> } | undefined)?.error
    const code = String(err?.code ?? `http_${status}`)
    const kind = CODE_TO_KIND[code] ?? (status >= 500 ? 'server' : 'invalid_request')
    return new VivideoError({
      code,
      message: String(err?.message ?? `Request failed with status ${status}`),
      kind,
      status,
      retryable: typeof err?.retryable === 'boolean' ? err.retryable : status >= 500 || status === 429,
      requestId: err?.request_id ? String(err.request_id) : undefined,
      retryAfterSeconds: typeof err?.retry_after_seconds === 'number' ? err.retry_after_seconds : undefined,
      details: (err?.details as Record<string, unknown>) ?? undefined,
      links: (err?.links as Links) ?? undefined,
    })
  }

  static config(message: string): VivideoError {
    return new VivideoError({ code: 'config_error', message, kind: 'config', status: 0, retryable: false })
  }

  static network(message: string): VivideoError {
    return new VivideoError({ code: 'network_error', message, kind: 'network', status: 0, retryable: true })
  }

  /** A compact, secret-free object suitable for JSON output / tool results. */
  toJSON(): Record<string, unknown> {
    return {
      error: {
        code: this.code,
        kind: this.kind,
        message: this.message,
        retryable: this.retryable,
        request_id: this.requestId,
        retry_after_seconds: this.retryAfterSeconds,
        details: this.details,
        links: this.links,
      },
    }
  }
}

export const isVivideoError = (e: unknown): e is VivideoError => e instanceof VivideoError
