/**
 * Output codec negotiation.
 *
 * Never hardcode a codec. This is measured behaviour, not caution:
 *
 *  - AAC **encode** does not exist on Linux or in Firefox. Chrome only has it
 *    on macOS, iOS and Windows, via the platform encoder. A config with every
 *    parameter valid still comes back `supported: false`.
 *  - Opus inside an MP4 muxes cleanly and produces a file that will not play.
 *    Firefox refuses it, QuickShot certainly will. If AAC is unavailable we
 *    have to change the *container*, not just the codec.
 *
 * So: intersect what the container can hold, what this browser can encode, and
 * what the user actually has, and keep *every* combination that survives.
 *
 * Returning the whole list, not just the first hit, is the point. On Linux with
 * audio the first two rows die and the user silently gets WebM — correct, but
 * they cannot see that MP4 was ever on the table, let alone ask for the MP3
 * variant that Instagram and Facebook will accept. A negotiation that only
 * reports its verdict is a negotiation the user cannot argue with.
 */

import {
  Mp4OutputFormat,
  WebMOutputFormat,
  type AudioCodec,
  type OutputFormat,
  type VideoCodec,
} from 'mediabunny'

/**
 * How widely a finished file will play, which is what actually decides whether
 * an export is useful. Codec *quality* is a second-order concern: every social
 * platform re-encodes an upload anyway.
 */
export type Compatibility =
  /** Plays in phones, browsers, editors, and every social platform. */
  | 'universal'
  /** Plays in most places, but not every social upload accepts the container. */
  | 'partial'
  /** No audio track. Maximum compatibility, usually not what was wanted. */
  | 'silent'

export interface Combination {
  id: string
  format: 'mp4' | 'webm'
  video: 'avc' | 'vp9' | 'vp8'
  audio: 'aac' | 'mp3' | 'opus' | null
  label: string
  compatibility: Compatibility
  /** One line explaining the trade, shown under the label. */
  blurb: string
}

/**
 * Ordered by preference. The first *viable* entry is the default, so the
 * ordering is a quality/compatibility judgement, not an arbitrary list.
 */
export const COMBINATIONS: Combination[] = [
  {
    id: 'mp4/avc/aac',
    format: 'mp4',
    video: 'avc',
    audio: 'aac',
    label: 'MP4 · H.264 + AAC',
    compatibility: 'universal',
    blurb: 'Plays everywhere. What every platform expects.',
  },
  {
    id: 'mp4/avc/mp3',
    format: 'mp4',
    video: 'avc',
    audio: 'mp3',
    label: 'MP4 · H.264 + MP3',
    compatibility: 'universal',
    blurb: 'Also plays everywhere. Slightly worse audio than AAC.',
  },
  {
    id: 'webm/vp9/opus',
    format: 'webm',
    video: 'vp9',
    audio: 'opus',
    label: 'WebM · VP9 + Opus',
    compatibility: 'partial',
    blurb: 'Smaller files, good quality. Not accepted by Instagram.',
  },
  {
    id: 'mp4/avc/silent',
    format: 'mp4',
    video: 'avc',
    audio: null,
    label: 'MP4 · H.264 (no audio)',
    compatibility: 'silent',
    blurb: 'Maximum compatibility, no sound.',
  },
  {
    id: 'webm/vp8/opus',
    format: 'webm',
    video: 'vp8',
    audio: 'opus',
    label: 'WebM · VP8 + Opus',
    compatibility: 'partial',
    blurb: 'Older, widely supported WebM video codec.',
  },
]

/** mediabunny's friendly names -> the WebCodecs codec strings. */
const WEBCODECS_VIDEO: Record<string, string> = {
  avc: 'avc1.42001f',
  hevc: 'hev1.1.6.L93.B0',
  vp9: 'vp09.00.10.08',
  vp8: 'vp8',
  av1: 'av01.0.04M.08',
}
const WEBCODECS_AUDIO: Record<string, string> = {
  aac: 'mp4a.40.2',
  opus: 'opus',
  mp3: 'mp3',
  vorbis: 'vorbis',
}

/** One combination this browser can actually produce. */
export interface PlanCandidate {
  combo: Combination
  id: string
  label: string
  blurb: string
  compatibility: Compatibility
  extension: 'mp4' | 'webm'
  video: VideoCodec
  audio: AudioCodec | null
  /** True when this is not the best available choice. */
  degraded: boolean
}

export interface ExportPlan {
  format: Mp4OutputFormat | WebMOutputFormat
  video: VideoCodec
  audio: AudioCodec | null
  extension: 'mp4' | 'webm'
  /** Why earlier combinations were rejected, for the UI. */
  notes: string[]
  /** True when this is not the format we would have preferred. */
  degraded: boolean
  /** The entry the user actually chose, for display. */
  id: string
  label: string
}

export interface NegotiateOptions {
  needsAudio: boolean
  width: number
  height: number
  fps: number
  bitrate: number
}

function makeFormat(combo: Combination): OutputFormat {
  return combo.format === 'mp4'
    ? new Mp4OutputFormat({ fastStart: 'in-memory' })
    : new WebMOutputFormat()
}

async function videoEncodable(codec: string, { width, height, fps, bitrate }: NegotiateOptions): Promise<boolean> {
  try {
    const support = await VideoEncoder.isConfigSupported({
      codec: WEBCODECS_VIDEO[codec]!,
      width,
      height,
      framerate: fps,
      bitrate,
    })
    return !!support.supported
  } catch {
    return false
  }
}

async function audioEncodable(codec: string, sampleRate: number, channels: number): Promise<boolean> {
  try {
    const support = await AudioEncoder.isConfigSupported({
      codec: WEBCODECS_AUDIO[codec]!,
      sampleRate,
      numberOfChannels: channels,
      bitrate: 128_000,
    })
    return !!support.supported
  } catch {
    return false
  }
}

/** Why a combination was ruled out, phrased for a person, not a log. */
function reject(combo: Combination, reason: string): string {
  return `${combo.label}: ${reason}`
}

/**
 * Every combination this browser can actually produce, best first.
 *
 * Also returns the rejections, because "why isn't MP4 available?" is the
 * question a user asks when the format is chosen for them.
 */
export async function availablePlans(
  options: NegotiateOptions & { sampleRate?: number; channels?: number },
): Promise<{ plans: PlanCandidate[]; notes: string[] }> {
  const notes: string[] = []
  const sampleRate = options.sampleRate ?? 48000
  const channels = options.channels ?? 2
  const plans: PlanCandidate[] = []

  for (const combo of COMBINATIONS) {
    if (options.needsAudio && combo.audio === null) {
      notes.push(reject(combo, 'no audio track, but the timeline has sound'))
      continue
    }

    const format = makeFormat(combo)

    if (!format.getSupportedVideoCodecs().includes(combo.video as never)) {
      notes.push(reject(combo, 'the container cannot hold this video codec'))
      continue
    }
    if (!(await videoEncodable(combo.video, options))) {
      notes.push(reject(combo, 'this browser has no encoder for it'))
      continue
    }

    let audio: AudioCodec | null = null
    if (combo.audio !== null) {
      if (!format.getSupportedAudioCodecs().includes(combo.audio as never)) {
        notes.push(reject(combo, 'the container cannot hold this audio codec'))
        continue
      }
      if (!(await audioEncodable(combo.audio, sampleRate, channels))) {
        notes.push(reject(combo, 'this browser has no encoder for the audio codec'))
        continue
      }
      audio = combo.audio as AudioCodec
    }

    plans.push({
      combo,
      id: combo.id,
      label: combo.label,
      blurb: combo.blurb,
      compatibility: combo.compatibility,
      extension: combo.format,
      video: combo.video as VideoCodec,
      audio,
      // Relative to what is *available*, not to the preference order. A browser
      // with no H.264 encoder is not "falling back" when it produces WebM —
      // that is the best it can do, and saying otherwise would cry wolf on
      // every Linux export.
      degraded: false,
    })
  }

  // Everything after the first viable option is a real downgrade.
  plans.forEach((plan, i) => {
    plan.degraded = i > 0
  })

  return { plans, notes }
}

/**
 * Pick the output configuration to actually use.
 *
 * `preferId` is the user's choice. If it is missing, or names something this
 * browser cannot do, the best available option is used instead — asking for
 * something impossible must degrade, never throw.
 */
export async function negotiate(
  options: NegotiateOptions & { sampleRate?: number; channels?: number },
  preferId?: string,
): Promise<ExportPlan | null> {
  const { plans, notes } = await availablePlans(options)
  const chosen = (preferId ? plans.find((p) => p.id === preferId) : undefined) ?? plans[0]
  if (!chosen) {
    notes.push('nothing encodable in this browser')
    return null
  }

  return {
    format: makeFormat(chosen.combo) as Mp4OutputFormat | WebMOutputFormat,
    video: chosen.video,
    audio: chosen.audio,
    extension: chosen.extension,
    notes,
    degraded: chosen.degraded,
    id: chosen.id,
    label: chosen.label,
  }
}

/** Bits per second for a resolution and rate. A fixed bitrate is simultaneously
 *  wasteful at 4K and visibly blocky at 480p. */
export function bitrateFor(width: number, height: number, fps: number): number {
  return Math.round(width * height * fps * 0.11)
}

/** Encoders reject odd dimensions. */
export function even(n: number): number {
  return Math.max(2, n - (n % 2))
}
