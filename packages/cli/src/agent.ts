// signup / login / checkout commands on the V3 API. Keys go to ~/.vivideo/config.json and claim
// tokens to ~/.vivideo/claims.json (both 0600); neither is ever printed.
import { spawn } from 'node:child_process'
import { Command, Option } from 'commander'
import {
  VivideoError, isVivideoError, saveConfig, savePendingClaim, getPendingClaim, removePendingClaim,
  waitForSignup, waitForCheckout, MIN_STATUS_POLL_MS,
  type VivideoV3Client, type AgentStartStatus, type CheckoutStatus, type AgentCheckoutInput,
  type AgentPlan, type AgentPeriod,
} from '@vivideo/core'
import { runV3, nonInteractive, type GlobalOpts } from './context.js'
import { printResult, EXIT, type OutputCtx } from './output.js'

type Prompt = (q: string) => Promise<string>
type ConfigureAction = (opts: { apiKey?: string; verify?: boolean }) => Promise<void>

const DEFAULT_WAIT_SEC = 1800

export function registerAgentCommands(program: Command, g: () => GlobalOpts, configureAction: ConfigureAction, prompt: Prompt): void {
  // ------------------------------------------------------------ signup
  const signup = program
    .command('signup')
    .description('Create a NEW account by paying for a plan: prints a Stripe link, waits for payment, saves the API key.')
    .option('--email <email>', 'email for the new account (an existing account switches to `vivideo login`)')
    .addOption(new Option('--plan <plan>', 'plan').choices(['pro', 'max']))
    .addOption(new Option('--period <period>', 'billing period').choices(['weekly', 'yearly']))
    .option('--key-name <name>', 'names the key "Agent: <name>" (letters, digits, space, _ -; max 40)')
    .option('--open', 'open the payment page in the default browser')
    .option('--no-wait', 'print the link and exit; finish with `vivideo signup status <checkout_id> --wait`')
    .option('--timeout <sec>', 'max wait for payment in seconds', toInt, DEFAULT_WAIT_SEC)
    .action((opts) => runV3(g(), async (v3, ctx) => {
      const gg = g()
      if (!opts.email || !opts.plan || !opts.period) return usage(ctx, 'signup needs --email, --plan pro|max and --period weekly|yearly.')
      let started
      try {
        started = await v3.agentStart({ email: opts.email, plan: opts.plan as AgentPlan, period: opts.period as AgentPeriod, key_name: opts.keyName })
      } catch (e) {
        if (isVivideoError(e) && e.code === 'account_exists') {
          note(ctx, `${opts.email} already has a Vivideo account. Paying never opens an existing account; sign in with the code sent to that inbox.`)
          return codeFlow(v3, ctx, gg, prompt, { email: opts.email, keyName: opts.keyName, reason: 'account_exists' })
        }
        throw e
      }
      savePendingClaim({ checkout_id: started.checkout_id, claim_token: started.claim_token, email: opts.email, expires_at: started.expires_at })
      const resume = `vivideo signup status ${started.checkout_id} --wait`
      if (opts.open) openBrowser(ctx, started.checkout_url)
      if (!opts.wait) {
        printResult(ctx, { status: 'pending', checkout_id: started.checkout_id, checkout_url: started.checkout_url, expires_at: started.expires_at, next: resume },
          () => `Pay here (Stripe, the only step that needs a person):\n  ${started.checkout_url}\ncheckout_id: ${started.checkout_id}\nAfter payment run: ${resume}`)
        return
      }
      announce(ctx, started, resume, opts.timeout)
      const { result, timedOut } = await waitForSignup(v3, started.checkout_id, started.claim_token, { timeoutMs: opts.timeout * 1000, onUpdate: progress(ctx) })
      await settleSignup(v3, ctx, gg, prompt, started.checkout_id, result, timedOut, opts.email, opts.keyName, started.checkout_url)
    }))

  signup
    .command('status <checkout_id>')
    .description('Check (or --wait for) a pay-first sign-up; on payment, saves the API key.')
    .option('--wait', 'wait for payment (polls every 10 s; --timeout on `signup`, default 1800 s)')
    .option('--claim-token <token>', 'claim token (default: the one `vivideo signup` saved, or env VIVIDEO_CLAIM_TOKEN)')
    .action((checkoutId: string, opts, cmd: Command) => runV3(g(), async (v3, ctx) => {
      const gg = g()
      const parent = cmd.parent?.opts() ?? {}
      const pending = getPendingClaim(checkoutId)
      const token = opts.claimToken || process.env.VIVIDEO_CLAIM_TOKEN || pending?.claim_token
      if (!token) throw VivideoError.config(`No claim token for ${checkoutId} on this machine. Pass --claim-token or set VIVIDEO_CLAIM_TOKEN.`)
      const timeoutSec = opts.wait ? (parent.timeout ?? DEFAULT_WAIT_SEC) : 0
      if (opts.wait && !ctx.json && !ctx.quiet) process.stderr.write(`Waiting for payment… polling every ${MIN_STATUS_POLL_MS / 1000} s, up to ${fmtWait(timeoutSec)}.\n`)
      const { result, timedOut } = await waitForSignup(v3, checkoutId, token, { timeoutMs: timeoutSec * 1000, onUpdate: opts.wait ? progress(ctx) : undefined })
      await settleSignup(v3, ctx, gg, prompt, checkoutId, result, timedOut && !!opts.wait, parent.email ?? pending?.email, parent.keyName, undefined)
    }))

  // ------------------------------------------------------------ login
  program
    .command('login')
    .description('Sign in to an EXISTING account with a 6-digit email code and save a new API key. Without --email, same as `configure`.')
    .option('--email <email>', 'the account email; a code is sent there')
    .option('--code <code>', 'the 6-digit code from the email (omit to send one)')
    .option('--key-name <name>', 'names the key "Agent: <name>"')
    .option('--api-key <key>', 'without --email: store this key (as `configure`)')
    .option('--verify', 'without --email: verify the key before saving (as `configure`)')
    .action(async (opts) => {
      if (!opts.email) return configureAction({ apiKey: opts.apiKey, verify: opts.verify })
      await runV3(g(), (v3, ctx) => codeFlow(v3, ctx, g(), prompt, { email: opts.email, code: opts.code, keyName: opts.keyName }))
    })

  // ------------------------------------------------------------ checkout
  const checkout = program
    .command('checkout')
    .description('Buy a plan or credits for the signed-in account: prints a Stripe link and waits for payment.')
    .addOption(new Option('--plan <plan>', 'plan').choices(['pro', 'max']))
    .addOption(new Option('--period <period>', 'billing period').choices(['weekly', 'yearly']))
    .option('--credits <n>', 'credit top-up instead of a plan (needs a plan)', toInt)
    .option('--idempotency-key <key>', 'reuse to get the same checkout back instead of a new one')
    .option('--open', 'open the payment page in the default browser')
    .option('--no-wait', 'print the link and exit; finish with `vivideo checkout status <checkout_id> --wait`')
    .option('--timeout <sec>', 'max wait for payment in seconds', toInt, DEFAULT_WAIT_SEC)
    .action((opts) => runV3(g(), async (v3, ctx) => {
      let input: AgentCheckoutInput
      if (opts.credits != null) {
        if (opts.plan || opts.period) return usage(ctx, 'use either --credits or --plan/--period, not both.')
        if (!Number.isInteger(opts.credits) || opts.credits <= 0) return usage(ctx, '--credits must be a positive whole number.')
        input = { mode: 'credits', credits: opts.credits }
      } else {
        if (!opts.plan || !opts.period) return usage(ctx, 'checkout needs --plan pro|max and --period weekly|yearly, or --credits N.')
        input = { mode: 'subscription', plan: opts.plan, period: opts.period }
      }
      if (!v3.hasApiKey()) throw VivideoError.config('No API key. Run `vivideo signup` (new account) or `vivideo login --email` (existing) first.')
      const c = await v3.agentCheckout(input, opts.idempotencyKey)
      const resume = `vivideo checkout status ${c.checkout_id} --wait`
      if (opts.open) openBrowser(ctx, c.checkout_url)
      if (!opts.wait) {
        printResult(ctx, { status: 'pending', checkout_id: c.checkout_id, checkout_url: c.checkout_url, expires_at: c.expires_at, mode: c.mode, value_usd: c.value_usd, next: resume },
          () => `Pay here (Stripe):\n  ${c.checkout_url}\ncheckout_id: ${c.checkout_id}${c.value_usd != null ? `  amount: $${c.value_usd}` : ''}\nAfter payment run: ${resume}`)
        return
      }
      announce(ctx, c, resume, opts.timeout)
      const { result, timedOut } = await waitForCheckout(v3, c.checkout_id, { timeoutMs: opts.timeout * 1000, onUpdate: progress(ctx) })
      settleCheckout(ctx, result, timedOut, c.checkout_url)
    }))

  checkout
    .command('status <checkout_id>')
    .description('Check (or --wait for) a checkout: pending | paid | expired | failed.')
    .option('--wait', 'wait for payment (polls every 10 s; --timeout on `checkout`, default 1800 s)')
    .action((checkoutId: string, opts, cmd: Command) => runV3(g(), async (v3, ctx) => {
      const timeoutSec = opts.wait ? (cmd.parent?.opts().timeout ?? DEFAULT_WAIT_SEC) : 0
      const { result, timedOut } = await waitForCheckout(v3, checkoutId, { timeoutMs: timeoutSec * 1000, onUpdate: opts.wait ? progress(ctx) : undefined })
      settleCheckout(ctx, result, timedOut && !!opts.wait, undefined)
    }))
}

// ---------------------------------------------------------------- flows

async function settleSignup(
  v3: VivideoV3Client, ctx: OutputCtx, gg: GlobalOpts, prompt: Prompt, checkoutId: string, s: AgentStartStatus,
  timedOut: boolean, email: string | undefined, keyName: string | undefined, checkoutUrl: string | undefined,
): Promise<void> {
  switch (s.status) {
    case 'ready': {
      if (!s.api_key) throw new VivideoError({ code: 'invalid_response', message: 'Status was ready but carried no key.', kind: 'server', status: 200, retryable: false })
      const saved = saveKey(ctx, s.api_key) // save first: `ready` is returned exactly once
      removePendingClaim(checkoutId)
      printResult(ctx, { status: 'ready', checkout_id: checkoutId, key_id: s.key_id, account: s.account, saved: true, path: saved.path, env_override: saved.envOverride },
        () => `✓ Paid. Account created${email ? ` for ${email}` : ''}.\nplan: ${s.account?.plan ?? '?'}  credits: ${s.account?.credits ?? '?'}\nAPI key saved to ${saved.path} (owner-only, never printed).`)
      return
    }
    case 'needs_code':
      removePendingClaim(checkoutId)
      note(ctx, 'This email already had an account when the payment came in. The plan went to that account; sign in with the code sent to its inbox.')
      if (email) return codeFlow(v3, ctx, gg, prompt, { email, keyName, reason: 'needs_code' })
      printResult(ctx, { status: 'needs_code', checkout_id: checkoutId, next: 'vivideo login --email <email>' }, () => 'Next: vivideo login --email <email>')
      process.exitCode = EXIT.needs_code
      return
    case 'claimed':
      removePendingClaim(checkoutId)
      printResult(ctx, { status: 'claimed', checkout_id: checkoutId, key_id: s.key_id, next: `vivideo login --email ${email ? shellQuote(email) : '<email>'}` },
        () => `The key for this sign-up was already handed out (key_id ${s.key_id ?? '?'}). If it is lost, sign in with: vivideo login --email ${email ?? '<email>'}`)
      process.exitCode = EXIT.needs_code
      return
    case 'expired':
    case 'failed':
      removePendingClaim(checkoutId)
      printResult(ctx, { status: s.status, checkout_id: checkoutId }, () => `✗ Payment ${s.status}. Start again with \`vivideo signup\`.`)
      process.exitCode = EXIT.payment_incomplete
      return
    default: {
      const next = `vivideo signup status ${checkoutId} --wait`
      printResult(ctx, { status: s.status, checkout_id: checkoutId, checkout_url: checkoutUrl, timed_out: timedOut, next },
        () => `${timedOut ? 'Stopped waiting — ' : ''}status: ${s.status}${checkoutUrl ? `\npay here: ${checkoutUrl}` : ''}\nCheck again: ${next}`)
      if (timedOut) process.exitCode = EXIT.timed_out
    }
  }
}

function settleCheckout(ctx: OutputCtx, s: CheckoutStatus, timedOut: boolean, checkoutUrl: string | undefined): void {
  const next = `vivideo checkout status ${s.checkout_id} --wait`
  printResult(ctx, { ...s, checkout_url: checkoutUrl, timed_out: timedOut || undefined, next: s.status === 'pending' ? next : undefined }, () => {
    if (s.status === 'paid') return `✓ Paid (${s.mode ?? 'checkout'}${s.plan ? ` ${s.plan}` : ''}${s.period ? ` ${s.period}` : ''}${s.credits ? ` ${s.credits} credits` : ''}). Check the balance with: vivideo account`
    if (s.status === 'expired' || s.status === 'failed') return `✗ Payment ${s.status}. Start a new checkout with \`vivideo checkout\`.`
    return `${timedOut ? 'Stopped waiting — ' : ''}status: ${s.status}${checkoutUrl ? `\npay here: ${checkoutUrl}` : ''}\nCheck again: ${next}`
  })
  if (s.status === 'expired' || s.status === 'failed') process.exitCode = EXIT.payment_incomplete
  else if (timedOut) process.exitCode = EXIT.timed_out
}

/** The email-code sign-in: send a code, read it (TTY) or tell the caller how to finish, verify, save the key. */
async function codeFlow(
  v3: VivideoV3Client, ctx: OutputCtx, gg: GlobalOpts, prompt: Prompt,
  o: { email: string; code?: string; keyName?: string; reason?: 'account_exists' | 'needs_code' },
): Promise<void> {
  const finish = `vivideo login --email ${shellQuote(o.email)} --code <6-digit code>`
  let code = o.code?.trim()
  let interactive = false
  if (!code) {
    const sent = await v3.requestLoginCode(o.email)
    if (nonInteractive(gg)) {
      printResult(ctx, { status: o.reason ?? 'code_sent', code_sent: true, email: o.email, expires_in: sent.expires_in, next: finish },
        () => `A 6-digit code was sent to ${o.email}${sent.expires_in ? ` (valid ${Math.round(sent.expires_in / 60)} min)` : ''}.\nFinish with: ${finish}`)
      if (o.reason) process.exitCode = EXIT.needs_code
      return
    }
    interactive = true
    code = await prompt(`6-digit code sent to ${o.email}: `)
  }
  for (let attempt = 1; ; attempt++) {
    if (!/^\d{6}$/.test(code ?? '')) {
      if (interactive && attempt < 3) { code = await prompt('That is not 6 digits. Code: '); continue }
      return usage(ctx, 'the code is the 6 digits from the email.')
    }
    try {
      const v = await v3.verifyLoginCode({ email: o.email, code: code!, key_name: o.keyName })
      const saved = saveKey(ctx, v.api_key)
      printResult(ctx, { status: 'signed_in', email: o.email, key_id: v.key_id, account: v.account, saved: true, path: saved.path, env_override: saved.envOverride },
        () => `✓ Signed in as ${o.email}.\nplan: ${v.account?.plan ?? '?'}  credits: ${v.account?.credits ?? '?'}\nAPI key saved to ${saved.path} (owner-only, never printed).`)
      return
    } catch (e) {
      if (interactive && attempt < 3 && isVivideoError(e) && e.code === 'invalid_code') {
        code = await prompt('Wrong or expired code. Try again: ')
        continue
      }
      throw e
    }
  }
}

// ---------------------------------------------------------------- helpers

function saveKey(ctx: OutputCtx, key: string): { path: string; envOverride: boolean } {
  const path = saveConfig({ apiKey: key })
  const envOverride = !!process.env.VIVIDEO_API_KEY && process.env.VIVIDEO_API_KEY !== key
  if (envOverride && !ctx.json) process.stderr.write('! VIVIDEO_API_KEY is set and takes precedence over the saved key; unset it to use the new one.\n')
  return { path, envOverride }
}

function announce(ctx: OutputCtx, c: { checkout_id: string; checkout_url: string; expires_at?: number | string }, resume: string, timeoutSec: number): void {
  if (ctx.json) {
    // Machine-readable early event on stderr so an agent can show the link while stdout waits for the final result.
    process.stderr.write(JSON.stringify({ event: 'checkout_created', checkout_id: c.checkout_id, checkout_url: c.checkout_url, expires_at: c.expires_at, resume }) + '\n')
    return
  }
  process.stdout.write(`Pay here (Stripe, the only step that needs a person):\n  ${c.checkout_url}\n`)
  if (!ctx.quiet) process.stderr.write(`Waiting for payment… polling every ${MIN_STATUS_POLL_MS / 1000} s, up to ${fmtWait(timeoutSec)}. Ctrl-C is safe; resume with: ${resume}\n`)
}

function progress(ctx: OutputCtx): ((s: { status: string }) => void) | undefined {
  if (ctx.json || ctx.quiet) return undefined
  let last = ''
  return (s) => {
    if (s.status !== last) process.stderr.write(`… ${s.status}\n`)
    last = s.status
  }
}

function note(ctx: OutputCtx, msg: string): void {
  if (!ctx.json && !ctx.quiet) process.stderr.write(`! ${msg}\n`)
}

function usage(ctx: OutputCtx, msg: string): void {
  if (ctx.json) process.stdout.write(JSON.stringify({ error: { code: 'usage', kind: 'usage', message: msg } }, null, 2) + '\n')
  else process.stderr.write(`✗ ${msg}\n`)
  process.exit(EXIT.usage)
}

function openBrowser(ctx: OutputCtx, url: string): void {
  if (!/^https?:\/\//i.test(url)) return
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' })
    child.on('error', () => note(ctx, 'Could not open a browser; open the link above.'))
    child.unref()
  } catch {
    note(ctx, 'Could not open a browser; open the link above.')
  }
}

function fmtWait(sec: number): string {
  return sec < 120 ? `${sec} s` : `${Math.round(sec / 60)} min`
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9@._+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

function toInt(v: string): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : NaN
}
