/**
 * Vivideo API types — mirror of packages/core/openapi.yaml (the single source of
 * truth). Regenerate the raw OpenAPI types with `npm run gen:types`; these
 * hand-written types are the ergonomic surface the client, MCP and CLI share so
 * there is exactly ONE representation of each request/response.
 */

export type VideoMode = 'auto' | 'manual'
export type VideoStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'preview'
export type Operation = 'text_to_video' | 'image_to_video' | 'first_last_frame' | 'multiple_images'

export interface Links {
  upgrade?: string
  buy_credits?: string
  manage_keys?: string
  docs?: string
  [k: string]: string | undefined
}

export interface Account {
  object: 'account'
  email?: string
  plan: 'free' | 'pro' | 'max' | 'expired' | string
  premium: boolean
  credits: number
  free_video_available: boolean
  first_video_comp_used: boolean
  links: Links
}

export interface Model {
  id: string
  object: 'model'
  name: string
  brand?: string
  mode: VideoMode
  requires_premium?: boolean
  operations: Operation[]
  credits_per_second: Record<string, number>
  durations: string[]
  default_duration?: string
  resolutions: string[]
  default_resolution?: string
  aspect_ratios: string[]
  default_aspect_ratio?: string
  native_audio?: boolean
  supports_negative_prompt?: boolean
  supports_seed?: boolean
  supports_motion?: boolean
  supports_cfg_scale?: boolean
  styles?: string[]
  // The auto pseudo-model (id "vivideo-auto") carries these instead:
  credits_per_5_seconds?: number
  durations_seconds?: { min: number; max: number }
  supports?: string[]
}

export interface VideoProgress {
  status?: string
  queue_position?: number | null
  percent?: number | null
}

export interface VideoError {
  code: string
  message: string
  credits_refunded?: boolean
}

export interface VideoPreview {
  image_url?: string | null
  image_note?: string
  message?: string
  upgrade_url?: string
}

export interface Video {
  id: string
  object: 'video'
  mode: VideoMode
  model?: string | null
  status: VideoStatus
  name?: string
  folder_id?: string
  created_at?: string
  credits_charged: number
  poll_interval_seconds?: number
  video_url?: string
  video_url_no_captions?: string
  caption_url?: string
  thumbnail_url?: string
  duration_seconds?: number
  progress?: VideoProgress
  error?: VideoError
  preview?: VideoPreview
}

export interface VideoList {
  object: 'list'
  data: Video[]
  count: number
  total: number
}

export interface Avatar {
  id: string
  object: 'avatar'
  name?: string
  kind?: 'prompt' | 'photo'
  status?: string
  ready?: boolean
  gender?: string
  preview_image_url?: string
  preview_video_url?: string
  looks?: unknown[]
}

export interface Voice {
  voice_id: string
  name?: string
  language?: string
  gender?: string
  preview_audio_url?: string
}

export interface BrandKit {
  object: 'brand_kit'
  brand_ref: string
  name?: string
  logo_url?: string
  logo_asset_id?: string
  primary_color?: string
  secondary_color?: string
  tertiary_color?: string
  accent_color?: string
  title_font?: string
  body_font?: string
  motion_style?: string
  brand_identity?: string
}

export interface Asset {
  id: string
  object: 'asset'
  asset_id?: string
  upload_url?: string
  upload_headers?: Record<string, string>
  status?: 'uploading' | 'processing' | 'ready' | 'deleted' | string
  asset_type?: string
  url?: string
  content_type?: string
  size_bytes?: number
}

export interface Upload {
  object: 'upload'
  upload_url: string
  public_url: string
  expires_in_seconds?: number
  method?: string
}

export interface Folder {
  id: string
  object: 'folder'
  name?: string
  created_at?: string
}

export interface WebhookEndpoint {
  id: string
  object: 'webhook_endpoint'
  url: string
  events: string[]
  status: string
  created_at?: number
  secret?: string // only present in the create response
}

// ---- request bodies -------------------------------------------------------

export interface CreateAutoVideoInput {
  mode: 'auto'
  prompt: string
  duration_seconds?: number
  avatar_id?: string
  voice_id?: string
  brand_kit_id?: string
  style_id?: string
  file_asset_ids?: string[]
  orientation?: 'landscape' | 'portrait'
  folder_id?: string
  name?: string
}

export interface CreateManualVideoInput {
  mode: 'manual'
  model: string
  prompt: string
  duration_seconds?: number
  resolution?: string
  aspect_ratio?: string
  negative_prompt?: string
  seed?: number
  generate_audio?: boolean
  style?: string
  movement_amplitude?: string
  cfg_scale?: number
  camera_fixed?: boolean
  auto_fix?: boolean
  image_url?: string
  first_frame_url?: string
  last_frame_url?: string
  end_image_url?: string
  image_urls?: string[]
  folder_id?: string
  name?: string
}

export type CreateVideoInput = CreateAutoVideoInput | CreateManualVideoInput

/** The API error envelope: `{ "error": { ... } }`. */
export interface ApiErrorBody {
  error: {
    code: string
    message: string
    retryable: boolean
    request_id: string
    retry_after_seconds?: number
    details?: Record<string, unknown>
    links?: Links
  }
}
