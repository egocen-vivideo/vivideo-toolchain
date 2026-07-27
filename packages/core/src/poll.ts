/**
 * Safe completion waiting. Video renders take seconds to minutes, so a naive
 * `while(true) getVideo()` is exactly the kind of loop that becomes a request
 * flood. This helper:
 *   • honors the API's suggested `poll_interval_seconds` (never faster)
 *   • enforces a minimum floor between polls (default 3s)
 *   • stops at a terminal state OR a hard timeout (default 10 min)
 *   • NEVER throws on timeout — returns the last state + `timedOut` so an agent
 *     can hand back control and check again later instead of blocking forever.
 */
import type { VivideoClient } from './client.js'
import type { Video, VideoStatus } from './types.js'
import { sleep } from './limiter.js'

const STOP: ReadonlySet<VideoStatus> = new Set<VideoStatus>(['completed', 'failed', 'preview'])

export interface WaitOptions {
  /** Hard cap on total wait (ms). Default 600_000 (10 min). */
  timeoutMs?: number
  /** Never poll faster than this (ms). Default 3_000. */
  minIntervalMs?: number
  /** Called with each fresh video state (for progress UIs). */
  onUpdate?: (v: Video) => void
  /** Optional AbortSignal to cancel waiting. */
  signal?: AbortSignal
}

export interface WaitResult {
  video: Video
  timedOut: boolean
}

export async function waitForVideo(client: VivideoClient, id: string, opts: WaitOptions = {}): Promise<WaitResult> {
  const timeoutMs = opts.timeoutMs ?? 600_000
  const minIntervalMs = Math.max(1_000, opts.minIntervalMs ?? 3_000)
  const deadline = Date.now() + timeoutMs

  let video = await client.getVideo(id)
  opts.onUpdate?.(video)

  while (!STOP.has(video.status)) {
    if (opts.signal?.aborted) return { video, timedOut: true }
    if (Date.now() >= deadline) return { video, timedOut: true }

    const suggested = (video.poll_interval_seconds ?? 5) * 1000
    const remaining = deadline - Date.now()
    const wait = Math.min(Math.max(minIntervalMs, suggested), Math.max(1_000, remaining))
    await sleep(wait)

    video = await client.getVideo(id)
    opts.onUpdate?.(video)
  }
  return { video, timedOut: false }
}
