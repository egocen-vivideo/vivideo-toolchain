---
name: handle-limits-and-errors
description: Correctly handle Vivideo API errors — rate limits, insufficient credits, premium requirements, duplicates, and retries. Use whenever a Vivideo tool/command returns an error.
---

# Handle Vivideo errors, limits & retries

Every Vivideo error is structured: `{ error: { code, kind, message, retryable, request_id, retry_after_seconds?, details?, links? } }`. **Branch on `code`/`kind`, never on message text.** Keep `request_id` for support.

## By kind

- **`rate_limited`** (HTTP 429) — you're sending too fast.
  - Wait `retry_after_seconds`, then retry the *same* request. The client already backs off, but if you see this, slow your own loop down. Don't fan out parallel calls.

- **`insufficient_credits`** (402) — not enough credits.
  - Not retryable. Tell the user to buy credits at `links.buy_credits`. Don't retry the create.

- **`upgrade_required`** / **`free_limit_reached`** (403) — needs a premium plan (or the one free video is used).
  - Not retryable. Give `links.upgrade`. A free account's create returns a `preview` instead of rendering — see `render_preview` after they upgrade.

- **`duplicate`** (`duplicate_request` / `idempotency_in_flight`, 409) — an identical create is already in flight.
  - Don't create again. Use the existing video (`details.existing_video_id` if present) or wait and check status. Send an `idempotency_key` to make retries safe — see `avoiding-duplicate-generations`.

- **`invalid_request`** (400, incl. `unknown_model`, `invalid_url`) — bad input.
  - Not retryable as-is. Read `details.allowed` / `details.field` and fix the input, then retry once with a valid value.

- **`auth`** (401) — missing/invalid/revoked key.
  - Not retryable. Ask the user to set a valid `VIVIDEO_API_KEY` / run `vivideo configure`.

- **`server`** (5xx / `upstream_error`) and **`network`** (timeout) — transient.
  - Retryable with backoff. The client retries a bounded number of times automatically; if it still fails, tell the user and keep the `request_id`.

## Retry rules
- Retry **only** when `retryable: true` (rate_limited, server, network).
- Honor `retry_after_seconds` on 429.
- Bounded attempts + exponential backoff (the client does this; don't add your own tight retry loop on top).
- Never retry `insufficient_credits`, `upgrade_required`, `auth`, or an unchanged `invalid_request`.

## Never
- ❌ Never surface a generic "something went wrong" — always give the `code` and the next step (a `links.*` URL when present).
- ❌ Never print or log the API key.
