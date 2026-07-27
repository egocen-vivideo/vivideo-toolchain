# Workflows

End-to-end flows for humans and agents. Both use the same API through the CLI or MCP tools.

## Human — make a video (CLI)

```bash
export VIVIDEO_API_KEY=vv_live_...
vivideo account                                  # confirm premium + credits
vivideo avatars --search maya                     # pick an avatar id (optional)
vivideo voices --language English --limit 5       # pick a voice id (optional)
vivideo create auto \
  --prompt "A friendly 20-second intro to our meal-planning app" \
  --avatar <avatar_id> --voice <voice_id> --wait   # blocks (safely) until done
# → prints video_url when completed; exit 0
```

## Agent — the canonical workflow (MCP)

An agent completes this without guessing:

1. `check_configuration` → if `configured:false`, ask the user to set `VIVIDEO_API_KEY` and stop.
2. `check_account` → read `plan`, `premium`, `credits`, `links`.
3. Discover as needed: `list_models` / `list_avatars` / `list_voices` / `list_brand_kits`.
4. `estimate_credits` → compare to `credits`; if short, route to `links.buy_credits` / `links.upgrade`.
5. `create_auto_video` (or `create_manual_video`) with explicit fields **and an `idempotency_key`**.
   - `status:"processing"` → step 6. `status:"preview"` → free account; show `preview.upgrade_url`, stop.
6. `wait_for_video` with a timeout.
   - `timed_out:false` → act on terminal status. `timed_out:true` → tell the user it's still processing; check again later.
7. On `completed`, return `video_url`. On `failed`, explain `error.message` (credits refunded).
8. On any error, follow the `handle-limits-and-errors` skill: branch on `code`/`kind`, honor `retry_after_seconds`, give `links.*`.

This is exactly what the [Skills](../skills/README.md) encode.

## Free-account (upgrade) flow

1. A free account's `create_auto_video` returns `status:"preview"` with `preview.image_url` (blurred) and `preview.upgrade_url`.
2. After the user upgrades in the web app, call `render_preview` with the same video `id` — it renders the same project (first video free), then `wait_for_video`.

## Manual image-to-video

1. Upload the image: `POST /v1/uploads` (or `vivideo` API) → use the returned `public_url`.
2. `create_manual_video` with `model`, `prompt`, and `image_url: <public_url>` → the operation becomes image-to-video automatically.
