/**
 * CLI output + exit-code contract. Two modes: human-readable and --json.
 * Rules the whole CLI obeys:
 *   • never print an API key (everything goes through redactDeep)
 *   • meaningful exit codes per failure kind (scripts/agents branch on them)
 *   • errors always show the stable code, request_id and next-step links —
 *     never a generic "something went wrong"
 */
import { isVivideoError, redactDeep, VivideoError, type ErrorKind } from '@vivideo/core'

export const EXIT: Record<ErrorKind | 'ok' | 'usage' | 'unknown' | 'timed_out' | 'needs_code' | 'payment_incomplete', number> = {
  ok: 0,
  unknown: 1,
  usage: 2,
  auth: 3,
  config: 3,
  insufficient_credits: 4,
  rate_limited: 5,
  upgrade_required: 6,
  not_found: 7,
  network: 8,
  invalid_request: 9,
  duplicate: 10,
  payload_too_large: 9,
  server: 1,
  conflict: 11, // e.g. has_subscription, key_limit_reached
  forbidden: 12, // not_allowed, account_unavailable, guest_account
  timed_out: 8, // stopped waiting (same code as `vivideo wait`); resume with a status command
  needs_code: 13, // the email already has an account: finish with `vivideo login --email … --code …`
  payment_incomplete: 14, // checkout expired or failed
}

export interface OutputCtx {
  json: boolean
  quiet: boolean
}

export function printResult(ctx: OutputCtx, data: unknown, humanLines?: () => string): void {
  const safe = redactDeep(data)
  if (ctx.json) {
    process.stdout.write(JSON.stringify(safe, null, 2) + '\n')
  } else if (humanLines) {
    process.stdout.write(humanLines() + '\n')
  } else {
    process.stdout.write(JSON.stringify(safe, null, 2) + '\n')
  }
}

/** Print an error (structured or human) and return the exit code to use. */
export function reportError(ctx: OutputCtx, e: unknown): number {
  const err = isVivideoError(e) ? e : VivideoError.config(String((e as Error)?.message ?? e))
  const code = EXIT[err.kind] ?? EXIT.unknown
  if (ctx.json) {
    process.stdout.write(JSON.stringify(redactDeep(err.toJSON()), null, 2) + '\n')
    return code
  }
  const lines: string[] = []
  lines.push(`✗ ${err.code}: ${err.message}`)
  if (err.requestId) lines.push(`  request_id: ${err.requestId}`)
  if (err.retryAfterSeconds != null) lines.push(`  retry after: ${err.retryAfterSeconds}s`)
  if (err.details) lines.push(`  details: ${JSON.stringify(redactDeep(err.details))}`)
  // Actionable next steps.
  if (err.kind === 'insufficient_credits' && err.links?.buy_credits) lines.push(`  → buy credits: ${err.links.buy_credits}`)
  if (err.kind === 'upgrade_required' && err.links?.upgrade) lines.push(`  → upgrade: ${err.links.upgrade}`)
  if (err.kind === 'auth' || err.kind === 'config') lines.push('  → set VIVIDEO_API_KEY, run `vivideo configure`, or get a key with `vivideo signup` / `vivideo login --email`.')
  if (err.kind === 'upgrade_required' && err.next?.checkout) lines.push('  → buy a plan: vivideo checkout --plan pro|max --period weekly|yearly')
  if (err.kind === 'rate_limited') lines.push('  → slow down; retry after the delay above.')
  process.stderr.write(lines.join('\n') + '\n')
  return code
}

export function die(ctx: OutputCtx, e: unknown): never {
  process.exit(reportError(ctx, e))
}
