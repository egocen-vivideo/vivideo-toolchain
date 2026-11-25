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

The video tools need a `VIVIDEO_API_KEY` in the server's environment (a key from https://app.vivideo.ai/account/api-keys). The server starts without one: `check_configuration` reports `configured: false`, and the sign-up tools can get a key. `start_signup` is for a new email (the user pays on a Stripe link). `request_login_code` + `verify_login_code` are for an existing account. The new key is saved to `~/.vivideo/config.json` (`0600`) and used right away. If a key is already configured, the server replaces it only for a flow it started itself; otherwise the result is `key_issued_not_saved`. See [agent sign-up](agent-signup.md).

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
| `start_signup` | **No key needed.** New email: returns a Stripe `checkout_url` to show the user. `account_exists` → use the code tools. |
| `get_signup_status` | **No key needed.** `pending` / `ready` (key saved + active) / `needs_code` / `claimed` / `expired` / `failed`. `wait_seconds` ≤ 300. |
| `request_login_code` | **No key needed.** Existing account: emails a 6-digit code. |
| `verify_login_code` | **No key needed.** Code → new key, saved and active. Never returned. |
| `start_checkout` | Buy a plan (`plan` + `period`) or `credits`: returns a link for the user. |
| `get_checkout` | `pending` / `paid` / `expired` / `failed`. `wait_seconds` ≤ 300. |

Inputs are explicit and described (see the tool schemas). Responses are compact — large catalogues support `search`/`limit`.

## Reliability for agents

- **Long-running generation is safe:** create returns immediately with an id; `wait_for_video` is bounded and returns `timed_out: true` (with the latest status) instead of blocking forever.
- **Guardrails:** the shared client rate-limits, caps concurrency, retries only retryable errors with backoff, honors `Retry-After`, and sends idempotency keys on creates — so an agent in a loop can't flood the API.
- **No secrets in output.** API keys and sign-up claim tokens never appear in a tool result. The server keeps claim tokens in memory and in `~/.vivideo/claims.json` (`0600`).
- **Payment waits are polite:** status tools poll at most once per 10 s per checkout, even when an agent calls them in a loop.
- **Server instructions** (sent at `initialize`) tell the agent the sign-up flow: a new email → `start_signup` and show the link; `account_exists` → the login code from the user's inbox; keep keys and claim tokens secret.

## External steps remaining

- Publishing `@vivideo/mcp` to npm (so `npx @vivideo/mcp` works for everyone) is a manual `npm publish` — not done from repository access.
