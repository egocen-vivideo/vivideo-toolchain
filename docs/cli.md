# Vivideo CLI

`vivideo` — generate AI videos from the terminal, shell scripts, CI, or as a subprocess an agent drives.

## Install & authenticate

```bash
# from the repo
npm install && npm run build
alias vivideo="node $(pwd)/packages/cli/dist/index.js"

# once published
npm i -g @vivideo/cli
```

Provide a key one of three ways (highest precedence first):

```bash
vivideo --api-key vv_live_... account          # explicit flag (avoid in shared shells)
export VIVIDEO_API_KEY="vv_live_..."           # environment (best for CI/agents)
vivideo configure                              # interactive → stores 0600 in ~/.vivideo/config.json
vivideo configure --api-key vv_live_... --verify   # non-interactive + verify against the API
```

The key is stored owner-only and **never printed**. `vivideo config` shows where the key is read from (source + path) without revealing it.

## Commands

| Command | Description |
|---|---|
| `vivideo configure` | Store the API key securely. `--verify` checks it first. |
| `vivideo config` | Show config source/path (never the key). |
| `vivideo account` / `whoami` | Plan, premium, credits. |
| `vivideo models [--mode auto\|manual]` | List models. |
| `vivideo avatars [--search --gender --limit]` | List avatars. |
| `vivideo voices [--language --gender --search --limit]` | List voices. |
| `vivideo brand-kits` | List brand kits. |
| `vivideo estimate --mode <m> [--model --duration --resolution]` | Estimate credits. |
| `vivideo create auto --prompt <p> [--duration --avatar --voice --brand-kit --orientation --wait]` | Auto-generate a video. |
| `vivideo create manual --model <id> --prompt <p> [--duration --resolution --aspect-ratio --image-url --wait]` | Manual-mode video. |
| `vivideo status <id>` | A video's current status/result. |
| `vivideo wait <id> [--timeout <sec>]` | Wait for a terminal state. |
| `vivideo videos [--status --limit]` / `list` | List videos. |
| `vivideo render <id>` | Free accounts: render a preview after upgrading. |

Every command accepts the global flags: `--json`, `--quiet`, `--no-input`, `-y/--yes`, `--api-key`, `--base-url`.

## JSON & non-interactive (scripts, CI, agents)

- `--json` prints structured JSON to stdout (and implies non-interactive). Errors are printed as `{ "error": { code, kind, message, retryable, request_id, links } }`.
- `--no-input` / `-y` never prompt; a non-TTY (CI) is auto non-interactive.
- Provide the key via `VIVIDEO_API_KEY` so no prompt is needed.

```bash
# create + wait, machine-readable, fully non-interactive
export VIVIDEO_API_KEY=vv_live_...
vivideo --json create manual --model veo31_fast --prompt "waves at dusk" \
        --duration 4 --resolution 720p --wait --timeout 300
echo "exit: $?"
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | unknown / server error / render failed |
| 2 | usage error (bad flags) |
| 3 | auth / not configured |
| 4 | insufficient credits |
| 5 | rate limited |
| 6 | upgrade required (or free preview created) |
| 7 | not found |
| 8 | network / timeout (incl. `wait` timing out) |
| 9 | invalid request |
| 10 | duplicate request |

Scripts and agents branch on these instead of parsing text. Errors always show the stable `code` and a next step (a `links.*` URL when the API returns one) — never a generic "something went wrong".

## Idempotent retries

`create` accepts `--idempotency-key <key>`. Reuse the same key when retrying the same logical create so a retry never makes a second video. Without one, the client auto-generates a key per create call (safe within that call's own retries).
