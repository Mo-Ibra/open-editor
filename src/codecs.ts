/**
 * Output codec negotiation.
 *
 * Never hardcode a codec. This is measured behaviour, not caution (§6.8):
 *
 *  - AAC **encode** does not exist on Linux or in Firefox. Chrome only has it
 *    on macOS, iOS and Windows, via the platform encoder. A config with every
 *    parameter valid still comes back `supported: false`.
 *  - Opus inside an MP4 muxes cleanly and produces a file that will not play.
 *    Firefox refuses it, QuickShot certainly will. If AAC is unavailable we
 *    have to change the *container*, not just the codec.
 *
 * So: intersect what the container can hold, what this browser can encode, and
 * what the user actually has, and take the first combination that survives.
 */

import {
  Mp4OutputFormat,
  WebMOutputFormat,
  type AudioCodec,
  type OutputFormat,
  type VideoCodec,
} from 'mediabunny'

/** Ordered by preference. First viable combination wins. */
export const COMBINATIONS = [
  { format: 'mp4', video: 'avc', audio: 'aac' },
  { format: 'mp4', video: 'avc', audio: null },
  { format: 'webm', video: 'vp9', audio: 'opus' },
  { format: 'webm', video: 'vp8', audio: 'opus' },
  { format: 'webm', video: 'vp9', audio: null },
] as const

export type Combination = (typeof COMBINATIONS)[number]

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

export interface ExportPlan {
  format: Mp4OutputFormat | WebMOutputFormat
  video: VideoCodec
  audio: AudioCodec | null
  extension: 'mp4' | 'webm'
  /** Why earlier combinations were rejected, for the UI. */
  notes: string[]
  /** True when this is not the format we would have preferred. */
  degraded: boolean
}

export interface NegotiateOptions {
  needsAudio: boolean
  width: number
  height: number
  fps: number
  bitrate: number
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

/**
 * Pick the best output configuration this browser can actually produce.
 *
 * Returns null only when neither H.264 nor VP9 is encodable, which is a real
 * dead end and worth saying plainly rather than falling back to something
 * broken.
 */
export async function negotiate(
  options: NegotiateOptions & { sampleRate?: number; channels?: number },
): Promise<ExportPlan | null> {
  const notes: string[] = []
  const sampleRate = options.sampleRate ?? 48000
  const channels = options.channels ?? 2

  for (const [index, combo] of COMBINATIONS.entries()) {
    if (options.needsAudio && combo.audio === null) continue

    const format: OutputFormat =
      combo.format === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat()

    if (!format.getSupportedVideoCodecs().includes(combo.video as never)) {
      notes.push(`${combo.format}/${combo.video}: container cannot hold it`)
      continue
    }
    if (!(await videoEncodable(combo.video, options))) {
      notes.push(`${combo.format}/${combo.video}: no encoder in this browser`)
      continue
    }

    let audio: AudioCodec | null = null
    if (combo.audio !== null) {
      if (!format.getSupportedAudioCodecs().includes(combo.audio as never)) {
        notes.push(`${combo.format}/${combo.video}/${combo.audio}: container cannot hold it`)
        continue
      }
      if (!(await audioEncodable(combo.audio, sampleRate, channels))) {
        notes.push(`${combo.format}/${combo.video}/${combo.audio}: no encoder in this browser`)
        continue
      }
      audio = combo.audio as AudioCodec
    }

    return {
      format: format as Mp4OutputFormat | WebMOutputFormat,
      video: combo.video as VideoCodec,
      audio,
      extension: combo.format,
      notes,
      // Anything past the first two is a genuine downgrade worth surfacing.
      degraded: index > 1,
    }
  }

  notes.push('nothing encodable')
  return null
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
