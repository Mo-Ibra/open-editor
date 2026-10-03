/**
 * The audio track for an export.
 *
 * The whole timeline becomes ONE mixed buffer, assembled with plain
 * Float32Array arithmetic (docs/decisions/0004-deterministic-audio-mixing.md), then handed to the encoder in chunks. No
 * Web Audio graph: a graph is stateful, its output depends on construction
 * order, and for trim-and-concatenate it is enormous overkill.
 *
 * The part that matters is arithmetic. Every position is an integer sample
 * index computed once, at the boundary, and the mix loop never does float
 * math. Accumulating float seconds across clips is how A/V drift is born
 * (docs/export.md#av-sync) — a five-line bug that costs a day and is invisible in a 5-second test.
 */

import { mixTimeline, OUTPUT_CHANNELS, type MixSegment } from './audio.js'
import { clipStarts, type Project } from '../model/project.js'
import type { MediaLibrary } from '../media/library.js'
import { log } from '../dev/debug.js'

export interface BuildAudioOptions {
  library: MediaLibrary
  /**
   * An already-decoded, 48 kHz buffer for the asset, or null if it has no
   * audio. Sharing the preview's cache avoids decoding a long file twice.
   */
  getAssetAudio: (assetId: string) => Promise<AudioBuffer | null>
  onProgress?: (fraction: number) => void
}

export interface ExportAudioTrack {
  buffer: AudioBuffer
  /** True when every sampled value in the output is zero. */
  silent: boolean
}

export async function buildExportAudio(
  project: Project,
  duration: number,
  options: BuildAudioOptions,
): Promise<ExportAudioTrack | null> {
  // The audio lane only. A video clip with no audio of its own contributes nothing.
  const clips = project.audio
  const segments: MixSegment[] = []
  let withAudio = 0
  // One pass for every clip's timeline start. Asking `clipStart` per clip inside
  // this loop made building the audio mix quadratic, and this runs once per export
  // over the whole lane.
  const starts = clipStarts(clips)

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]!
    const entry = options.library.get(clip.assetId)
    if (!entry?.audioTrack) continue

    let decoded: AudioBuffer | null = null
    try {
      decoded = await options.getAssetAudio(clip.assetId)
    } catch (err) {
      log.warn(`export: no audio for ${entry.asset.name}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    if (!decoded) continue

    const rate = decoded.sampleRate
    // Integer indices, once. Never `start += (out - in)`.
    const from = clamp(Math.round(clip.in * rate), 0, decoded.length)
    const to = clamp(Math.round(clip.out * rate), from, decoded.length)
    if (to <= from) continue

    segments.push({
      buffer: sliceBuffer(decoded, from, to - from),
      start: starts[i]!,
      gain: clip.muted ? 0 : (clip.gain ?? 1),
    })
    withAudio++
    options.onProgress?.((i + 1) / clips.length)
  }

  if (!segments.length) {
    log.info('export: no clip carries audio, exporting silent')
    return null
  }

  // Mixed to exactly the video's duration, so the audio cannot run past the
  // last frame.
  const buffer = mixTimeline(segments, duration)
  const silent = isSilent(buffer)

  log.info(
    `export audio: mixed ${withAudio}/${clips.length} clips into ${buffer.duration.toFixed(2)}s ` +
      `@ ${buffer.sampleRate} Hz x${buffer.numberOfChannels}${silent ? ' — all silence' : ''}`,
  )
  if (silent) log.warn('export audio: every segment was muted or empty, so the file will be silent')

  return { buffer, silent }
}

/**
 * The docs/export.md#av-sync sync assertions, as a function.
 *
 * Run after the mix is built so a track that will not hold up to inspection is
 * reported rather than shipped. Tolerance is one *video frame*, not one
 * sample — a frame of slack is correct, a sample of slack is not.
 */
export function verifyAudioTrack(
  track: ExportAudioTrack,
  videoDuration: number,
  outputFps: number,
): { ok: boolean; problems: string[] } {
  const problems: string[] = []
  const rate = track.buffer.sampleRate
  const slack = 1 / outputFps

  if (track.buffer.duration < videoDuration - slack) {
    problems.push(
      `audio is ${(videoDuration - track.buffer.duration).toFixed(3)}s short of the video ` +
        `(tolerance ${slack.toFixed(3)}s, one frame)`,
    )
  }
  if (track.buffer.duration > videoDuration + slack) {
    problems.push(`audio is ${(track.buffer.duration - videoDuration).toFixed(3)}s longer than the video`)
  }

  const expectedSamples = Math.ceil(videoDuration * rate)
  if (Math.abs(track.buffer.length - expectedSamples) > rate * slack) {
    problems.push(`expected ~${expectedSamples} samples at ${rate} Hz, built ${track.buffer.length}`)
  }

  if (track.buffer.numberOfChannels !== OUTPUT_CHANNELS) {
    problems.push(`expected ${OUTPUT_CHANNELS} channels, built ${track.buffer.numberOfChannels}`)
  }
  if (track.silent) problems.push('the mix is entirely silent')

  return { ok: problems.length === 0, problems }
}

function sliceBuffer(buffer: AudioBuffer, from: number, count: number): AudioBuffer {
  const out = new AudioBuffer({
    length: count,
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
  })
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    out.getChannelData(ch).set(buffer.getChannelData(ch).subarray(from, from + count))
  }
  return out
}

function isSilent(buffer: AudioBuffer): boolean {
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    // A sparse stride. A full scan of a long mix is thousands of megabytes.
    for (let i = 0; i < data.length; i += 97) {
      if (data[i] !== 0) return false
    }
  }
  return true
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
