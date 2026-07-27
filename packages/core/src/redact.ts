/**
 * Secret redaction. API keys (vv_live_…) and signing secrets (whsec_…) must
 * never appear in logs, errors, or structured output. Everything that leaves
 * the client — error messages, debug lines, tool results — passes through here.
 */
const PATTERNS: RegExp[] = [
  /vv_live_[A-Za-z0-9_-]{4,}/g,
  /whsec_[A-Za-z0-9_-]{4,}/g,
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
]

/** Replace any secret-looking token with a short, safe placeholder. */
export function redact(input: string): string {
  let out = input
  for (const re of PATTERNS) {
    out = out.replace(re, (m) => {
      const prefix = m.startsWith('Bearer') ? 'Bearer ' : m.slice(0, 8)
      return `${prefix}…redacted`
    })
  }
  return out
}

/** Deep-redact any structure before it is logged or returned. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T
  if (Array.isArray(value)) return value.map(redactDeep) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      // Drop obviously-sensitive keys entirely rather than echo them.
      if (/^(authorization|api[_-]?key|secret|x-api-key)$/i.test(k)) {
        out[k] = '…redacted'
      } else {
        out[k] = redactDeep(v)
      }
    }
    return out as T
  }
  return value
}
