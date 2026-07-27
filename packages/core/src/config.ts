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
