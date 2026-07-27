---
name: check-credits-before-generating
description: Verify a Vivideo account can afford a generation before creating it — check premium status and credit balance, estimate cost, and route the user to upgrade or buy credits if needed. Use before any video creation.
---

# Check credits & premium before generating

Rendering a video requires a **premium plan** and enough **credits**. Check this first so you don't hit a 402/403 mid-flow.

## Workflow
1. Call `check_account`. Read:
   - `premium` (boolean) — rendering requires `true`.
   - `credits` (number) — the balance.
   - `free_video_available` (boolean) — a free account gets exactly one preview (see below).
   - `links.upgrade` and `links.buy_credits`.
2. Call `estimate_credits` with the intended `mode`/`model`/`duration`/`resolution`. It returns an estimate (not the charge).
3. Decide:
   - **Not premium** → tell the user they need to upgrade; give `links.upgrade`. A free account can still create **one preview** (a blurred sample, not a rendered video).
   - **Premium but `credits` < estimate** → tell them to buy credits; give `links.buy_credits`. Don't attempt the create.
   - **Premium and `credits` ≥ estimate** → proceed to create.

## Important
- The estimate is approximate. The **authoritative** cost is `credits_charged` on the create response; failed renders are **refunded** automatically.
- Credits and upgrades are purchased in the Vivideo **web app**, not via the API/tools. Always hand the user the `links.*` URL rather than trying to charge them.
- If you skip this and get `402 insufficient_credits` or `403 upgrade_required`, follow `handle-limits-and-errors`.
