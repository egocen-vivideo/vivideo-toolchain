// Safe payment waiting: polls at most every 10 s (fixed floor), stops at a terminal status or a hard
// timeout (default 15 min, cap 2 h), never throws on timeout, and backs off on 429 / transient errors.
import { isVivideoError } from './errors.js'
import { sleep } from './limiter.js'
import type { VivideoV3Client, AgentStartStatus, CheckoutStatus } from './v3.js'

export const MIN_STATUS_POLL_MS = 10_000
const DEFAULT_TIMEOUT_MS = 15 * 60_000
const MAX_TIMEOUT_MS = 2 * 3600_000

export const SIGNUP_TERMINAL: ReadonlySet<string> = new Set(['ready', 'claimed', 'needs_code', 'expired', 'failed'])
export const CHECKOUT_TERMINAL: ReadonlySet<string> = new Set(['paid', 'expired', 'failed'])

export interface StatusWaitOptions<T> {
  /** Hard cap on total wait (ms). Default 900_000 (15 min), max 7_200_000. */
  timeoutMs?: number
  /** Poll interval (ms). Never below 10_000. */
  intervalMs?: number
  onUpdate?: (s: T) => void
  signal?: AbortSignal
  /** Injectable clock (tests). */
  clock?: { now(): number; sleep(ms: number): Promise<void> }
}

export interface StatusWaitResult<T> {
  result: T
  timedOut: boolean
  polls: number
}

/** Poll `fetchOnce` until its status is terminal or the deadline passes. */
export async function waitForStatus<T extends { status: string }>(
  fetchOnce: () => Promise<T>,
  terminal: ReadonlySet<string>,
  opts: StatusWaitOptions<T> = {},
): Promise<StatusWaitResult<T>> {
  const clock = opts.clock ?? { now: () => Date.now(), sleep }
  const t = Number.isFinite(opts.timeoutMs) ? (opts.timeoutMs as number) : DEFAULT_TIMEOUT_MS
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(0, t))
  const interval = Math.max(MIN_STATUS_POLL_MS, Number.isFinite(opts.intervalMs) ? (opts.intervalMs as number) : 0)
  const deadline = clock.now() + timeoutMs
  let last: T | undefined
  let lastErr: unknown
  let polls = 0

  // Bounded by the deadline: every pass sleeps >= interval or returns.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let wait = interval
    try {
      polls += 1
      last = await fetchOnce()
      opts.onUpdate?.(last)
      if (terminal.has(last.status)) return { result: last, timedOut: false, polls }
    } catch (e) {
      // Transient (429 / network / retryable 5xx): wait and try again; anything else is final.
      if (!isVivideoError(e) || !(e.kind === 'rate_limited' || e.kind === 'network' || (e.kind === 'server' && e.retryable))) throw e
      lastErr = e
      wait = Math.max(interval, (e.retryAfterSeconds ?? 0) * 1000)
    }
    const remaining = deadline - clock.now()
    if (opts.signal?.aborted || remaining < wait) {
      if (last) return { result: last, timedOut: true, polls }
      throw lastErr
    }
    await clock.sleep(wait)
  }
}

/** Wait for a pay-first sign-up to reach ready / claimed / needs_code / expired / failed. */
export function waitForSignup(
  client: VivideoV3Client,
  checkoutId: string,
  claimToken: string,
  opts: StatusWaitOptions<AgentStartStatus> = {},
): Promise<StatusWaitResult<AgentStartStatus>> {
  return waitForStatus(() => client.agentStartStatus(checkoutId, claimToken), SIGNUP_TERMINAL, opts)
}

/** Wait for an agent checkout to reach paid / expired / failed. */
export function waitForCheckout(
  client: VivideoV3Client,
  checkoutId: string,
  opts: StatusWaitOptions<CheckoutStatus> = {},
): Promise<StatusWaitResult<CheckoutStatus>> {
  return waitForStatus(() => client.checkoutStatus(checkoutId), CHECKOUT_TERMINAL, opts)
}
