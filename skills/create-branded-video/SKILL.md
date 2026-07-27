---
name: create-branded-video
description: Create an on-brand Vivideo video using a brand kit (logo, colors, fonts). Use when the user wants the video to match their company/brand styling.
---

# Create a branded video

A **brand kit** applies a logo, color palette, fonts and motion style to an auto-mode video. Brand kits work with **auto mode only**.

## Workflow
1. `check_configuration` → `check_account` (must be premium with credits).
2. **Find the brand kit.** Call `list_brand_kits`. Each item has a `brand_ref` (e.g. `br_1a2b3c4d`) and a `name`. Pick the one the user means.
   - If the account has **no brand kit**, they must create one first (in the Vivideo app, or `POST /v1/brand-kits` / `POST /v1/brand-kits/from-url` via the CLI/API). Don't invent a `brand_ref`.
3. **Create the video** with `create_auto_video`, passing `brand_kit_id: "<brand_ref>"` plus the `prompt` (and optionally `avatar_id`, `voice_id`, `orientation`).
4. **Wait** with `wait_for_video`, then return `video_url` when `status` is `completed`.

## Notes
- The brand kit is applied automatically — you don't pass colors/fonts per request, only the `brand_kit_id`.
- Manual mode does **not** take a brand kit. If the user wants both a specific model *and* branding, use auto mode with the brand kit.
- Follow `generate-video-from-prompt` for the create → wait → result mechanics and error handling.
