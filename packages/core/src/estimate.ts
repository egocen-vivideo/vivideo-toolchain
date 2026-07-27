/**
 * Pre-flight credit estimation from the PUBLISHED model rates in GET /v1/models
 * (`credits_per_second` / `credits_per_5_seconds`). This is a client-side
 * estimate to help agents check affordability before spending — it is NOT the
 * charge. The authoritative amount is `credits_charged` on the create response,
 * computed by the API. We never reimplement pricing; we read what the API tells us.
 */
import type { Model } from './types.js'

export interface EstimateResult {
  credits: number | null
  authoritative: false
  note: string
}

const AUTO_ID = 'vivideo-auto'

export function estimateAutoCredits(model: Model | undefined, durationSeconds: number): number {
  const per5 = model?.credits_per_5_seconds ?? 3
  const secs = clamp(durationSeconds, 5, 300)
  return Math.ceil(secs / 5) * per5
}

export function estimateManualCredits(model: Model, durationSeconds: number, resolution?: string): number {
  const rates = model.credits_per_second ?? {}
  const byRes = resolution ? rates[resolution.toLowerCase()] : undefined
  const byDefault = model.default_resolution ? rates[model.default_resolution] : undefined
  const rate: number = byRes ?? byDefault ?? Object.values(rates)[0] ?? 1
  const secs = Math.max(1, Math.floor(durationSeconds))
  return Math.ceil(secs * rate)
}

/** Estimate for a create request, given the models catalogue. */
export function estimateCredits(
  models: Model[],
  input: { mode: 'auto' | 'manual'; model?: string; duration_seconds?: number; resolution?: string },
): EstimateResult {
  if (input.mode === 'auto') {
    const auto = models.find((m) => m.id === AUTO_ID)
    const credits = estimateAutoCredits(auto, input.duration_seconds ?? 30)
    return { credits, authoritative: false, note: 'Estimate only; the create response returns the exact credits_charged.' }
  }
  const m = models.find((x) => x.id === input.model)
  if (!m) {
    return { credits: null, authoritative: false, note: `Unknown model "${input.model}". See GET /v1/models for valid ids.` }
  }
  const dur = input.duration_seconds ?? (parseInt(String(m.default_duration ?? '4'), 10) || 4)
  const credits = estimateManualCredits(m, dur, input.resolution ?? m.default_resolution)
  return { credits, authoritative: false, note: 'Estimate only; the create response returns the exact credits_charged.' }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
