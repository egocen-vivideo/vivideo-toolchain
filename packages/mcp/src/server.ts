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

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'vivideo', version: VERSION })
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
