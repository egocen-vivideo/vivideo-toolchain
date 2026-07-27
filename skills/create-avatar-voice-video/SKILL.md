---
name: create-avatar-voice-video
description: Create a Vivideo video with a specific avatar (presenter) and voice. Use when the user names a presenter/spokesperson or a particular voice/language.
---

# Create a video with a specific avatar and voice

Auto mode can use a chosen **avatar** (the on-screen presenter) and **voice**.

## Workflow
1. `check_configuration` → `check_account` (premium + credits).
2. **Pick the avatar.** Call `list_avatars` (optionally with `search` or `gender`). Each returns an `id` and whether it's `ready`. Use a `ready` avatar's `id`.
   - To create a brand-new avatar from a prompt/photo, that's a separate async flow (`POST /v1/avatars`, poll until `ready`) — only do it if the user asks.
3. **Pick the voice.** Call `list_voices` (filter by `language`/`gender`/`search`). Use a `voice_id`.
   - Preview a voice first with `POST /v1/voices/speech` (CLI/API) if the user is unsure — it returns a short audio sample. Cloning is not available.
4. **Create** with `create_auto_video`: `prompt`, `avatar_id`, `voice_id` (+ optional `orientation`, `brand_kit_id`).
5. **Wait** with `wait_for_video`; return `video_url` when `completed`.

## Rules
- Use ids from the list tools — **never invent** an `avatar_id` or `voice_id`.
- Avatar and voice are **auto-mode** parameters; manual mode does not use them.
- For create → wait → result mechanics and errors, follow `generate-video-from-prompt`.
