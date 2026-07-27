/**
 * Vivideo MCP server (stdio). Registers the tools in tools.ts and speaks the
 * Model Context Protocol over stdin/stdout — the transport every local MCP
 * client (Claude Desktop, Cursor, etc.) uses.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { TOOLS } from './tools.js'

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'vivideo', version: '1.0.0' })
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
