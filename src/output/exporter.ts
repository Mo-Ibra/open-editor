/**
 * Export: timeline -> a file you can send to someone.
 *
 * The render pass is `renderFrame` — the same function the preview uses
 * (docs/decisions/0001-one-render-function.md). Preview and export differ only in which source frame is
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
 *     edited (docs/data-model.md).
 */

import { AudioBufferSource, BufferTarget, CanvasSource, Output, Quality } from 'mediabunny'
import type { AudioCodec } from 'mediabunny'
import { clipDuration, clipStart, projectDuration, type Clip, type Project } from '../model/project.js'
import { renderBlank, renderFrame } from '../render/render.js'
import type { MediaLibrary } from '../media/library.js'
import {
  even,
  negotiate,
  qualityBitrate,
  qualityQuantizer,
  type ExportPlan,
  type ExportQuality,
  type SourceFacts,
} from './codecs.js'
import { log } from '../dev/debug.js'

export interface ExportSettings {
  width: number
  height: number
  fps: number
  /** Bitrate fallback / budget. */
  bitrate: number
  /** Which constant-quality level to target. */
  quality: ExportQuality
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

/**
 * Does this clip contribute decoded frames, or black?
 *
 * Two cases, and only two: the asset has no video track at all (an audio file
 * dropped on the video lane), or the user has hidden the clip. Both write black
 * for the clip's whole span, and neither skips it — a clip still occupies its
 * time and shifts nothing after it.
 *
 * Its own function because it is the *rule*, and a rule that lives inline in a
 * 450-line export loop is a rule nothing can test. Exporting to prove a hidden
 * clip comes out black needs a whole media pipeline; this needs a `Clip`.
 */
export function clipRendersBlack(clip: Clip, hasVideoSink: boolean): boolean {
  return !hasVideoSink || clip.hidden === true
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
 * Default settings: the source's own resolution and frame rate (docs/export.md#resolution-and-frame-rate-default-to-the-source-always).
 *
 * A cutter's input is the user's own footage, so the overwhelmingly correct
 * output is the same footage trimmed. Anything else is something the user
 * chose, never a default the product made for them.
 */
export function settingsFor(source: SourceFacts | null, quality: ExportQuality = 'high'): ExportSettings {
  let width = source?.width ?? 1920
  let height = source?.height ?? 1080

  // A VFR source has a meaningless average frame rate — 3.75 fps for a screen
  // recording — and emitting at that produces a slideshow. Target 30 and hold
  // frames. CFR sources keep their own rate so nothing is dropped.
  let fps = source ? (source.variableFrameRate ? 30 : Math.round(source.frameRate) || 30) : 30

  width = even(width)
  height = even(height)
  fps = Math.max(1, fps)

  return { width, height, fps, bitrate: qualityBitrate(source, quality, width, height, fps), quality }
}

/**
 * The output timestamps one clip owns.
 *
 * Extracted and pure so the invariant can be tested: timestamps are derived
 * from the clip's position in the array, they are strictly increasing, and the
 * whole timeline yields exactly `ceil(duration × fps)` of them. A stored start
 * position instead of a derived one is how a clip drifts out of order (docs/data-model.md).
 */
/** Chunk size for feeding the audio encoder. Large enough to be cheap, small
 *  enough that the queue never holds a megabyte of PCM. */
const AUDIO_CHUNK_SECONDS = 0.5

/**
 * How often a key frame is written, in seconds.
 *
 * This is the single biggest size lever that has **no effect on quality** —
 * only on how precisely the finished file can be seeked. Measured with libvpx
 * on a 20 s sample of 1080p30 at CRF 28: a 2 s GOP is 1162 kbps, 5 s is
 * 535 kbps, 10 s is 326 kbps. The old value was 2 s, which made every export
 * two to three times larger than it needed to be.
 *
 * Five seconds is the compromise: a player lands within five seconds and
 * decodes forward, which goes unnoticed for a shared file, while the size drops
 * by more than half. Ten seconds halves it again (~326 kbps), but a seek can
 * then land up to ten seconds from the requested position — a hesitation that
 * is felt while scrubbing, so it is not free the way 2 s → 5 s is. Five is
 * where the trade stops paying off. Shorten it only if frame-accurate
 * scrubbing of the output matters more than its size.
 */
const KEYFRAME_SECONDS = 5

/** `KEYFRAME_SECONDS` as a frame count, for the encoder and the `add()` calls. */
function keyframeFrames(fps: number): number {
  return Math.max(1, Math.round(fps * KEYFRAME_SECONDS))
}

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
  // docs/export.md#av-sync warns about. Boundaries are rounded to whole frames once, then
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

/**
 * Total frames for a timeline.
 *
 * The **video lane** defines the output length, not the longer of the two. An
 * audio clip that outlasts the picture is not something to pad the video with
 * black for; it is simply not heard past the last frame.
 */
/**
 * Where to read each frame of a clip from in the SOURCE file.
 *
 * Distinct from `frameTimesForClip`, which answers "when does this frame appear
 * on the timeline". A clip cut from 10s to 25s of a seven-minute file starts its
 * first frame at source 10s, not source 0s — conflating the two exports the
 * whole source from its beginning, which is what a 15s trim turned into a
 * 7-minute file.
 *
 * `from` is the frame offset inside the clip the run starts at, for a schedule
 * segment that covers only part of a clip: an upper track's clip can occlude the
 * head or tail of the clip below it.
 */
export function sourceTimesForClip(clip: Clip, count: number, fps: number, from = 0): number[] {
  const times: number[] = []
  for (let i = 0; i < count; i++) {
    times.push(Number((clip.in + (from + i) / fps).toFixed(6)))
  }
  return times
}

export function totalFramesFor(project: Project, fps: number): number {
  return Math.ceil(projectDuration(project) * fps)
}

/** One contiguous run of output frames, all painted the same way. */
export interface VideoSegment {
  /** First output frame, inclusive. */
  startF: number
  /** One past the last output frame. */
  endF: number
  /** Which clip paints the span, or null for black. */
  clip: Clip | null
  /** The clip's own first frame on the timeline, for source-time derivation. */
  clipStartF: number
  /** Set when the black came from hiding this clip rather than from a gap. */
  hiddenClip: Clip | null
}

/**
 * The compositing schedule: which clip owns every output frame.
 *
 * This is the export side of ADR-1. The preview decides what to paint with
 * `paintIntentAt` — topmost video track first, a hidden clip stops the walk,
 * a gap lets the track below show through — and this makes the exported file
 * agree with it frame for frame, or preview and export drift the moment there
 * is more than one video track.
 *
 * Frame space, not seconds: clip boundaries are rounded to whole frames exactly
 * once (`round(t * fps)`), the same rule `frameTimesForClip` states, so
 * neighbouring segments tile the timeline with no gap or overlap however the
 * clips were laid out. Consecutive frames with the same winner are merged into
 * one segment, which is what keeps decoding batched per clip — seeking per
 * frame is 13x slower (docs/export.md).
 */
export function videoSchedule(
  videoTracks: readonly Clip[][],
  fps: number,
  totalFrames: number,
): VideoSegment[] {
  interface Range {
    startF: number
    endF: number
    clip: Clip
    clipStartF: number
  }

  const bounds = new Set<number>([0, totalFrames])
  const clamp = (f: number): number => Math.max(0, Math.min(totalFrames, f))
  const ranges: Range[][] = videoTracks.map((clips) =>
    clips.flatMap((clip, i) => {
      const startF = Math.round(clipStart(clips, i) * fps)
      const endF = Math.round((clipStart(clips, i) + clipDuration(clip)) * fps)
      bounds.add(clamp(startF))
      bounds.add(clamp(endF))
      return endF > startF ? [{ startF, endF, clip, clipStartF: startF }] : []
    }),
  )

  const segments: VideoSegment[] = []
  const push = (startF: number, endF: number, clip: Clip | null, clipStartF: number, hiddenClip: Clip | null): void => {
    if (endF <= startF) return
    const last = segments.at(-1)
    if (last && last.clip === clip && last.clipStartF === clipStartF && last.hiddenClip === hiddenClip) {
      last.endF = endF
      return
    }
    segments.push({ startF, endF, clip, clipStartF, hiddenClip })
  }

  const sorted = [...bounds].sort((a, b) => a - b)
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i]!
    const b = sorted[i + 1]!
    if (b <= a) continue

    let winner: Clip | null = null
    let winnerStartF = 0
    let hiddenClip: Clip | null = null
    // Topmost track first. A clip that covers the whole interval decides: a
    // hidden clip is deliberate black and stops the search, a visible clip
    // paints, and no clip at all is a hole the track below may fill.
    search: for (let t = ranges.length - 1; t >= 0; t--) {
      for (const r of ranges[t]!) {
        if (r.startF <= a && a < r.endF) {
          if (r.clip.hidden === true) hiddenClip = r.clip
          else {
            winner = r.clip
            winnerStartF = r.clipStartF
          }
          break search
        }
      }
    }
    push(a, b, winner, winnerStartF, hiddenClip)
  }

  return segments
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

  /**
   * `formatId` is the user's pick from the dialog's format list. It is a hint,
   * not a command: if that combination is not encodable here, the best
   * available one is used, because a request the browser cannot satisfy should
   * degrade rather than fail.
   */
  async run(
    project: Project,
    settings: ExportSettings,
    audio: ExportAudio | null,
    formatId?: string,
  ): Promise<ExportResult> {
    this.#cancelled = false
    const t0 = performance.now()

    const videoTracks = project.tracks.filter((t) => t.type === 'video').map((t) => t.clips)
    const audioClipCount = project.tracks.reduce((n, t) => (t.type === 'audio' ? n + t.clips.length : n), 0)
    if (videoTracks.every((clips) => clips.length === 0)) {
      throw new Error(audioClipCount > 0
        ? 'The timeline has audio but no video. Export needs at least one video clip.'
        : 'Add a video to the timeline first.')
    }
    const duration = projectDuration(project)
    if (duration <= 0) throw new Error('There is nothing on the timeline to export.')

    this.#onProgress({ stage: 'preparing', progress: 0, framesDone: 0, framesTotal: 0, fps: 0, eta: 0 })

    const plan = await negotiate(
      {
        needsAudio: audio !== null,
        width: settings.width,
        height: settings.height,
        fps: settings.fps,
        bitrate: settings.bitrate,
      },
      formatId,
    )
    if (!plan) {
      throw new Error('This browser cannot encode H.264 or VP9, so there is nothing to export with.')
    }

    const label = `${plan.label} [requested: ${formatId ?? 'default'}]`
    log.info(`export: ${label} ${settings.width}x${settings.height} @ ${settings.fps}`)
    for (const note of plan.notes) log.info(`  skipped ${note}`)
    if (plan.degraded) log.warn(`export fell back to ${label} — see docs/decisions/0008-negotiate-never-hardcode-a-codec.md`)

    const out = new Output({ format: plan.format, target: new BufferTarget() })

    const canvas = new OffscreenCanvas(settings.width, settings.height)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Could not create an export canvas.')

    const canvasSource = new CanvasSource(canvas, {
      codec: plan.video,
      // Constant quality, not a bitrate budget. A bitrate target spends far more
      // than simple footage needs; the quantizer spends only what each frame
      // requires. `bitrate` is the fallback for codecs with no quantizer support.
      quality: new Quality({ quantizer: qualityQuantizer(settings.quality), bitrate: settings.bitrate }),
      keyFrameInterval: keyframeFrames(settings.fps),
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
    const schedule = videoSchedule(videoTracks, settings.fps, totalFrames)
    const renderOptions = { width: settings.width, height: settings.height }
    const frameDuration = 1 / settings.fps

    let done = 0
    let lastReport = 0

    try {
      await out.start()

      // The schedule walks the WHOLE timeline, not just the clips: a gap
      // between clips is still timeline, and the video must hold black for its
      // duration or the export comes out shorter than the timeline and every
      // frame after the gap is wrong.
      //
      // `startF`/`endF` are FRAME indices. The timestamp handed to `add()` is
      // seconds — multiplying and dividing by totalFrames cancels to 1 and
      // yields the bare frame index, which silently turned a 15s timeline into
      // a 449s file.
      for (const seg of schedule) {
        this.#checkCancelled()
        const count = seg.endF - seg.startF
        if (count <= 0) continue

        const entry = seg.clip ? this.#library.get(seg.clip.assetId) : undefined
        const black = !seg.clip || clipRendersBlack(seg.clip, Boolean(entry?.videoSink))
        if (black) {
          // A gap, a hidden clip, or an audio-only file on a video track. All
          // three occupy their span, so the output needs that many black frames
          // — and none of them decodes: painting frames just to fill them black
          // would make hiding a long clip slower than deleting it.
          if (seg.hiddenClip) log.info(`export: clip ${seg.hiddenClip.id} is hidden — writing black`)
          for (let k = seg.startF; k < seg.endF; k++) {
            this.#checkCancelled()
            renderBlank(ctx, renderOptions)
            await canvasSource.add(k * frameDuration, frameDuration)
            done++
          }
          continue
        }

        const clip = seg.clip!
        const outTimes: number[] = []
        for (let k = seg.startF; k < seg.endF; k++) {
          outTimes.push(Number((k / settings.fps).toFixed(6)))
        }
        // `outTimes` is the tested mapping from frame index to output
        // timestamp; `sourceTimesForClip` is the matching seek into the media
        // file. They are different numbers and must not share an array.
        const sourceTimes = sourceTimesForClip(clip, count, settings.fps, seg.startF - seg.clipStartF)

        // Narrowed by the `black` test above, which is the only thing that
        // could have sent us down this path.
        const sink = entry!.videoSink!
        let at = 0
        for await (const wrapped of sink.canvasesAtTimestamps(sourceTimes)) {
          this.#checkCancelled()
          // The frame's place on the OUTPUT timeline, not in the source.
          const t = outTimes[at++] ?? (seg.startF + at - 1) * frameDuration

          if (wrapped) {
            renderFrame(
              ctx,
              { image: wrapped.canvas, width: wrapped.canvas.width, height: wrapped.canvas.height },
              clip,
              entry!.asset.isImage ? { ...renderOptions, fit: 'cover' } : renderOptions,
            )
          } else {
            renderBlank(ctx, renderOptions)
          }

          await canvasSource.add(t, frameDuration, { keyFrame: done % keyframeFrames(settings.fps) === 0 })
          done++

          const nowMs = performance.now()
          if (nowMs - lastReport > 200) {
            lastReport = nowMs
            this.#tick(done, totalFrames, t0)
          }
        }
        // A short clip may yield fewer frames than the segment owns; fill the rest.
        while (at < count) {
          this.#checkCancelled()
          renderBlank(ctx, renderOptions)
          await canvasSource.add((seg.startF + at) * frameDuration, frameDuration)
          at++
          done++
        }
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
