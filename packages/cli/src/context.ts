/**
 * Shared CLI helpers: build a client from global options and run a command with
 * uniform error handling + exit codes.
 */
import { VivideoClient, VivideoV3Client } from '@vivideo/core'
import { die, type OutputCtx } from './output.js'

export interface GlobalOpts {
  json?: boolean
  quiet?: boolean
  input?: boolean // commander sets `input:false` for --no-input
  yes?: boolean
  apiKey?: string
  baseUrl?: string
  v3BaseUrl?: string
}

export function outputCtx(g: GlobalOpts): OutputCtx {
  return { json: !!g.json, quiet: !!g.quiet }
}

export function makeClient(g: GlobalOpts): VivideoClient {
  return new VivideoClient({ apiKey: g.apiKey, baseUrl: g.baseUrl, userAgent: 'vivideo-cli/1.0' })
}

/** The V3 client (agent sign-up, login code, checkout). Builds without a key. */
export function makeV3Client(g: GlobalOpts): VivideoV3Client {
  return new VivideoV3Client({ apiKey: g.apiKey, baseUrl: g.v3BaseUrl, userAgent: 'vivideo-cli/1.1' })
}

/** Non-interactive when --json, --no-input, --yes, or not a TTY (CI/agents). */
export function nonInteractive(g: GlobalOpts): boolean {
  return !!g.json || g.input === false || !!g.yes || !process.stdin.isTTY
}

/** Wrap a command body so any thrown error becomes a clean, coded exit. */
export async function run(g: GlobalOpts, body: (client: VivideoClient, ctx: OutputCtx) => Promise<void>): Promise<void> {
  const ctx = outputCtx(g)
  try {
    await body(makeClient(g), ctx)
  } catch (e) {
    die(ctx, e)
  }
}

/** Like run(), for commands on the V3 client (no key needed to start). */
export async function runV3(g: GlobalOpts, body: (client: VivideoV3Client, ctx: OutputCtx) => Promise<void>): Promise<void> {
  const ctx = outputCtx(g)
  try {
    await body(makeV3Client(g), ctx)
  } catch (e) {
    die(ctx, e)
  }
}
