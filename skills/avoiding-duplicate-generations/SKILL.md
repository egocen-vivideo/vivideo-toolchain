---
name: avoiding-duplicate-generations
description: Prevent duplicate Vivideo video creations (and duplicate charges) when retrying or when multiple steps might submit the same request. Use whenever creating a video in a retryable or automated flow.
---

# Avoid duplicate generations

Creating a video costs credits. Retries, parallel steps, or re-runs can accidentally create the same video twice. Prevent it.

## Use an idempotency key
- When you call `create_auto_video` / `create_manual_video` (or `POST /v1/videos`), pass a **stable** `idempotency_key` that is unique to *this logical request* (e.g. derived from the user request id or a hash of the inputs).
- If the create is retried with the **same** key, the API replays the original response instead of making a second video — no duplicate, no double charge.
- Reuse the same key across all retries of one attempt; use a **new** key for a genuinely new request.

## Handle the 409
- If you didn't send a key and fire the same content twice, the second call returns `409 duplicate_request` with `details.existing_video_id` — use that existing video instead of retrying.
- `idempotency_in_flight` means a request with that key is still processing — wait briefly and check status; don't hammer.

## Rules
- ✅ One idempotency key per logical create; reuse on retry.
- ✅ On 409, adopt the existing video id — don't create again.
- ❌ Don't loop-create hoping one succeeds; that risks multiple charges.
- ❌ Don't generate a fresh key on every retry — that defeats the protection.
