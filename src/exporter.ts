/**
 * Export: timeline -> a file you can send to someone.
 *
 * The render pass is `renderFrame` — the same function the preview uses
 * (PLAN.md ADR-1). Preview and export differ only in which source frame is
 * fetched, never in how it is drawn, so "what I saw" and "what I got" cannot
 * disagree.
 *
 * Two things here are deliberate and easy to get wrong:
 *
 *  1. **Sequential decoding, per clip.** Each clip's output timestamps go
 *     through one `canvasesAtTimestamps` pass, which decodes every packet at
 *     most once. Asking for frames one at a time was 13x slower (R2) and gets
 *     worse as seeks move away from a keyframe.
 *
 *  2. **Output timestamps come from the derived `clipStart`,** never from a
 *     stored position, so a clip cannot drift out of order however it was
 *     edited (§3).
 */

import { AudioBufferSource, BufferTarget, CanvasSource, Output } from 'mediabunny'
import type { AudioCodec } from 'mediabunny'
import { clipDuration, clipStart, projectDuration, type Clip, type Project } from './project.js'
import { renderBlank, renderFrame } from './render.js'
import type { MediaLibrary } from './library.js'
import { bitrateFor, even, negotiate, type ExportPlan } from './codecs.js'
import { log } from './debug.js'

export interface ExportSettings {
  width: number
  height: number
  fps: number
  bitrate: number
}

export interface ExportProgress {
  stage: 'preparing' | 'audio' | 'video' | 'muxing' | 'done' | 'cancelled' | 'failed'
  progress: number
  framesDone: number
  framesTotal: number
  fps: number
  eta: number
  message?: string
}

export interface ExportResult {
  blob: Blob
  extension: 'mp4' | 'webm'
  plan: ExportPlan
  /** What is actually in the file. Verified against the muxer, not assumed. */
  hasVideo: boolean
  hasAudio: boolean
  audioCodec: string | null
  elapsed: number
  fps: number
  frames: number
  size: number
}

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled')
    this.name = 'ExportCancelled'
  }
}

/** Supplies the mixed audio track, so the exporter never knows how it was built. */
export interface ExportAudio {
  /** The whole timeline as one buffer, already verified. */
  buffer: AudioBuffer
}

export interface ExporterOptions {
  library: MediaLibrary
  onProgress: (progress: ExportProgress) => void
}

/**
 * Default settings: the source's own resolution and frame rate (§6.9).
 *
 * A cutter's input is the user's own footage, so the overwhelmingly correct
 * output is the same footage trimmed. Anything else is something the user
 * chose, never a default the product made for them.
 */
export function settingsFor(sourceSize: { width: number; height: number; frameRate: number; variableFrameRate: boolean } | null): ExportSettings {
  let width = sourceSize?.width ?? 1920
  let height = sourceSize?.height ?? 1080

  // A VFR source has a meaningless average frame rate — 3.75 fps for a screen
  // recording — and emitting at that produces a slideshow. Target 30 and hold
  // frames. CFR sources keep their own rate so nothing is dropped.
  let fps = sourceSize ? (sourceSize.variableFrameRate ? 30 : Math.round(sourceSize.frameRate) || 30) : 30

  width = even(width)
  height = even(height)
  fps = Math.max(1, fps)

  return { width, height, fps, bitrate: bitrateFor(width, height, fps) }
}

/**
 * The output timestamps one clip owns.
 *
 * Extracted and pure so the invariant can be tested: timestamps are derived
 * from the clip's position in the array, they are strictly increasing, and the
 * whole timeline yields exactly `ceil(duration × fps)` of them. A stored start
 * position instead of a derived one is how a clip drifts out of order (§3).
 */
/** Chunk size for feeding the audio encoder. Large enough to be cheap, small
 *  enough that the queue never holds a megabyte of PCM. */
const AUDIO_CHUNK_SECONDS = 0.5

function chunkBuffer(buffer: AudioBuffer, seconds: number): AudioBuffer[] {
  const size = Math.max(1, Math.round(buffer.sampleRate * seconds))
  const chunks: AudioBuffer[] = []
  for (let offset = 0; offset < buffer.length; offset += size) {
    const length = Math.min(size, buffer.length - offset)
    const chunk = new AudioBuffer({
      length,
      numberOfChannels: buffer.numberOfChannels,
      sampleRate: buffer.sampleRate,
    })
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      chunk.getChannelData(ch).set(buffer.getChannelData(ch).subarray(offset, offset + length))
    }
    chunks.push(chunk)
  }
  return chunks
}

export function frameTimesForClip(clips: Clip[], index: number, budget: number, fps: number): number[] {
  // Count in frames, never accumulate seconds.
  //
  // `for (let t = start; t < end; t += 1 / fps)` looks equivalent and is not:
  // 1/30 is not representable, so the running sum drifts and the last clip
  // emits one frame too many. A 32s timeline at 30fps produced 961 frames
  // instead of 960 — caught by the test, and exactly the float accumulation
  // §6.1 warns about. Boundaries are rounded to whole frames once, then
  // derived by division.
  // An index that is not there yields no frames rather than throwing. A
  // timeline can legitimately be empty, and an export of nothing is an empty
  // result, not a crash.
  if (index < 0 || index >= clips.length) return []

  const startFrame = Math.round(clipStart(clips, index) * fps)
  const endFrame = Math.round((clipStart(clips, index) + clipDuration(clips[index]!)) * fps)
  const count = Math.min(endFrame - startFrame, budget)

  const times: number[] = []
  for (let i = 0; i < count; i++) {
    times.push(Number(((startFrame + i) / fps).toFixed(6)))
  }
  return times
}

/** Total frames for a timeline. Must equal the sum of every clip's frame count. */
export function totalFramesFor(project: Project, fps: number): number {
  return Math.ceil(projectDuration(project) * fps)
}

export class Exporter {
  readonly #library: MediaLibrary
  readonly #onProgress: (progress: ExportProgress) => void
  #cancelled = false

  constructor(options: ExporterOptions) {
    this.#library = options.library
    this.#onProgress = options.onProgress
  }

  cancel(): void {
    this.#cancelled = true
  }

  async run(project: Project, settings: ExportSettings, audio: ExportAudio | null): Promise<ExportResult> {
    this.#cancelled = false
    const t0 = performance.now()

    if (project.clips.length === 0) throw new Error('Add a clip to the timeline first.')
    const duration = projectDuration(project)
    if (duration <= 0) throw new Error('There is nothing on the timeline to export.')

    this.#onProgress({ stage: 'preparing', progress: 0, framesDone: 0, framesTotal: 0, fps: 0, eta: 0 })

    const plan = await negotiate({
      needsAudio: audio !== null,
      width: settings.width,
      height: settings.height,
      fps: settings.fps,
      bitrate: settings.bitrate,
    })
    if (!plan) {
      throw new Error('This browser cannot encode H.264 or VP9, so there is nothing to export with.')
    }

    const label = `${plan.extension}/${plan.video}${plan.audio ? ` + ${plan.audio}` : ' (silent)'}`
    log.info(`export: ${label} ${settings.width}x${settings.height} @ ${settings.fps}`)
    for (const note of plan.notes) log.info(`  skipped ${note}`)
    if (plan.degraded) log.warn(`export fell back to ${label} — see §6.8`)

    const out = new Output({ format: plan.format, target: new BufferTarget() })

    const canvas = new OffscreenCanvas(settings.width, settings.height)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Could not create an export canvas.')

    const canvasSource = new CanvasSource(canvas, {
      codec: plan.video,
      bitrate: settings.bitrate,
      // A keyframe every 2 seconds. Longer GOPs are smaller but make seeking the
      // result awful, which matters more here than a few percent of size.
      keyFrameInterval: settings.fps * 2,
    })
    out.addVideoTrack(canvasSource)

    // Note what was ACTUALLY added, not what was negotiated. Reporting the
    // negotiated codec when no audio track exists is how a file claims to have
    // sound it does not have.
    let audioAdded = false
    let audioSource: AudioBufferSource | null = null
    if (audio && plan.audio) {
      audioSource = new AudioBufferSource({ codec: plan.audio, bitrate: 128_000 })
      out.addAudioTrack(audioSource)
      audioAdded = true
      this.#onProgress({
        stage: 'audio',
        progress: 0,
        framesDone: 0,
        framesTotal: 0,
        fps: 0,
        eta: 0,
        message: `mixing ${audio.buffer.duration.toFixed(1)}s of audio`,
      })
    }

    const totalFrames = totalFramesFor(project, settings.fps)
    const renderOptions = { width: settings.width, height: settings.height }
    const frameDuration = 1 / settings.fps

    let done = 0
    let lastReport = 0

    try {
      await out.start()

      for (let index = 0; index < project.clips.length; index++) {
        this.#checkCancelled()

        const clip = project.clips[index]!
        const times = frameTimesForClip(project.clips, index, totalFrames - done, settings.fps)
        if (!times.length) continue

        const entry = this.#library.get(clip.assetId)

        if (!entry?.videoSink) {
          // An audio-only clip still occupies its span, so the output needs
          // that many black frames. Skipping them would shorten the video and
          // desync everything after it.
          for (const t of times) {
            this.#checkCancelled()
            renderBlank(ctx, renderOptions)
            await canvasSource.add(t, frameDuration)
            done++
          }
        } else {
          // One sequential pass per clip: every packet decoded at most once.
          let cursor = 0
          for await (const wrapped of entry.videoSink.canvasesAtTimestamps(times)) {
            this.#checkCancelled()
            const t = times[cursor++] ?? 0

            if (wrapped) {
              renderFrame(
                ctx,
                { image: wrapped.canvas, width: wrapped.canvas.width, height: wrapped.canvas.height },
                clip,
                renderOptions,
              )
            } else {
              renderBlank(ctx, renderOptions)
            }

            await canvasSource.add(t, frameDuration, {
              keyFrame: done % (settings.fps * 2) === 0,
            })
            done++

            const nowMs = performance.now()
            if (nowMs - lastReport > 200) {
              lastReport = nowMs
              this.#tick(done, totalFrames, t0)
            }
          }
        }

        this.#tick(done, totalFrames, t0)
      }

      // Audio is fed after the video loop. AudioBufferSource appends each
      // buffer directly after the previous one, so order is the only thing that
      // matters — the muxer sorts by timestamp.
      if (audioSource && audio) {
        for (const chunk of chunkBuffer(audio.buffer, AUDIO_CHUNK_SECONDS)) {
          this.#checkCancelled()
          await audioSource.add(chunk)
        }
        const pcmMb = (audio.buffer.length * audio.buffer.numberOfChannels * 4) / 1e6
        log.info(`export audio: encoded ${pcmMb.toFixed(1)} MB of PCM as ${plan.audio}`)
      }

      this.#onProgress({
        stage: 'muxing',
        progress: 0.98,
        framesDone: done,
        framesTotal: totalFrames,
        fps: 0,
        eta: 0,
      })
      await out.finalize()
    } catch (err) {
      try {
        await out.cancel()
      } catch {
        /* already torn down */
      }
      if (err instanceof ExportCancelled) {
        this.#onProgress({ stage: 'cancelled', progress: 0, framesDone: 0, framesTotal: 0, fps: 0, eta: 0 })
      }
      throw err
    }

    const buffer = (out.target as BufferTarget).buffer
    if (!buffer) throw new Error('The muxer produced no output.')

    const blob = new Blob([buffer], { type: `video/${plan.extension}` })
    const elapsed = (performance.now() - t0) / 1000
    const fps = totalFrames / elapsed

    this.#onProgress({ stage: 'done', progress: 1, framesDone: totalFrames, framesTotal: totalFrames, fps, eta: 0 })

    log.info(
      `export done: ${totalFrames} frames in ${elapsed.toFixed(2)}s ` +
        `(${fps.toFixed(1)} fps, ${(blob.size / 1e6).toFixed(2)} MB)`,
    )

    return {
    blob,
    extension: plan.extension,
    plan,
    // The truth about the file, not the intent.
    hasVideo: true,
    hasAudio: audioAdded,
    audioCodec: audioAdded ? (plan.audio as AudioCodec) : null,
    elapsed,
    fps,
    frames: totalFrames,
    size: blob.size,
  }
  }

  #tick(done: number, total: number, t0: number): void {
    const elapsed = (performance.now() - t0) / 1000
    const fps = done / elapsed
    this.#onProgress({
      stage: 'video',
      progress: total ? done / total : 0,
      framesDone: done,
      framesTotal: total,
      fps,
      eta: fps > 0 ? (total - done) / fps : 0,
    })
  }

  #checkCancelled(): void {
    if (this.#cancelled) throw new ExportCancelled()
  }
}
