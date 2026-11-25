// Secret redaction: API keys, signing secrets, claim tokens and 6-digit login codes are stripped
// from everything that leaves the client (logs, errors, tool results).
const PATTERNS: RegExp[] = [
  /vv_live_[A-Za-z0-9_-]{4,}/g,
  /whsec_[A-Za-z0-9_-]{4,}/g,
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
]

// Secrets with no fixed prefix, found by their label; group 1 (the label) is kept.
const LABELLED: RegExp[] = [
  /(x-claim-token["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
  /(claim[_-]?token["']?\s*[:=]\s*["']?)[^\s"',;}&]+/gi,
  /(--claim-token[=\s]+)\S+/gi,
  /(["']?\bcode["']?\s*[:=]\s*["']?)\d{6}\b/gi,
  /(--code[=\s]+)\d{6}\b/gi,
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
  for (const re of LABELLED) out = out.replace(re, (_m, label: string) => `${label}…redacted`)
  return out
}

const SENSITIVE_KEY = /^(authorization|api[_-]?key|secret|x-api-key|claim[_-]?token|x-claim-token)$/i

/** Deep-redact any structure before it is logged or returned. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T
  if (Array.isArray(value)) return value.map(redactDeep) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      // Drop obviously-sensitive keys entirely rather than echo them.
      if (SENSITIVE_KEY.test(k)) {
        out[k] = '…redacted'
      } else if (/^(code|login_code)$/i.test(k) && /^\d{6}$/.test(String(v))) {
        out[k] = '…redacted' // a login code; error codes are words, never 6 digits
      } else {
        out[k] = redactDeep(v)
      }
    }
    return out as T
  }
  return value
}
