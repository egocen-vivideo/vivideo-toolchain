#!/usr/bin/env node
/**
 * vivideo — the Vivideo CLI. Works interactively, in scripts, in CI, and as a
 * subprocess for agents. `--json` gives structured output; exit codes are
 * meaningful (see output.ts); API keys are never printed.
 */
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { Command } from 'commander'
import {
  saveConfig, configPath, isConfigured, looksLikeKey, resolveConfig,
  waitForVideo, estimateCredits, redactDeep, type Video,
} from '@vivideo/core'
import { run, nonInteractive, makeClient, outputCtx, type GlobalOpts } from './context.js'
import { printResult, reportError } from './output.js'
import { registerAgentCommands } from './agent.js'

// Read the version from package.json so `--version` never drifts from the
// published package version.
const pkgVersion = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version as string

const program = new Command()
program
  .name('vivideo')
  .description('Vivideo CLI — generate AI videos from the terminal, scripts, CI, or agents.')
  .version(pkgVersion)
  .exitOverride() // throw CommanderError instead of exiting, so we control exit codes
  .option('--json', 'output structured JSON (implies non-interactive)')
  .option('--quiet', 'suppress non-essential output')
  .option('--no-input', 'never prompt (for CI/agents)')
  .option('-y, --yes', 'assume yes / non-interactive')
  .option('--api-key <key>', 'API key (prefer the VIVIDEO_API_KEY env var)')
  .option('--base-url <url>', 'override the API base URL')
  .option('--v3-base-url <url>', 'override the V3 API base URL (sign-up, login, checkout; env VIVIDEO_V3_BASE_URL)')

const g = (): GlobalOpts => program.opts()

// ---------------------------------------------------------------- configure
// `login` is registered in agent.ts: with --email it runs the code flow, without it this same action.
async function configureAction(opts: { apiKey?: string; verify?: boolean }): Promise<void> {
  const gg = g()
  const ctx = outputCtx(gg)
  let key = opts.apiKey || gg.apiKey || process.env.VIVIDEO_API_KEY
  if (!key && !nonInteractive(gg)) key = await prompt('Vivideo API key (vv_live_…): ')
  if (!key) {
    process.stderr.write('✗ No API key provided. Pass --api-key or set VIVIDEO_API_KEY.\n')
    process.exit(3)
  }
  if (!looksLikeKey(key)) process.stderr.write('! Warning: this does not look like a vv_live_ key.\n')
  if (opts.verify) {
    try {
      await makeClient({ ...gg, apiKey: key }).me()
    } catch (e) {
      process.exit(reportError(ctx, e))
    }
  }
  const path = saveConfig({ apiKey: key, baseUrl: gg.baseUrl })
  printResult(ctx, { saved: true, path }, () => `✓ Saved. Config: ${path}\n  The key is stored with owner-only permissions and never printed.`)
}

program
  .command('configure')
  .description('Store your API key securely in ~/.vivideo/config.json (0600).')
  .option('--api-key <key>', 'the key to store (else prompt / VIVIDEO_API_KEY)')
  .option('--verify', 'verify the key against the API before saving')
  .action(configureAction)

program
  .command('config')
  .description('Show where credentials are read from (never prints the key).')
  .action(() => {
    const gg = g()
    const ctx = outputCtx(gg)
    let source = 'none'
    try {
      source = resolveConfig({ apiKey: gg.apiKey }).source
    } catch { /* not configured */ }
    printResult(ctx, { configured: isConfigured({ apiKey: gg.apiKey }), source, config_path: configPath() },
      () => `configured: ${isConfigured({ apiKey: gg.apiKey })}\nsource: ${source}\nconfig file: ${configPath()}`)
  })

// ---------------------------------------------------------------- account
program
  .command('account')
  .alias('whoami')
  .description('Show your plan, premium status and credit balance.')
  .action(() => run(g(), async (client, ctx) => {
    const a = await client.me()
    printResult(ctx, a, () =>
      `plan: ${a.plan}${a.premium ? ' (premium)' : ''}\ncredits: ${a.credits}\nfree video available: ${a.free_video_available}`)
  }))

// ---------------------------------------------------------------- discovery
program
  .command('models')
  .description('List available models (manual) and the auto pipeline.')
  .option('--mode <mode>', 'filter: auto | manual')
  .action((opts) => run(g(), async (client, ctx) => {
    const { data } = await client.listModels()
    const rows = opts.mode ? data.filter((m) => m.mode === opts.mode) : data
    printResult(ctx, { object: 'list', count: rows.length, data: rows }, () =>
      rows.map((m) => `${pad(m.id, 20)} ${pad(m.mode, 7)} ${m.requires_premium ? 'premium' : 'free   '} ${(m.resolutions || []).join(',')}`).join('\n'))
  }))

program
  .command('avatars')
  .description('List avatars for auto-mode videos.')
  .option('--search <q>', 'filter by name')
  .option('--gender <g>', 'male | female | unspecified')
  .option('--limit <n>', 'max results', (v) => parseInt(v, 10), 20)
  .action((opts) => run(g(), async (client, ctx) => {
    const res = await client.listAvatars({ search: opts.search, gender: opts.gender, limit: opts.limit })
    const data = (res.data ?? []).slice(0, opts.limit)
    printResult(ctx, { object: 'list', data, owned: res.owned ?? [] }, () =>
      data.map((x) => `${pad(x.id ?? '', 34)} ${x.name ?? ''}`).join('\n') || '(none)')
  }))

program
  .command('voices')
  .description('List voices for auto-mode videos.')
  .option('--language <l>', 'e.g. English')
  .option('--gender <g>')
  .option('--search <q>')
  .option('--limit <n>', 'max results', (v) => parseInt(v, 10), 20)
  .action((opts) => run(g(), async (client, ctx) => {
    const res = await client.listVoices({ language: opts.language, gender: opts.gender, search: opts.search, limit: opts.limit })
    const data = (res.data ?? []).slice(0, opts.limit)
    printResult(ctx, { object: 'list', total_public: res.total_public, data }, () =>
      data.map((v) => `${pad(v.voice_id, 34)} ${pad(v.language ?? '', 12)} ${v.name ?? ''}`).join('\n') || '(none)')
  }))

program
  .command('brand-kits')
  .description('List your brand kits.')
  .action(() => run(g(), async (client, ctx) => {
    const res = await client.listBrandKits()
    printResult(ctx, res, () => (res.data ?? []).map((b) => `${pad(b.brand_ref, 16)} ${b.name ?? ''}`).join('\n') || '(none)')
  }))

program
  .command('estimate')
  .description('Estimate credits for a generation (not a charge).')
  .requiredOption('--mode <mode>', 'auto | manual')
  .option('--model <id>', 'model id (manual)')
  .option('--duration <sec>', 'duration in seconds', (v) => parseInt(v, 10))
  .option('--resolution <res>', 'resolution (manual)')
  .action((opts) => run(g(), async (client, ctx) => {
    const { data } = await client.listModels()
    const est = estimateCredits(data, { mode: opts.mode, model: opts.model, duration_seconds: opts.duration, resolution: opts.resolution })
    printResult(ctx, est, () => `estimated credits: ${est.credits ?? 'unknown'}\n${est.note}`)
  }))

// ---------------------------------------------------------------- create
const create = program.command('create').description('Create a video (auto or manual mode).')

create
  .command('auto')
  .description('Auto-generate a complete avatar video from a prompt.')
  .requiredOption('--prompt <text>', 'what the video should show/say')
  .option('--duration <sec>', '5–300 (default 30)', (v) => parseInt(v, 10))
  .option('--avatar <id>', 'avatar_id (see `vivideo avatars`)')
  .option('--voice <id>', 'voice_id (see `vivideo voices`)')
  .option('--brand-kit <ref>', 'brand_ref (see `vivideo brand-kits`)')
  .option('--orientation <o>', 'landscape | portrait')
  .option('--folder <id>', 'folder_id')
  .option('--name <name>')
  .option('--idempotency-key <key>', 'reuse to make retries safe')
  .option('--wait', 'wait for the render to finish, then print the result')
  .option('--timeout <sec>', 'max wait with --wait (default 600)', (v) => parseInt(v, 10), 600)
  .action((opts) => run(g(), async (client, ctx) => {
    const v = await client.createVideo({
      mode: 'auto', prompt: opts.prompt, duration_seconds: opts.duration, avatar_id: opts.avatar,
      voice_id: opts.voice, brand_kit_id: opts.brandKit, orientation: opts.orientation, folder_id: opts.folder, name: opts.name,
    }, opts.idempotencyKey)
    await finishCreate(client, ctx, v, opts.wait, opts.timeout)
  }))

create
  .command('manual')
  .description('Create a video with a specific model.')
  .requiredOption('--model <id>', 'model id (see `vivideo models`)')
  .requiredOption('--prompt <text>')
  .option('--duration <sec>', 'must match the model', (v) => parseInt(v, 10))
  .option('--resolution <res>')
  .option('--aspect-ratio <ar>')
  .option('--image-url <url>', 'public https image → image-to-video')
  .option('--negative-prompt <text>')
  .option('--seed <n>', '', (v) => parseInt(v, 10))
  .option('--style <style>')
  .option('--folder <id>')
  .option('--name <name>')
  .option('--idempotency-key <key>')
  .option('--wait', 'wait for the render to finish')
  .option('--timeout <sec>', '', (v) => parseInt(v, 10), 600)
  .action((opts) => run(g(), async (client, ctx) => {
    const v = await client.createVideo({
      mode: 'manual', model: opts.model, prompt: opts.prompt, duration_seconds: opts.duration,
      resolution: opts.resolution, aspect_ratio: opts.aspectRatio, image_url: opts.imageUrl,
      negative_prompt: opts.negativePrompt, seed: opts.seed, style: opts.style, folder_id: opts.folder, name: opts.name,
    }, opts.idempotencyKey)
    await finishCreate(client, ctx, v, opts.wait, opts.timeout)
  }))

// ---------------------------------------------------------------- status / wait / list
program
  .command('status <id>')
  .description('Show a video\'s current status and result.')
  .action((id) => run(g(), async (client, ctx) => {
    const v = await client.getVideo(id)
    printResult(ctx, v, () => summarizeVideo(v))
  }))

program
  .command('wait <id>')
  .description('Wait for a video to reach a terminal state, then print it.')
  .option('--timeout <sec>', 'max wait (default 600)', (v) => parseInt(v, 10), 600)
  .action((id, opts) => run(g(), async (client, ctx) => {
    const { video, timedOut } = await waitForVideo(client, id, {
      timeoutMs: opts.timeout * 1000,
      onUpdate: ctx.json || ctx.quiet ? undefined : (v) => process.stderr.write(`… ${v.status}${v.progress?.percent != null ? ` ${v.progress.percent}%` : ''}\n`),
    })
    printResult(ctx, { timed_out: timedOut, video }, () => (timedOut ? `timed out — still ${video.status}` : summarizeVideo(video)))
    if (timedOut) process.exitCode = 8
  }))

program
  .command('videos')
  .alias('list')
  .description('List your videos, newest first.')
  .option('--status <s>', 'queued|processing|completed|failed|preview')
  .option('--limit <n>', '', (v) => parseInt(v, 10), 20)
  .action((opts) => run(g(), async (client, ctx) => {
    const res = await client.listVideos({ status: opts.status, limit: opts.limit })
    printResult(ctx, res, () => (res.data ?? []).map((v) => `${pad(v.id, 34)} ${pad(v.status, 11)} ${v.model ?? v.mode}`).join('\n') || '(none)')
  }))

program
  .command('render <id>')
  .description('Free accounts: render a "preview" video after upgrading.')
  .action((id) => run(g(), async (client, ctx) => {
    const v = await client.renderVideo(id)
    printResult(ctx, v, () => summarizeVideo(v))
  }))

// ---------------------------------------------------------------- sign-up / login / checkout
registerAgentCommands(program, g, configureAction, prompt)

program.parseAsync(process.argv).catch((e) => {
  // Commander parse errors (bad/missing flags, --help, --version) → usage/exit codes.
  const code = (e as { code?: string })?.code
  if (typeof code === 'string' && code.startsWith('commander.')) {
    const exitCode = (e as { exitCode?: number })?.exitCode
    process.exit(exitCode === 0 ? 0 : 2) // help/version → 0, usage error → 2
  }
  process.exit(reportError({ json: !!program.opts().json, quiet: false }, e))
})

// ---------------------------------------------------------------- helpers
async function finishCreate(client: ReturnType<typeof makeClient>, ctx: { json: boolean; quiet: boolean }, v: Video, wait?: boolean, timeoutSec?: number): Promise<void> {
  if (v.status === 'preview') {
    printResult(ctx, v, () =>
      `preview created (free account) — id: ${v.id}\n${v.preview?.message ?? ''}\n→ upgrade: ${v.preview?.upgrade_url ?? ''}`)
    process.exitCode = 6
    return
  }
  if (!wait) {
    printResult(ctx, v, () => `created — id: ${v.id}\nstatus: ${v.status}  credits_charged: ${v.credits_charged}\npoll with: vivideo wait ${v.id}`)
    return
  }
  const { video, timedOut } = await waitForVideo(client, v.id, {
    timeoutMs: (timeoutSec ?? 600) * 1000,
    onUpdate: ctx.json || ctx.quiet ? undefined : (u) => process.stderr.write(`… ${u.status}${u.progress?.percent != null ? ` ${u.progress.percent}%` : ''}\n`),
  })
  printResult(ctx, { timed_out: timedOut, video }, () => (timedOut ? `timed out — still ${video.status} (id ${video.id})` : summarizeVideo(video)))
  if (timedOut) process.exitCode = 8
  else if (video.status === 'failed') process.exitCode = 1
}

function summarizeVideo(v: Video): string {
  const lines = [`id: ${v.id}`, `status: ${v.status}`]
  if (v.credits_charged != null) lines.push(`credits_charged: ${v.credits_charged}`)
  if (v.status === 'completed' && v.video_url) lines.push(`video_url: ${v.video_url}`)
  if (v.status === 'failed' && v.error) lines.push(`error: ${v.error.message} (refunded: ${v.error.credits_refunded})`)
  if (v.status === 'preview') lines.push(`preview — upgrade: ${v.preview?.upgrade_url ?? ''}`)
  return lines.join('\n')
}

function pad(s: string, n: number): string {
  s = String(s ?? '')
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function prompt(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  return new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(a.trim()) }))
}

// keep the import used even if tree-shaken in some builds
void redactDeep
