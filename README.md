# Vivideo Toolchain

The developer + agent integration layer for the [Vivideo API](https://developers.vivideo.ai) — a shared client, an MCP server, a CLI, and Skills. **Agents are a primary user, not an afterthought.**

Everything sits *on top of* the public API (the source of truth). No backend business logic is duplicated here — the toolchain only adds client-side ergonomics and guardrails.

```
vivideo-toolchain/            npm workspaces monorepo (TypeScript)
├── packages/core   @vivideo/core   one typed API client + guardrails (shared), plus the V3 sign-up/checkout client
├── packages/mcp    @vivideo/mcp    MCP server (stdio) — 19 agent tools (13 video + 6 sign-up/payment)
├── packages/cli    @vivideo/cli    `vivideo` CLI — humans, scripts, CI, agents
├── skills/                          reusable agent Skills (SKILL.md)
└── docs/                            installation, configuration, workflows
```

## Architecture

One client, one set of types, derived from [`packages/core/openapi.yaml`](packages/core/openapi.yaml). The MCP server and CLI both call `@vivideo/core` — there is exactly **one** representation of each request/response, so the tools, CLI, docs and OpenAPI stay consistent.

`@vivideo/core` adds only client-side concerns, never business logic:

| Guardrail | What it does |
|---|---|
| **Rate limiting** | Token-bucket cap on request rate (default 8/s) — the client can't *become* a request flood. |
| **Concurrency cap** | Semaphore limits in-flight requests (default 4). |
| **Bounded retries** | Retries only `retryable` failures, with full-jitter backoff, capped attempts. |
| **Honors `Retry-After`** | On 429 it waits the API-specified delay before retrying. |
| **Idempotency** | Every video-create sends an `Idempotency-Key`; retries reuse it → no duplicate charges. |
| **Timeouts** | Per-request `AbortController` timeout (default 30s). |
| **Safe waiting** | `waitForVideo` polls at the API's suggested interval, with a hard timeout — never a `while(true)`. |
| **Secret redaction** | API keys, signing secrets, sign-up claim tokens and login codes are stripped from every log, error, and output. |
| **Payment waits** | `waitForSignup` / `waitForCheckout` poll at most every 10 s with a hard timeout. |

These complement — and never bypass — the API's own auth, rate limits, idempotency, credit checks, premium gates, ownership and error model.

## Quick start

No key yet? The CLI gets one; the Stripe payment page is the only step a person does ([agent sign-up](docs/agent-signup.md)):

```bash
node packages/cli/dist/index.js signup --email you@example.com --plan pro --period weekly --open   # new email
node packages/cli/dist/index.js login --email you@example.com                                     # existing account
```

```bash
# from the repo (until packages are published to npm)
npm install
npm run build

# authenticate (stored 0600 in ~/.vivideo/config.json), or use VIVIDEO_API_KEY
export VIVIDEO_API_KEY="vv_live_..."   # from https://app.vivideo.ai/account/api-keys

# CLI
node packages/cli/dist/index.js account
node packages/cli/dist/index.js create auto --prompt "A 20s product teaser" --wait

# MCP server (stdio) — point an MCP client at this command
node packages/mcp/dist/index.js
```

Once published: `npm i -g @vivideo/cli` (gives `vivideo`), and `npx @vivideo/mcp` for the server.

## Docs

- [Agent sign-up and payment — new account, email code, checkout (CLI + MCP)](docs/agent-signup.md)
- [MCP server — install, configure, connect to clients, tool reference](docs/mcp.md)
- [CLI — install, auth, command reference, JSON & non-interactive use, exit codes](docs/cli.md)
- [Skills — install & use](skills/README.md)
- [Workflows — human & agent, end to end](docs/workflows.md)
- [Security, rate limits, idempotency, credits & premium, troubleshooting](docs/guide.md)

## Authentication & security

- Keys are read from (in order): explicit option → `VIVIDEO_API_KEY` env → `~/.vivideo/config.json` (written owner-only `0600`). `vivideo signup` / `vivideo login` and the MCP sign-up tools save new keys there.
- The sign-up, login and checkout routes use the V3 API (`https://v3.api.vivideo.ai`, override with `VIVIDEO_V3_BASE_URL`).
- The key is **never printed** — all output passes through secret redaction; `configure` stores it without echoing it.
- Keys are account-scoped secrets. Keep them server-side; one per integration so a leak is revocable in isolation.

## Not included (honest scope)

- **Cancellation** — the public API has no cancel endpoint, so no cancel tool/command is offered. Failed/stuck renders are auto-refunded by the API.
- **Agent/chat mode** — not exposed by the public API, so not in the toolchain.
- Nothing here publishes to npm, provisions DNS, or deploys — those are external steps (see the final section of [docs/mcp.md](docs/mcp.md)).

## Development

```bash
npm run build       # build all three packages (tsc -b)
npm run typecheck   # type-check the whole workspace
npm test            # vitest
```

Requires Node ≥ 18.17.
