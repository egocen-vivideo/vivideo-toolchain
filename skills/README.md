# Vivideo Skills

Reusable, focused skills that teach AI agents (and humans working with agents) how to use Vivideo **correctly** — not just what the endpoints are. Each skill is a `SKILL.md` with `name` + `description` frontmatter and a practical, failure-aware workflow.

They use the [Vivideo MCP tools](../packages/mcp) and [CLI](../packages/cli) by name, and reference the real API / [OpenAPI spec](../packages/core/openapi.yaml). No invented parameters.

| Skill | Use it when |
|---|---|
| [generate-video-from-prompt](generate-video-from-prompt/SKILL.md) | Make a video from a text prompt (the canonical auto-mode workflow). |
| [create-branded-video](create-branded-video/SKILL.md) | The video must match a company/brand (brand kit). |
| [create-avatar-voice-video](create-avatar-voice-video/SKILL.md) | A specific presenter/avatar and voice are requested. |
| [create-manual-video](create-manual-video/SKILL.md) | A specific model, image-to-video, or precise resolution/duration control. |
| [check-credits-before-generating](check-credits-before-generating/SKILL.md) | Before any creation — confirm premium + credits, route to upgrade/buy. |
| [wait-for-video-safely](wait-for-video-safely/SKILL.md) | Track a render to completion without over-polling; polling vs webhooks. |
| [handle-limits-and-errors](handle-limits-and-errors/SKILL.md) | Any error: rate limits, credits, premium, duplicates, retries. |
| [avoiding-duplicate-generations](avoiding-duplicate-generations/SKILL.md) | Retryable/automated creates — idempotency to avoid double charges. |
| [troubleshoot-failed-generations](troubleshoot-failed-generations/SKILL.md) | A generation failed or seems stuck. |

## Installing skills

Skills are plain folders. Copy the ones you want into your agent's skills directory (for Claude: `~/.claude/skills/`, or a project `.claude/skills/`). The agent loads a skill when its `description` matches the task.

They assume the Vivideo MCP server is connected (or the `vivideo` CLI is installed) and a `VIVIDEO_API_KEY` is configured. See the [top-level README](../README.md).
