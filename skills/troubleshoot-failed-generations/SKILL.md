---
name: troubleshoot-failed-generations
description: Diagnose and recover from a failed or stuck Vivideo video generation. Use when a video's status is failed, or a render seems stuck, or a create call returned an error.
---

# Troubleshoot failed generations

## A video came back `status: "failed"`
- The render failed server-side. `error.message` explains why; `error.credits_refunded` is normally `true` (you weren't charged for a failure).
- Recovery: adjust the `prompt` (clearer, less ambiguous, policy-safe) and create again. For manual mode, try a different `model` or lower `resolution`/`duration`.
- Don't retry the identical failing request expecting a different result.

## A create call returned an error (not a video)
- Read the structured error and follow `handle-limits-and-errors`:
  - `invalid_request` → fix the field in `details` (e.g. an unsupported `resolution` — `details.allowed` lists valid values).
  - `unknown_model` → pick a valid id from `list_models`.
  - `insufficient_credits` / `upgrade_required` → route to the `links.*` URL.

## A render seems stuck (`processing` for a long time)
- Use `wait_for_video` with a timeout instead of polling forever. If it times out, the render is genuinely still going — check again later with `get_video`.
- If it never reaches a terminal state after a long time, the API has an internal stuck-render safety net that fails + refunds it; the status will flip to `failed` and credits return.

## Always
- Keep the `request_id` from the error for support.
- Never claim success until `get_video`/`wait_for_video` returns `completed`.
- Never expose or log the API key while debugging.
