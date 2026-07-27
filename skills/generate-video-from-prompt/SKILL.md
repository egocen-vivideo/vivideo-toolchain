---
name: generate-video-from-prompt
description: Generate a Vivideo AI video from a text prompt (auto mode) end-to-end — check credits, create, wait safely, and return the finished MP4. Use when a user asks to make/generate a video from a description.
---

# Generate a video from a prompt (auto mode)

Auto mode turns one prompt into a complete AI-avatar video (script, scenes, voiceover, captions). This is the default way to make a video.

## Which interface
- **Agent (MCP):** use the Vivideo MCP tools. This skill uses them by name.
- **Terminal/CI:** the `vivideo` CLI (`vivideo create auto --prompt "…" --wait --json`).
- Both call the same API. Never call the raw API if a tool/command exists.

## The reliable workflow

1. **Confirm auth.** Call `check_configuration`. If `configured` is false, tell the user to set `VIVIDEO_API_KEY` (a key from https://app.vivideo.ai/account/api-keys) and stop — do not guess a key.
2. **Check the account.** Call `check_account`. Rendering needs `premium: true` and enough `credits`. If not premium, follow the `handle-limits-and-errors` skill (upgrade). 
3. **(Optional) Estimate cost.** Call `estimate_credits` with `mode: "auto"` and the duration. Compare to `credits` from step 2. The estimate is not the charge — the create response returns the exact `credits_charged`.
4. **Create the video.** Call `create_auto_video` with an explicit `prompt` (and optional `duration_seconds`, `avatar_id`, `voice_id`, `brand_kit_id`, `orientation`).
   - Pass a stable `idempotency_key` if you might retry, so a retry never makes a second video.
   - The response returns a `status`:
     - `processing` → rendering started. Go to step 5.
     - `preview` → this is a **free account**. Nothing rendered. Show `preview.message` and the `preview.upgrade_url`. Do not claim a video was made.
5. **Wait for completion.** Call `wait_for_video` with the `id` and a `timeout_seconds` (e.g. 300). It polls safely at the API's suggested interval.
   - If it returns `timed_out: true`, the render is still going — tell the user it's still processing and offer to check again with `get_video`. **Do not** loop `get_video` yourself in a tight loop.
6. **Return the result.** When `status` is `completed`, give the user `video_url` (the MP4). Only now is the video done — never say "done" before the API reports `completed`.

## Failure handling
- `status: "failed"` → the render failed; `error.message` explains why and credits were refunded (`error.credits_refunded`). Suggest adjusting the prompt and retrying. See `troubleshoot-failed-generations`.
- Any tool that returns `isError` gives a structured error with `code`, `retryable`, and `links`. Branch on `code`/`kind`, never on message text. See `handle-limits-and-errors`.

## Do / don't
- ✅ Use explicit fields (avatar_id, voice_id) from `list_avatars` / `list_voices` — don't invent ids.
- ✅ Send an idempotency key when retrying.
- ❌ Don't poll faster than `poll_interval_seconds`.
- ❌ Don't report completion until `get_video`/`wait_for_video` returns `completed`.
