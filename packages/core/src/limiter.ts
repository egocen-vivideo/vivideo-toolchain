/**
 * Client-side guardrails against request storms. Even though the API enforces
 * its own limits, the MCP server / CLI must never *become* the attack: an agent
 * in a loop, or a buggy script, could otherwise hammer the endpoint. Two gates:
 *
 *   TokenBucket  — caps sustained request RATE (with a small burst).
 *   Semaphore    — caps CONCURRENT in-flight requests.
 *
 * Every outbound request passes through both before it is sent.
 */

export class TokenBucket {
  private tokens: number
  private last: number
  constructor(private ratePerSec: number, private burst: number) {
    this.tokens = burst
    this.last = Date.now()
  }
  private refill(): void {
    const now = Date.now()
    const elapsed = (now - this.last) / 1000
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec)
    this.last = now
  }
  /** Resolve once a token is available (waits, does not reject). */
  async take(): Promise<void> {
    this.refill()
    if (this.tokens >= 1) {
      this.tokens -= 1
      return
    }
    const deficit = 1 - this.tokens
    const waitMs = Math.ceil((deficit / this.ratePerSec) * 1000)
    await sleep(waitMs)
    return this.take()
  }
}

export class Semaphore {
  private active = 0
  private queue: (() => void)[] = []
  constructor(private max: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
    this.active += 1
  }
  release(): void {
    this.active -= 1
    const next = this.queue.shift()
    if (next) next()
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)))
}

/** Full-jitter backoff for retryable failures (AWS-style). */
export function backoffMs(attempt: number, baseMs = 500, capMs = 20_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt)
  return Math.floor(Math.random() * exp)
}
