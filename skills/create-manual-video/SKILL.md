---
name: create-manual-video
description: Create a Vivideo video by calling a specific model directly (manual mode) — Veo, Sora, Kling, Seedance, etc. Use when the user names a model or wants image-to-video / precise control over resolution, duration, aspect ratio.
---

# Create a manual-mode video

Manual mode sends your prompt straight to one model. Use it when the user picks a model or needs image-to-video.

## Workflow
1. `check_configuration` → `check_account` (premium + credits).
2. **Choose a model and read its options.** Call `list_models` with `mode: "manual"`. Each model lists exactly what it accepts:
   - `operations` (text_to_video, image_to_video, first_last_frame, multiple_images)
   - `durations`, `resolutions`, `aspect_ratios`, `styles`
   - `credits_per_second` (for `estimate_credits`)
   **Only use values from that model's lists.** An invalid `resolution`/`duration_seconds`/`aspect_ratio`/`style` returns a `400 invalid_request` whose `details.allowed` lists the valid values — read it and retry with a valid value.
3. **(Optional) estimate** with `estimate_credits` (`mode: "manual"`, the `model`, `duration_seconds`, `resolution`).
4. **Create** with `create_manual_video`: `model`, `prompt`, and the validated `duration_seconds`/`resolution`/`aspect_ratio`.
   - The **operation is inferred from inputs**: add `image_url` (public https) for image-to-video. Don't pass an `operation` field — it doesn't exist.
5. **Wait** with `wait_for_video`; return `video_url` when `completed`.

## Rules
- Manual mode has **no** avatar/voice/brand-kit — those are auto-mode only.
- `image_url` must be a public https URL. If the user has a local file, upload it first (`POST /v1/uploads` → use the returned `public_url`).
- On `400 invalid_request`, fix the field named in `details` and retry — do not keep sending the same invalid value.
- Follow `generate-video-from-prompt` for wait/result/error mechanics.
