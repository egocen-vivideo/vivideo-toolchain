import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')

function runCli(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('node', [CLI, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      resolve({ code: (err as { code?: number } | null)?.code ?? 0, stdout, stderr })
    })
  })
}

// A clean HOME with no ~/.vivideo/config.json, and no key in env.
const CLEAN = { HOME: mkdtempSync(join(tmpdir(), 'vivideo-qa-')), VIVIDEO_API_KEY: undefined }

describe('CLI integration (spawned binary)', () => {
  it('--help exits 0', async () => {
    const r = await runCli(['--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('vivideo')
  })

  it('unknown command → usage exit code 2', async () => {
    const r = await runCli(['definitely-not-a-command'], CLEAN)
    expect(r.code).toBe(2)
  })

  it('missing required option → usage exit code 2', async () => {
    const r = await runCli(['create', 'manual'], CLEAN) // missing --model/--prompt
    expect(r.code).toBe(2)
  })

  it('no key configured → auth/config exit code 3 with structured JSON error', async () => {
    const r = await runCli(['--json', 'account'], CLEAN)
    expect(r.code).toBe(3)
    const body = JSON.parse(r.stdout)
    expect(body.error.kind).toBe('config')
    expect(r.stdout).not.toMatch(/vv_live_/)
    expect(r.stderr).not.toMatch(/vv_live_/)
  })

  it('config command reports status and never prints a key', async () => {
    const r = await runCli(['--json', 'config'], { ...CLEAN, VIVIDEO_API_KEY: 'vv_live_should_not_be_echoed_123456' })
    expect(r.code).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.configured).toBe(true)
    expect(r.stdout).not.toContain('vv_live_should_not_be_echoed_123456')
  })
})
