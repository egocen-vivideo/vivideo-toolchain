/**
 * Credential + endpoint resolution. Precedence (highest first):
 *   1. explicit apiKey passed to the client
 *   2. env VIVIDEO_API_KEY
 *   3. config file ~/.vivideo/config.json  (written 0600, key never logged)
 *
 * Base URL: VIVIDEO_API_BASE_URL env, else https://api.vivideo.ai.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { VivideoError } from './errors.js'

export const DEFAULT_BASE_URL = 'https://api.vivideo.ai'
const KEY_PREFIX = 'vv_live_'

export function configDir(): string {
  return join(homedir(), '.vivideo')
}
export function configPath(): string {
  return join(configDir(), 'config.json')
}

interface StoredConfig {
  api_key?: string
  base_url?: string
}

function readStored(): StoredConfig {
  const p = configPath()
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as StoredConfig
  } catch {
    return {}
  }
}

export interface ResolvedConfig {
  apiKey: string
  baseUrl: string
  source: 'explicit' | 'env' | 'file'
}

/** Resolve credentials or throw a clear config error (never a generic one). */
export function resolveConfig(opts?: { apiKey?: string; baseUrl?: string }): ResolvedConfig {
  const baseUrl =
    opts?.baseUrl || process.env.VIVIDEO_API_BASE_URL || readStored().base_url || DEFAULT_BASE_URL

  if (opts?.apiKey) return { apiKey: opts.apiKey, baseUrl, source: 'explicit' }
  if (process.env.VIVIDEO_API_KEY) return { apiKey: process.env.VIVIDEO_API_KEY, baseUrl, source: 'env' }
  const stored = readStored().api_key
  if (stored) return { apiKey: stored, baseUrl, source: 'file' }

  throw VivideoError.config(
    'No Vivideo API key configured. Set VIVIDEO_API_KEY, pass apiKey, or run `vivideo configure`. ' +
      'Create a key in the app: Settings > More > API Keys (https://app.vivideo.ai/account/api-keys).',
  )
}

/** True if a key is resolvable without throwing (for `configured` checks). */
export function isConfigured(opts?: { apiKey?: string }): boolean {
  try {
    resolveConfig(opts)
    return true
  } catch {
    return false
  }
}

export function looksLikeKey(key: string): boolean {
  return typeof key === 'string' && key.startsWith(KEY_PREFIX) && key.length >= KEY_PREFIX.length + 20
}

/** Persist the key to ~/.vivideo/config.json with 0600 perms (owner-only). */
export function saveConfig(cfg: { apiKey?: string; baseUrl?: string }): string {
  const dir = configDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const current = readStored()
  const next: StoredConfig = { ...current }
  if (cfg.apiKey) next.api_key = cfg.apiKey
  if (cfg.baseUrl) next.base_url = cfg.baseUrl
  const p = configPath()
  writeFileSync(p, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  try {
    chmodSync(p, 0o600)
  } catch {
    /* best effort on platforms without chmod */
  }
  return p
}

// ------------------------------------------------------------------ V3 (agent sign-up / checkout)

export const DEFAULT_V3_BASE_URL = 'https://v3.api.vivideo.ai'

/** V3 base URL: explicit → env VIVIDEO_V3_BASE_URL → https://v3.api.vivideo.ai. */
export function resolveV3BaseUrl(explicit?: string): string {
  return (explicit || process.env.VIVIDEO_V3_BASE_URL || DEFAULT_V3_BASE_URL).replace(/\/+$/, '')
}

/** The API key if one resolves, else undefined (never throws). */
export function tryResolveApiKey(explicit?: string): string | undefined {
  try {
    return resolveConfig({ apiKey: explicit }).apiKey
  } catch {
    return undefined
  }
}

/** A sign-up waiting for payment. The claim token is a secret: stored 0600, never printed. */
export interface PendingClaim {
  checkout_id: string
  claim_token: string
  email?: string
  expires_at?: number | string
  created_at: number
}

export function claimsPath(): string {
  return join(configDir(), 'claims.json')
}

function readClaims(): Record<string, PendingClaim> {
  const p = claimsPath()
  if (!existsSync(p)) return {}
  try {
    const v = JSON.parse(readFileSync(p, 'utf8'))
    return v && typeof v === 'object' ? (v as Record<string, PendingClaim>) : {}
  } catch {
    return {}
  }
}

function writeClaims(all: Record<string, PendingClaim>): void {
  const dir = configDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const p = claimsPath()
  writeFileSync(p, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 })
  try {
    chmodSync(p, 0o600)
  } catch {
    /* best effort on platforms without chmod */
  }
}

const CLAIM_KEEP_MS = 3 * 24 * 3600 * 1000 // drop entries older than Stripe's 24 h session + slack

/** Remember a pending sign-up's claim token so a later status call (or a restart) can claim the key. */
export function savePendingClaim(c: Omit<PendingClaim, 'created_at'>): string {
  const now = Date.now()
  const all = readClaims()
  for (const [id, v] of Object.entries(all)) if (now - (v.created_at ?? 0) > CLAIM_KEEP_MS) delete all[id]
  all[c.checkout_id] = { ...c, created_at: now }
  writeClaims(all)
  return claimsPath()
}

export function getPendingClaim(checkoutId: string): PendingClaim | undefined {
  return readClaims()[checkoutId]
}

/** Forget a claim once it is used up (ready / claimed / needs_code / expired / failed). */
export function removePendingClaim(checkoutId: string): void {
  const all = readClaims()
  if (!(checkoutId in all)) return
  delete all[checkoutId]
  writeClaims(all)
}
