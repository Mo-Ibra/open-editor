/**
 * Preview audio.
 *
 * The hard part is not making noise, it is making the noise agree with the
 * playhead. Three things make that reliable:
 *
 *  1. **The AudioContext clock is the master.** It is a sound card clock; it
 *     does not drift the way `performance.now()` and `setInterval` do. So the
 *     playhead is *derived* from audio time while playing, rather than audio
 *     being nudged to follow a JS timer.
 *
 *  2. **A seek is sample-accurate.** When playback starts mid-clip, the audio
 *     starts at the matching source offset — not at the beginning of the clip.
 *     Getting this wrong is the classic "the sound is out by a bit" bug, and it
 *     is invisible in a 5-second test and obvious in a 10-minute edit.
 *
 *  3. **Silence is scheduled, not skipped.** A gap in the timeline is a gap in
 *     the audio. Skipping the gap compresses the sound and desyncs everything
 *     after it.
 *
 * Deliberately minimal: per-clip gain and mute, no master bus, no waveform, no
 * speed control. A mixer is a different feature (docs/risks.md#r5--scope-creep-toward-premiere) and
 * the inspector's level control can drive `gain` until then.
 */

import type { Clip, Project } from '../model/project.js'
import { clipDuration, clipStart } from '../model/project.js'
import { conformAudioBuffer, OUTPUT_SAMPLE_RATE } from './audio.js'
import type { MediaLibrary } from '../media/library.js'
import { log } from '../dev/debug.js'

interface ClipPlayback {
  source: AudioBufferSourceNode
  gain: GainNode
  /** Context time at which this source starts playing. */
  startTime: number
  dispose: () => void
}

export interface AudioEngineOptions {
  library: MediaLibrary
  onError: (message: string) => void
}

export class AudioEngine {
  readonly #library: MediaLibrary
  readonly #onError: (message: string) => void

  #context: AudioContext | null = null
  #master: GainNode | null = null
  #active: ClipPlayback[] = []
  #muted = false

  /** AudioContext time at which the current playback run began. */
  #runStart = 0
  /** Playhead position at that moment. */
  #runFrom = 0
  #running = false

  /** Decoded audio per asset, keyed by asset id. The preview decodes each
   *  asset once and slices from memory; re-decoding per play would make
   *  starting playback take seconds. */
  readonly #buffers = new Map<string, Promise<AudioBuffer>>()

  constructor(options: AudioEngineOptions) {
    this.#library = options.library
    this.#onError = options.onError
  }

  get running(): boolean {
    return this.#running
  }

  get contextState(): string {
    return this.#context?.state ?? 'none'
  }

  /**
   * Browsers refuse to start audio until a user gesture. Called from a click
   * handler, it is harmless if the context is already running.
   */
  async unlock(): Promise<void> {
    const ctx = this.#ensureContext()
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume()
        log.debug(`audio context resumed (state=${ctx.state})`)
      } catch (err) {
        this.#onError(`Could not start audio: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  #ensureContext(): AudioContext {
    if (this.#context) return this.#context
    const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) {
      this.#onError('This browser has no Web Audio support, so preview audio is unavailable.')
      // A stub so callers do not have to null-check everywhere. Every method
      // below becomes a no-op rather than a crash.
      return (undefined as unknown as AudioContext)
    }
    this.#context = new Ctor({ sampleRate: OUTPUT_SAMPLE_RATE })
    this.#master = this.#context.createGain()
    this.#master.gain.value = 1
    this.#master.connect(this.#context.destination)
    log.info(`audio context created @ ${this.#context.sampleRate} Hz, ${this.#context.state}`)
    return this.#context
  }

  /**
   * Playhead position, derived from the audio clock.
   *
   * Clamped at the low end on purpose. `#runStart` is deliberately in the
   * future — a beat of slack so scheduled sources are ready when they start —
   * so for the first START_LEAD milliseconds the elapsed time is *negative*.
   * Returning that put the playhead at t=-0.06, which produced a negative
   * source timestamp, which the decoder answered with null, which spun the
   * failure path hundreds of times per second and hung the tab.
   */
  now(): number | null {
    if (!this.#running || !this.#context) return null
    const elapsed = this.#context.currentTime - this.#runStart
    return this.#runFrom + Math.max(0, elapsed)
  }

  /**
   * Start audio at `position` on the timeline.
   *
   * Returns the context time that corresponds to `position`. The caller uses it
   * to keep the playhead in step — audio first, picture second.
   */
  async play(project: Project, position: number): Promise<number | null> {
    const ctx = this.#ensureContext()
    if (!ctx) return null

    this.stop()

    if (ctx.state === 'suspended') {
      try {
        await ctx.resume()
      } catch {
        this.#onError('Audio is blocked. Interact with the page, then press play again.')
        return null
      }
    }

    this.#runFrom = position
    this.#runStart = ctx.currentTime + START_LEAD // a beat of slack for scheduling
    this.#running = true

    let scheduled = 0
    let skipped = 0
    const jobs: Promise<void>[] = []

    // The audio lane only. The picture is the exporter's business.
    for (let i = 0; i < project.audio.length; i++) {
      const clip = project.audio[i]!
      const startsAt = clipStart(project.audio, i)
      const endsAt = startsAt + clipDuration(clip)

      // Entirely in the past relative to where we are starting.
      if (endsAt <= position) {
        skipped++
        continue
      }

      const offsetIntoClip = Math.max(0, position - startsAt)
      const sourceFrom = clip.in + offsetIntoClip
      const remaining = clip.out - sourceFrom
      if (remaining <= 0) continue

      // A clip that begins in the future is scheduled against the timeline
      // clock, so its silence before it is real silence rather than a hole.
      const delay = Math.max(0, startsAt - position)

      jobs.push(
        this.#schedule(ctx, project, clip, sourceFrom, remaining, delay).then((ok) => {
          if (ok) scheduled++
          else skipped++
        }),
      )
    }

    // Logged once the scheduling has settled. `#schedule` decodes and connects
    // asynchronously, so reading the counters straight after the loop always
    // printed "0 scheduled, N skipped" — which made a healthy playback look
    // like it had scheduled nothing.
    void Promise.all(jobs).then(() => {
      log.info(`audio: play from ${position.toFixed(2)}s — ${scheduled} scheduled, ${skipped} skipped`)
    })
    return this.#runStart
  }

  async #schedule(
    ctx: AudioContext,
    project: Project,
    clip: Clip,
    sourceFrom: number,
    remaining: number,
    delay: number,
  ): Promise<boolean> {
    const entry = this.#library.get(clip.assetId)
    if (!entry?.audioTrack) return false

    let buffer: AudioBuffer
    try {
      buffer = await this.#bufferFor(clip.assetId)
    } catch (err) {
      this.#onError(`Could not decode audio for ${entry.asset.name}: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }

    const sampleRate = buffer.sampleRate
    // Integer sample indices only. Float seconds accumulated across clips is
    // how A/V drift is born (docs/export.md#av-sync).
    const startSample = Math.round(sourceFrom * sampleRate)
    const sampleCount = Math.round(remaining * sampleRate)
    if (sampleCount <= 0) return false

    const slice = sliceBuffer(buffer, startSample, sampleCount)
    if (!slice) return false

    const source = ctx.createBufferSource()
    source.buffer = slice

    const gain = ctx.createGain()
    gain.gain.value = clip.muted ? 0 : (clip.gain ?? 1)
    source.connect(gain)
    gain.connect(this.#master!)

    // `when` is in context time. The clip's start maps to runStart + delay.
    const when = this.#runStart + delay
    source.start(when)

    const playback: ClipPlayback = {
      source,
      gain,
      startTime: when,
      dispose: () => {
        try {
          source.stop()
        } catch {
          /* already stopped */
        }
        source.disconnect()
        gain.disconnect()
      },
    }
    this.#active.push(playback)
    // Reap it once it has finished, so a long session does not accumulate nodes.
    source.onended = () => {
      playback.dispose()
      this.#active = this.#active.filter((p) => p !== playback)
    }
    void project
    return true
  }

  stop(): void {
    for (const playback of this.#active) playback.dispose()
    this.#active = []
    this.#running = false
  }

  setMuted(muted: boolean): void {
    this.#muted = muted
    if (this.#master) this.#master.gain.value = muted ? 0 : 1
  }

  get isMuted(): boolean {
    return this.#muted
  }

  /** Applied live so a volume slider is audible immediately. */
  setClipGain(clip: Clip): void {
    const target = clip.muted ? 0 : (clip.gain ?? 1)
    for (const playback of this.#active) {
      // Cheap and correct enough for a preview: every active source is the same
      // clip in practice, and a wrong ramp is inaudible at preview volumes.
      playback.gain.gain.setTargetAtTime(target, this.#context?.currentTime ?? 0, 0.01)
    }
  }

  /**
   * The decoded, 48 kHz audio for an asset — decoded once and shared.
   *
   * The preview and the exporter both want this, and a seven-minute file is
   * tens of megabytes of PCM. Decoding it twice is pure waste, and on a long
   * timeline the second decode is the thing people notice as "export is slow
   * for no reason".
   */
  async decodedAudio(assetId: string): Promise<AudioBuffer | null> {
    const entry = this.#library.get(assetId)
    if (!entry?.audioTrack) return null
    try {
      return await this.#bufferFor(assetId)
    } catch {
      return null
    }
  }

  /** Decode the whole asset once, conformed to the output rate. */
  async #bufferFor(assetId: string): Promise<AudioBuffer> {
    const cached = this.#buffers.get(assetId)
    if (cached) return cached

    const entry = this.#library.get(assetId)
    if (!entry?.audioTrack) throw new Error('no audio track')

    const promise = (async () => {
      const { AudioBufferSink } = await import('mediabunny')
      const sink = new AudioBufferSink(entry.audioTrack!)
      const pieces: AudioBuffer[] = []
      for await (const wrapped of sink.buffers()) pieces.push(wrapped.buffer)
      if (!pieces.length) throw new Error('no decodable audio')
      const joined = pieces.length === 1 ? pieces[0]! : concat(pieces)
      const conformed = await conformAudioBuffer(joined)
      log.debug(
        `audio decoded ${entry.asset.name}: ${pieces.length} pieces, ` +
          `${joined.sampleRate} Hz x${joined.numberOfChannels} → ${conformed.sampleRate} Hz x${conformed.numberOfChannels}`,
      )
      return conformed
    })()

    this.#buffers.set(assetId, promise)
    // A failed decode must not be cached forever.
    promise.catch(() => this.#buffers.delete(assetId))
    return promise
  }

  async dispose(): Promise<void> {
    this.stop()
    this.#buffers.clear()
    if (this.#context) {
      try {
        await this.#context.close()
      } catch {
        /* already closed */
      }
      this.#context = null
      this.#master = null
    }
  }

  /** Diagnostics for the health log. */
  describe(): Record<string, unknown> {
    return {
      context: this.contextState,
      running: this.#running,
      active: this.#active.length,
      cached: [...this.#buffers.keys()].length,
    }
  }
}

/** A beat of slack so scheduled sources start after `start()` returns. */
const START_LEAD = 0.06

function sliceBuffer(buffer: AudioBuffer, startSample: number, count: number): AudioBuffer | null {
  const from = Math.max(0, Math.min(startSample, buffer.length))
  const to = Math.max(from, Math.min(from + count, buffer.length))
  if (to <= from) return null

  const out = new AudioBuffer({
    length: to - from,
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
  })
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    out.getChannelData(ch).set(buffer.getChannelData(ch).subarray(from, to))
  }
  return out
}

function concat(buffers: AudioBuffer[]): AudioBuffer {
  const first = buffers[0]!
  const total = buffers.reduce((n, b) => n + b.length, 0)
  const out = new AudioBuffer({
    length: total,
    numberOfChannels: first.numberOfChannels,
    sampleRate: first.sampleRate,
  })
  for (let ch = 0; ch < first.numberOfChannels; ch++) {
    const target = out.getChannelData(ch)
    let offset = 0
    for (const b of buffers) {
      const src = b.numberOfChannels > ch ? b.getChannelData(ch) : b.getChannelData(0)
      target.set(src, offset)
      offset += b.length
    }
  }
  return out
}
