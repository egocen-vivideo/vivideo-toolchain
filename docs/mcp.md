# Vivideo MCP server

An [MCP](https://modelcontextprotocol.io) server that gives AI agents reliable, structured tools for Vivideo video generation. Speaks MCP over **stdio** — the transport every local MCP client uses.

## Install & run

```bash
# from the repo
npm install && npm run build
node packages/mcp/dist/index.js       # starts the stdio server

# once published
npx @vivideo/mcp
```

The server needs a `VIVIDEO_API_KEY` in its environment (a key from https://app.vivideo.ai/account/api-keys). It starts even without one — `check_configuration` will report `configured: false` so an agent can tell the user what to do.

## Connect to a client

**Claude Desktop / Claude Code** — add to the MCP config:

```json
{
  "mcpServers": {
    "vivideo": {
      "command": "npx",
      "args": ["-y", "@vivideo/mcp"],
      "env": { "VIVIDEO_API_KEY": "vv_live_..." }
    }
  }
}
```

Or with the repo build, `"command": "node", "args": ["/abs/path/vivideo-toolchain/packages/mcp/dist/index.js"]`.

**Cursor** — same shape in `~/.cursor/mcp.json` (or project `.cursor/mcp.json`).

**Any MCP client** — run the command above; connect over stdio.

> The API key lives in the client's env config, never in a tool argument. The server never asks for, logs, or returns the key.

## Tools

All tools return structured JSON. Errors come back as a structured object (`isError: true`) with the API's `code`, `kind`, `retryable`, `request_id`, and next-step `links` — agents branch on those, never on prose.

| Tool | Purpose |
|---|---|
| `check_configuration` | Is a key configured? Call first. |
| `check_account` | Plan, premium, credit balance, upgrade/buy links. |
| `list_models` | Manual models + the `vivideo-auto` pipeline, with options & rates. |
| `list_avatars` | Avatars for auto mode (ids for `avatar_id`). |
| `list_voices` | Voices for auto mode (ids for `voice_id`). |
| `list_brand_kits` | Brand kits (`brand_ref` for `brand_kit_id`). |
| `estimate_credits` | Pre-flight cost estimate from published rates. |
| `create_auto_video` | Auto mode: full avatar video from a prompt. |
| `create_manual_video` | Manual mode: a specific model. |
| `get_video` | One video's status/result. |
| `wait_for_video` | Bounded, safe wait to a terminal state. |
| `list_videos` | The account's videos, newest first. |
| `render_preview` | Free accounts: render a `preview` after upgrading. |

Inputs are explicit and described (see the tool schemas). Responses are compact — large catalogues support `search`/`limit`.

## Reliability for agents

- **Long-running generation is safe:** create returns immediately with an id; `wait_for_video` is bounded and returns `timed_out: true` (with the latest status) instead of blocking forever.
- **Guardrails:** the shared client rate-limits, caps concurrency, retries only retryable errors with backoff, honors `Retry-After`, and sends idempotency keys on creates — so an agent in a loop can't flood the API.
- **No secrets in output.**

## External steps remaining

- Publishing `@vivideo/mcp` to npm (so `npx @vivideo/mcp` works for everyone) is a manual `npm publish` — not done from repository access.
