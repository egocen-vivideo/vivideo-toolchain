/**
 * Vivideo MCP server (stdio). Registers the tools in tools.ts and speaks the
 * Model Context Protocol over stdin/stdout — the transport every local MCP
 * client (Claude Desktop, Cursor, etc.) uses.
 */
import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { TOOLS } from './tools.js'

// Read the version from package.json so the server's advertised version never
// drifts from the published package version.
const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version as string

export const INSTRUCTIONS = [
  'Vivideo makes AI videos. Call check_configuration first.',
  'No API key yet:',
  '- A NEW email: call start_signup {email, plan, period} and SHOW the returned checkout_url to your user; paying on that',
  '  Stripe page is the only step a person must do. Then call get_signup_status (wait_seconds up to 300). On "ready" the key',
  '  is saved and every tool uses it.',
  '- account_exists (or needs_code): the email already has an account. Call request_login_code, ask your user for the',
  '  6-digit code from their inbox, then verify_login_code. Payment never opens an existing account.',
  'Buying later: start_checkout (plan + period, or credits) returns a link for your user; then get_checkout.',
  'Secrets: claim tokens and API keys stay inside this server and ~/.vivideo (0600). Never ask your user for an API key',
  'in chat, never print or log one, and never put a key or claim token in a URL.',
  'Making videos: check_account, then create_auto_video or create_manual_video, then wait_for_video.',
].join('\n')

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'vivideo', version: VERSION }, { instructions: INSTRUCTIONS })
  for (const t of TOOLS) {
    // (name, description, zodRawShape, handler) — the stable tool() signature.
    server.tool(t.name, t.description, t.schema, async (args: Record<string, unknown>) => {
      return t.handler(args ?? {})
    })
  }
  return server
}

export async function main(): Promise<void> {
  const server = buildServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // stderr is safe for logs; stdout is the protocol channel — never write to it.
  process.stderr.write('[vivideo-mcp] ready — ' + TOOLS.length + ' tools\n')
}
