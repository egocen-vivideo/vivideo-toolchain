# Guide: security, limits, idempotency, credits, troubleshooting

## Authentication & security

- **Precedence:** explicit option → `VIVIDEO_API_KEY` env → `~/.vivideo/config.json` (owner-only `0600`).
- **Never logged:** all output (results, errors, debug) passes through secret redaction; `vv_live_…` and `whsec_…` tokens, sign-up claim tokens and 6-digit login codes are stripped. `configure`, `signup` and `login` store the key without echoing it.
- **Claim tokens** (pay-first sign-up) are the only way to the new key: kept in `~/.vivideo/claims.json` (`0600`), sent only as the `X-Claim-Token` header, never in a URL or output. See [agent sign-up](agent-signup.md).
- **Handle keys like passwords:** server-side only; one key per integration so a leak is revocable in isolation; rotate by creating a new key, migrating, then revoking the old one.

## Rate limits & guardrails

The API rate-limits per key and per account (429 with `Retry-After`). The toolchain adds **client-side** guardrails so it never becomes the attacker:

- **Token bucket** caps sustained request rate; **semaphore** caps concurrency.
- **Retries** only fire on `retryable` errors (429, 5xx, network) with full-jitter backoff, a bounded attempt count, and honoring `Retry-After`.
- **Safe polling:** `wait_for_video` polls at the API-suggested `poll_interval_seconds`, never faster, with a hard timeout.

If you hit `rate_limited`, slow your own loop — don't fan out parallel creates. The client already backs off; adding your own tight retry loop on top defeats it.

## Idempotency

Video creation is the only charged, non-idempotent-by-nature operation, so:

- Every create sends an `Idempotency-Key`. Retries reuse it → the API replays the original response instead of creating/charging a second video.
- Pass your own stable key (`idempotency_key` tool arg / `--idempotency-key` flag) when a retry might span process restarts.
- A `409 duplicate_request` means an identical create is already in flight — adopt `details.existing_video_id`, don't retry.

## Credits & premium

- Rendering needs `premium: true` and enough `credits` (see `check_account`).
- `estimate_credits` gives a pre-flight estimate from published rates; the **authoritative** cost is `credits_charged` on the create response. Failed renders are **refunded**.
- Credits/upgrades are bought on a Stripe page: in the **web app**, or with `vivideo checkout` / `start_checkout`, which return a Stripe link for a person to pay. The toolchain never charges by itself.
- Free accounts get **one preview** (a blurred sample, not a render); after upgrading, `render_preview` renders it (first video free).

## Errors

One envelope everywhere: `{ error: { code, kind, message, retryable, request_id, retry_after_seconds?, details?, links? } }`.

| kind | retry? | do |
|---|---|---|
| `auth` | no | set a valid key |
| `insufficient_credits` | no | `links.buy_credits` |
| `upgrade_required` | no | `links.upgrade` |
| `rate_limited` | yes (after `retry_after_seconds`) | slow down |
| `duplicate` | no | use `details.existing_video_id` |
| `invalid_request` | after fixing input | read `details.allowed` |
| `not_found` | no | check the id |
| `conflict` | no | e.g. `account_exists` → login code; `has_subscription`; `key_limit_reached` → revoke a key |
| `forbidden` | no | refused (e.g. `not_allowed`, `account_unavailable`); contact support |
| `server` / `network` | yes (bounded, backoff) | client retries; then surface |

Always keep `request_id` for support. See the `handle-limits-and-errors` and `troubleshoot-failed-generations` skills.

## Troubleshooting

- **"No API key configured"** → set `VIVIDEO_API_KEY`, run `vivideo configure`, or get a key with `vivideo signup` (new email) / `vivideo login --email` (existing account).
- **`account_exists` on sign-up** → the email has an account; paying never opens it. Use the 6-digit code: `vivideo login --email …`.
- **`signup status` says "No claim token"** → the sign-up started elsewhere; pass `--claim-token` or set `VIVIDEO_CLAIM_TOKEN`.
- **CLI exits non-zero with `--wait`** → exit 8 means the render didn't finish before the timeout (not a failure); check `vivideo status <id>` later.
- **`preview` instead of a video** → free account; upgrade, then `vivideo render <id>` / `render_preview`.
- **`invalid_request` on manual create** → the `resolution`/`duration`/`aspect_ratio`/`style` isn't valid for that model; `details.allowed` lists what is. Get valid values from `list_models`.
