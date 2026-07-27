import { describe, it, expect, vi } from 'vitest'
import { EXIT, reportError } from './output.js'
import { VivideoError } from '@vivideo/core'

describe('CLI exit codes', () => {
  it('maps each error kind to a distinct meaningful code', () => {
    expect(EXIT.ok).toBe(0)
    expect(EXIT.auth).toBe(3)
    expect(EXIT.insufficient_credits).toBe(4)
    expect(EXIT.rate_limited).toBe(5)
    expect(EXIT.upgrade_required).toBe(6)
    expect(EXIT.not_found).toBe(7)
    expect(EXIT.network).toBe(8)
  })
})

describe('reportError', () => {
  it('returns the mapped exit code and JSON error in --json mode', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const err = VivideoError.fromApi(402, { error: { code: 'insufficient_credits', message: 'need more', retryable: false, request_id: 'req_1', links: { buy_credits: 'https://app.vivideo.ai/x' } } })
    const code = reportError({ json: true, quiet: false }, err)
    expect(code).toBe(4)
    const out = spy.mock.calls.map((c) => c[0]).join('')
    expect(out).toContain('insufficient_credits')
    expect(out).toContain('buy_credits')
    spy.mockRestore()
  })

  it('never prints an API key, even if one is in the message', () => {
    const spyOut = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const spyErr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const err = new VivideoError({ code: 'x', message: 'boom vv_live_secret_key_123456', kind: 'server', status: 500, retryable: true })
    reportError({ json: false, quiet: false }, err)
    const all = [...spyOut.mock.calls, ...spyErr.mock.calls].map((c) => c[0]).join('')
    expect(all).not.toContain('vv_live_secret_key_123456')
    spyOut.mockRestore()
    spyErr.mockRestore()
  })

  it('human errors are actionable (code + next step), never generic', () => {
    const spyErr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const err = VivideoError.fromApi(403, { error: { code: 'upgrade_required', message: 'premium needed', retryable: false, request_id: 'r', links: { upgrade: 'https://app.vivideo.ai/upgrade' } } })
    const code = reportError({ json: false, quiet: false }, err)
    expect(code).toBe(6)
    const out = spyErr.mock.calls.map((c) => c[0]).join('')
    expect(out).toContain('upgrade_required')
    expect(out).toContain('upgrade: https://app.vivideo.ai/upgrade')
    expect(out).not.toContain('Something went wrong')
    spyErr.mockRestore()
  })
})
