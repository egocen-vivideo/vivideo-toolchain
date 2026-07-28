/**
 * Vivideo MCP tools. Designed for reliable AGENT use:
 *   • explicit, structured inputs (zod) with clear field descriptions
 *   • structured JSON results — agents never parse prose
 *   • API error codes, retryable flag and next-step links preserved verbatim
 *   • long-running generation is safe: create returns fast; wait_for_video is
 *     bounded and hands control back on timeout instead of blocking
 *   • the shared client enforces rate limits, retries, idempotency & redaction
 */
import { z } from 'zod'
import {
  VivideoClient, VivideoError, isVivideoError, waitForVideo, estimateCredits,
  isConfigured, type Model, type Video,
} from '@vivideo/core'

// One client per process; constructed lazily so the server still starts (and
// check_configuration works) when no key is set yet.
let _client: VivideoClient | null = null
function client(): VivideoClient {
  if (!_client) _client = new VivideoClient({ userAgent: 'vivideo-mcp/1.0' })
  return _client
}

export type ToolResult = {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
const fail = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: true })

/** Run a client call and always return a structured result (never throw). */
async function guarded(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn())
  } catch (e) {
    if (isVivideoError(e)) return fail(e.toJSON())
    return fail({ error: { code: 'internal_error', kind: 'server', message: 'Unexpected error.', retryable: true } })
  }
}

// Compact projections so responses stay small.
const compactModel = (m: Model) => ({
  id: m.id, name: m.name, mode: m.mode, requires_premium: m.requires_premium ?? false,
  operations: m.operations, credits_per_second: m.credits_per_second,
  credits_per_5_seconds: m.credits_per_5_seconds,
  durations: m.durations, resolutions: m.resolutions, aspect_ratios: m.aspect_ratios,
  native_audio: m.native_audio, styles: m.styles,
})
const compactVideo = (v: Video) => ({
  id: v.id, mode: v.mode, model: v.model, status: v.status, credits_charged: v.credits_charged,
  poll_interval_seconds: v.poll_interval_seconds, video_url: v.video_url, caption_url: v.caption_url,
  duration_seconds: v.duration_seconds, progress: v.progress, error: v.error, preview: v.preview,
  created_at: v.created_at, name: v.name,
})

export interface ToolDef {
  name: string
  description: string
  schema: z.ZodRawShape
  handler: (args: Record<string, unknown>) => Promise<ToolResult>
}

export const TOOLS: ToolDef[] = [
  {
    name: 'check_configuration',
    description:
      'Check whether a Vivideo API key is configured for this MCP server. Call this FIRST. ' +
      'Returns { configured: boolean }. If false, ask the user to set the VIVIDEO_API_KEY environment ' +
      'variable (a key from https://app.vivideo.ai/account/api-keys) and restart the MCP server. Never asks for or exposes the key.',
    schema: {},
    handler: async () =>
      ok({
        configured: isConfigured(),
        how_to_configure: 'Set env VIVIDEO_API_KEY=vv_live_... (create one in the Vivideo app: Settings > More > API Keys).',
        docs: 'https://developers.vivideo.ai/authentication',
      }),
  },
  {
    name: 'check_account',
    description:
      'Get the account plan, premium status, and remaining credit balance. Use this to decide whether the user ' +
      'can generate a video (rendering needs a premium plan and enough credits). Returns plan, premium, credits, ' +
      'free_video_available, and links (upgrade / buy_credits). Cheap and safe to call often.',
    schema: {},
    handler: () => guarded(() => client().me()),
  },
  {
    name: 'list_models',
    description:
      'List the video models available for MANUAL mode plus the auto-generate pipeline (id "vivideo-auto"). ' +
      'Each model lists its operations, allowed durations, resolutions, aspect ratios, style presets and per-second ' +
      'credit rate — use these to build a valid create request. Filter with `mode` to keep the response small.',
    schema: {
      mode: z.enum(['auto', 'manual']).optional().describe('Only return models for this mode.'),
    },
    handler: (a) =>
      guarded(async () => {
        const { data } = await client().listModels()
        const filtered = a.mode ? data.filter((m) => m.mode === a.mode) : data
        return { object: 'list', count: filtered.length, data: filtered.map(compactModel) }
      }),
  },
  {
    name: 'list_avatars',
    description:
      'List available avatars for auto-mode videos (the stock catalogue plus the account\'s own avatars). ' +
      'Stock avatars are grouped by person, each with a `looks` array — pass a looks[].avatar_id (or an owned ' +
      'avatar\'s id) as `avatar_id` in create_auto_video. Use `search`/`limit` to keep responses small.',
    schema: {
      search: z.string().optional().describe('Filter avatars by name.'),
      gender: z.enum(['male', 'female', 'unspecified']).optional(),
      limit: z.number().int().min(1).max(100).optional().describe('Max avatars to return (default 20).'),
    },
    handler: (a) =>
      guarded(async () => {
        const res = await client().listAvatars({ search: a.search as string, gender: a.gender as string, limit: (a.limit as number) ?? 20 })
        // /v1/avatars groups stock avatars by PERSON; the ids create_auto_video needs live on
        // looks[].avatar_id. Surface them (capped) — grouped items have no top-level id.
        const shape = (x: import('@vivideo/core').Avatar) => {
          const out: Record<string, unknown> = { name: x.name, gender: x.gender, preview_image_url: x.preview_image_url }
          const looks = (x.looks ?? []).slice(0, 8).filter((l) => l.avatar_id).map((l) => ({ avatar_id: l.avatar_id, name: l.name }))
          if (looks.length) out.looks = looks
          if (x.looks_count) out.looks_count = x.looks_count
          if (x.id != null) out.id = x.id            // owned/custom avatars carry these flat
          if (x.avatar_id != null) out.avatar_id = x.avatar_id
          if (x.ready != null) out.ready = x.ready
          return out
        }
        return {
          object: 'list',
          data: (res.data ?? []).slice(0, (a.limit as number) ?? 20).map(shape),
          owned: (res.owned ?? []).map(shape),
          note: 'Pass a looks[].avatar_id (or an owned avatar\'s id) as avatar_id in create_auto_video.',
        }
      }),
  },
  {
    name: 'list_voices',
    description:
      'List available voices for auto-mode videos. Returns voice ids to pass as `voice_id` in create_auto_video. ' +
      'Filter by language/gender/search and cap with `limit`. Voice cloning is not available via the API.',
    schema: {
      language: z.string().optional().describe('e.g. "English".'),
      gender: z.string().optional(),
      search: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional().describe('Max voices (default 20).'),
    },
    handler: (a) =>
      guarded(async () => {
        const res = await client().listVoices({ language: a.language as string, gender: a.gender as string, search: a.search as string, limit: (a.limit as number) ?? 20 })
        const shape = (v: { voice_id: string; name?: string; language?: string; gender?: string }) => ({ voice_id: v.voice_id, name: v.name, language: v.language, gender: v.gender })
        return { object: 'list', total_public: res.total_public, data: (res.data ?? []).slice(0, (a.limit as number) ?? 20).map(shape), owned: (res.owned ?? []).map(shape) }
      }),
  },
  {
    name: 'list_brand_kits',
    description:
      'List the account\'s brand kits (logo, colors, fonts, motion style). Returns brand_ref ids to pass as ' +
      '`brand_kit_id` in create_auto_video to produce an on-brand video.',
    schema: {},
    handler: () =>
      guarded(async () => {
        const res = await client().listBrandKits()
        return { object: 'list', data: (res.data ?? []).map((b) => ({ brand_ref: b.brand_ref, name: b.name, motion_style: b.motion_style })) }
      }),
  },
  {
    name: 'estimate_credits',
    description:
      'Estimate the credits a generation will cost, from the published per-model rates — BEFORE creating it. ' +
      'This is an estimate, not a charge; the exact amount is returned as credits_charged when you create the video. ' +
      'Use it with check_account to confirm the user can afford the request.',
    schema: {
      mode: z.enum(['auto', 'manual']),
      model: z.string().optional().describe('Required for manual mode — a model id from list_models.'),
      duration_seconds: z.number().int().positive().optional(),
      resolution: z.string().optional().describe('Manual mode — one of the model\'s resolutions.'),
    },
    handler: (a) =>
      guarded(async () => {
        const { data } = await client().listModels()
        return estimateCredits(data, { mode: a.mode as 'auto' | 'manual', model: a.model as string, duration_seconds: a.duration_seconds as number, resolution: a.resolution as string })
      }),
  },
  {
    name: 'create_auto_video',
    description:
      'Create a video in AUTO mode: Vivideo writes the script and produces a complete AI-avatar video from your prompt. ' +
      'Returns immediately with a video id and status "processing" (paid) or "preview" (free accounts — see the preview ' +
      'field and upgrade link). Then call wait_for_video or get_video. An Idempotency-Key is sent automatically so a ' +
      'retry never creates a duplicate. Rendering requires a premium plan and credits.',
    schema: {
      prompt: z.string().min(1).max(5000).describe('What the video should show or say.'),
      duration_seconds: z.number().int().min(5).max(300).optional().describe('5–300, default 30.'),
      avatar_id: z.string().optional().describe('From list_avatars. Omit for a default presenter.'),
      voice_id: z.string().optional().describe('From list_voices.'),
      brand_kit_id: z.string().optional().describe('A brand_ref from list_brand_kits.'),
      orientation: z.enum(['landscape', 'portrait']).optional(),
      folder_id: z.string().optional(),
      name: z.string().max(60).optional(),
      idempotency_key: z.string().max(255).optional().describe('Optional. Reuse the same key to make a retry safe.'),
    },
    handler: (a) =>
      guarded(async () => {
        const v = await client().createVideo(
          { mode: 'auto', prompt: a.prompt as string, duration_seconds: a.duration_seconds as number, avatar_id: a.avatar_id as string, voice_id: a.voice_id as string, brand_kit_id: a.brand_kit_id as string, orientation: a.orientation as 'landscape' | 'portrait', folder_id: a.folder_id as string, name: a.name as string },
          a.idempotency_key as string | undefined,
        )
        return compactVideo(v)
      }),
  },
  {
    name: 'create_manual_video',
    description:
      'Create a video in MANUAL mode: send your prompt straight to a specific model (get ids/options from list_models). ' +
      'The operation is inferred from inputs — add image_url for image-to-video. resolution/duration/aspect_ratio must ' +
      'match the model (an invalid value returns a 400 listing what is allowed). Returns a video id and status; then ' +
      'wait_for_video or get_video. Idempotency handled automatically.',
    schema: {
      model: z.string().describe('A model id from list_models, e.g. "veo31_fast".'),
      prompt: z.string().min(1).max(5000),
      duration_seconds: z.number().int().positive().optional().describe('Must be one of the model\'s durations.'),
      resolution: z.string().optional(),
      aspect_ratio: z.string().optional(),
      image_url: z.string().url().optional().describe('Public https image → image-to-video.'),
      negative_prompt: z.string().optional(),
      seed: z.number().int().optional(),
      generate_audio: z.boolean().optional(),
      style: z.string().optional(),
      folder_id: z.string().optional(),
      name: z.string().max(60).optional(),
      idempotency_key: z.string().max(255).optional(),
    },
    handler: (a) =>
      guarded(async () => {
        const v = await client().createVideo(
          { mode: 'manual', model: a.model as string, prompt: a.prompt as string, duration_seconds: a.duration_seconds as number, resolution: a.resolution as string, aspect_ratio: a.aspect_ratio as string, image_url: a.image_url as string, negative_prompt: a.negative_prompt as string, seed: a.seed as number, generate_audio: a.generate_audio as boolean, style: a.style as string, folder_id: a.folder_id as string, name: a.name as string },
          a.idempotency_key as string | undefined,
        )
        return compactVideo(v)
      }),
  },
  {
    name: 'get_video',
    description:
      'Get a video\'s current status and result. status is one of queued | processing | completed | failed | preview. ' +
      'When completed, video_url is the MP4. When failed, credits are refunded and error explains why. Cheap; prefer ' +
      'wait_for_video for polling instead of calling this in a tight loop.',
    schema: { id: z.string().describe('The video id from a create call.') },
    handler: (a) => guarded(async () => compactVideo(await client().getVideo(a.id as string))),
  },
  {
    name: 'wait_for_video',
    description:
      'Wait for a video to reach a terminal state (completed / failed / preview), then return it. Polls safely at the ' +
      'API-suggested interval up to a timeout. If it does not finish in time it returns { timed_out: true } with the ' +
      'latest status so you can hand control back and call again later — it never blocks indefinitely or over-polls.',
    schema: {
      id: z.string(),
      timeout_seconds: z.number().int().min(10).max(1800).optional().describe('Max wait (default 300, cap 1800).'),
    },
    handler: (a) =>
      guarded(async () => {
        const { video, timedOut } = await waitForVideo(client(), a.id as string, { timeoutMs: ((a.timeout_seconds as number) ?? 300) * 1000 })
        return { timed_out: timedOut, video: compactVideo(video) }
      }),
  },
  {
    name: 'list_videos',
    description:
      'List the account\'s videos, newest first. Filter by status and limit the count to keep responses small.',
    schema: {
      status: z.enum(['queued', 'processing', 'completed', 'failed', 'preview']).optional(),
      limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
    },
    handler: (a) =>
      guarded(async () => {
        const res = await client().listVideos({ status: a.status as string, limit: (a.limit as number) ?? 20 })
        return { object: 'list', count: res.count, total: res.total, data: (res.data ?? []).map(compactVideo) }
      }),
  },
  {
    name: 'render_preview',
    description:
      'For FREE accounts only: after the user upgrades, render a video that was returned as status "preview". Charges ' +
      'run on the same project (the first video after upgrading is free). If the video is already rendering/complete, ' +
      'returns its current state. If the account is still free, returns an upgrade_required error with an upgrade link.',
    schema: { id: z.string().describe('The preview video id.') },
    handler: (a) => guarded(async () => compactVideo(await client().renderVideo(a.id as string))),
  },
]

// Re-export for tests.
export { VivideoError }
