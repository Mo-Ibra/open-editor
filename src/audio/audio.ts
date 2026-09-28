/**
 * Audio preparation for export.
 *
 * Two jobs, both of which the encoder will otherwise fail on:
 *
 *  1. **Resample to 48 kHz.** AAC via WebCodecs only accepts 44.1 and 48 kHz.
 *     Camera and screen-capture files are frequently 96 kHz, and some are
 *     192 kHz. Feeding the source rate straight to `AudioBufferSource` throws
 *     "not supported in this environment" and kills the export.
 *
 *  2. **Downmix to stereo.** AAC will take 5.1 in theory, but support is
 *     patchy and the result is needlessly large. Anything above 2 channels
 *     becomes stereo.
 *
 * Mixing stays deterministic (docs/decisions/0004-deterministic-audio-mixing.md): this module only does format
 * conversion, using a single `OfflineAudioContext` render per buffer. The
 * actual clip mixing is plain `Float32Array` arithmetic and lives in
 * `mixTimeline` below.
 */

export const OUTPUT_SAMPLE_RATE = 48000
export const OUTPUT_CHANNELS = 2

/**
 * Force a buffer into a shape the AAC encoder will accept.
 * Returns the input unchanged when it is already conformant.
 */
export async function conformAudioBuffer(buffer: AudioBuffer): Promise<AudioBuffer> {
  const needsResample = buffer.sampleRate !== OUTPUT_SAMPLE_RATE
  const needsDownmix = buffer.numberOfChannels > OUTPUT_CHANNELS

  if (!needsResample && !needsDownmix) return buffer

  const sampleRate = needsResample ? OUTPUT_SAMPLE_RATE : buffer.sampleRate
  const channels = Math.min(buffer.numberOfChannels, OUTPUT_CHANNELS)
  const frames = Math.max(1, Math.ceil((buffer.length * sampleRate) / buffer.sampleRate))

  // Web Audio does a proper band-limited resample. Doing this by hand with
  // linear interpolation would alias audibly, because 96k -> 48k is exact
  // decimation by two and anything above 24 kHz folds straight back down.
  const offline = new OfflineAudioContext(channels, frames, sampleRate)
  const source = offline.createBufferSource()

  if (channels < buffer.numberOfChannels) {
    // Explicit downmix, so we control the gain. Web Audio's default
    // down-mixing of N channels to stereo divides by N, which is correct
    // for correlated content and 5 dB quiet for uncorrelated content.
    const merged = offline.createBuffer(channels, buffer.length, buffer.sampleRate)
    for (let ch = 0; ch < channels; ch++) {
      const target = merged.getChannelData(ch)
      for (let c = ch; c < buffer.numberOfChannels; c += channels) {
        const src = buffer.getChannelData(c)
        for (let i = 0; i < src.length; i++) target[i]! += src[i]! / (buffer.numberOfChannels / channels)
      }
    }
    source.buffer = merged
  } else {
    source.buffer = buffer
  }

  source.connect(offline.destination)
  source.start(0)
  return offline.startRendering()
}

/**
 * Split a buffer into fixed-length chunks.
 *
 * The encoder places each `add()` call contiguously after the previous one,
 * so chunking is just a matter of not handing it one enormous buffer. 0.5 s
 * keeps memory flat and gives the encoder regular backpressure points.
 */
export function chunkAudioBuffer(buffer: AudioBuffer, seconds = 0.5): AudioBuffer[] {
  const chunkLength = Math.max(1, Math.round(buffer.sampleRate * seconds))
  const chunks: AudioBuffer[] = []

  for (let offset = 0; offset < buffer.length; offset += chunkLength) {
    const length = Math.min(chunkLength, buffer.length - offset)
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

/** Join consecutive buffers into one. Used to assemble a decoded range. */
export function concatAudioBuffers(buffers: AudioBuffer[]): AudioBuffer {
  const first = buffers[0]
  if (!first) {
    return new AudioBuffer({ length: 0, numberOfChannels: OUTPUT_CHANNELS, sampleRate: OUTPUT_SAMPLE_RATE })
  }
  if (buffers.length === 1) return first

  const channels = first.numberOfChannels
  const sampleRate = first.sampleRate
  const total = buffers.reduce((n, b) => n + b.length, 0)
  const out = new AudioBuffer({ length: total, numberOfChannels: channels, sampleRate })

  for (let ch = 0; ch < channels; ch++) {
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

// ---------------------------------------------------------------------------
// Deterministic mixing (docs/decisions/0004-deterministic-audio-mixing.md)
//
// Every position is an integer sample index computed once. Never accumulate
// float seconds across clips — that is the most common source of A/V drift
// (docs/export.md#av-sync), and it is a five-line bug that costs a day to find.
// ---------------------------------------------------------------------------

export interface MixSegment {
  /** Decoded source audio, trimmed to the clip, at the output sample rate. */
  buffer: AudioBuffer
  /** Timeline position, seconds. Converted to a sample index here, once. */
  start: number
  gain?: number
}

/**
 * Concatenate segments into one stereo buffer covering `duration` seconds.
 * Gaps are filled with silence rather than being skipped, so a gap in the
 * timeline is a gap in the audio and not a sync shift.
 */
export function mixTimeline(segments: MixSegment[], duration: number): AudioBuffer {
  const totalFrames = Math.ceil(duration * OUTPUT_SAMPLE_RATE)
  const out = new AudioBuffer({
    length: totalFrames,
    numberOfChannels: OUTPUT_CHANNELS,
    sampleRate: OUTPUT_SAMPLE_RATE,
  })

  const left = out.getChannelData(0)
  const right = out.getChannelData(1)

  for (const segment of segments) {
    const startSample = Math.round(segment.start * OUTPUT_SAMPLE_RATE)
    if (startSample >= totalFrames) continue

    const gain = segment.gain ?? 1
    const src = segment.buffer
    const srcLeft = src.getChannelData(0)
    const srcRight = src.numberOfChannels > 1 ? src.getChannelData(1) : srcLeft
    const count = Math.min(src.length, totalFrames - startSample)

    for (let i = 0; i < count; i++) {
      left[startSample + i]! += srcLeft[i]! * gain
      right[startSample + i]! += srcRight[i]! * gain
    }
  }

  return out
}
