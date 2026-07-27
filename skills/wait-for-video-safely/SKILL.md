---
name: wait-for-video-safely
description: Wait for a Vivideo render to finish without over-polling or blocking forever, and decide between polling and webhooks. Use after creating a video, or whenever tracking a video to completion.
---

# Wait for a video safely (polling vs webhooks)

Renders take seconds to a few minutes. Waiting badly (tight loops, no timeout) turns into a request flood and can hang an agent. Do it safely.

## Preferred: `wait_for_video`
- Call `wait_for_video` with the video `id` and a `timeout_seconds` (e.g. 300).
- It polls at the API's suggested `poll_interval_seconds` (never faster), up to the timeout.
- It returns `{ timed_out, video }`:
  - `timed_out: false` → `video.status` is terminal (`completed` / `failed` / `preview`). Act on it.
  - `timed_out: true` → still rendering. **Hand control back to the user** ("still processing, I'll check again shortly") and call `wait_for_video`/`get_video` again later. Don't busy-wait.

## If you must poll manually (`get_video`)
- Respect `poll_interval_seconds` from the response between calls.
- Cap total attempts / total time. Never `while(true)`.
- Treat `completed`, `failed`, and `preview` as stop conditions.

## Webhooks (for backends, not interactive agents)
- For a server that can receive HTTP, register a webhook (`POST /v1/webhooks`) and get a signed `video.completed` / `video.failed` event instead of polling.
- Use polling for interactive/agent flows; use webhooks for long-running backends.

## Never
- ❌ Never say the video is "done"/"ready" until the API returns `status: "completed"`.
- ❌ Never poll faster than `poll_interval_seconds`.
- ❌ Never block indefinitely — always have a timeout.
