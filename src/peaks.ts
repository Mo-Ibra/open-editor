/**
 * Waveform peaks.
 *
 * The point of a waveform is to answer one question at a glance: *where does
 * the speech start and stop?* That means min and max per column, not a
 * high-resolution envelope — and it means the peaks must be computed once and
 * cached, because a 40-minute voiceover is 115 million samples and the timeline
 * redraws on every playhead move.
 *
 * Peaks are computed at a fixed rate (per second, not per pixel) and
 * downsampled when drawing. That means zooming in past the peak resolution
 * shows a slightly coarser wave, which is invisible in practice and vastly
 * cheaper than recomputing on zoom.
 */

export const PEAKS_PER_SECOND = 200

export interface Peak {
  min: number
  max: number
}

/**
 * Build peaks for a buffer, at a fixed resolution.
 *
 * Multi-channel audio is reduced to a single envelope (the loudest channel),
 * because a waveform with two overlapping shapes is harder to read, not
 * easier.
 */
export function computePeaks(
  buffer: Pick<AudioBuffer, 'getChannelData' | 'length' | 'numberOfChannels'>,
  peaksPerSecond = PEAKS_PER_SECOND,
): Peak[] {
  const sampleRate = (buffer as { sampleRate?: number }).sampleRate ?? 48000
  const perPeak = Math.max(1, Math.round(sampleRate / peaksPerSecond))
  const count = Math.ceil(buffer.length / perPeak)
  const peaks: Peak[] = new Array(count)

  const channels: Float32Array[] = []
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) channels.push(buffer.getChannelData(ch))

  for (let i = 0; i < count; i++) {
    const from = i * perPeak
    const to = Math.min(from + perPeak, buffer.length)
    let min = 0
    let max = 0
    for (const data of channels) {
      for (let j = from; j < to; j++) {
        const v = data[j]!
        if (v < min) min = v
        if (v > max) max = v
      }
    }
    peaks[i] = { min, max }
  }

  return peaks
}

export interface DrawPeaksOptions {
  /** Source range being drawn, in seconds. */
  startTime: number
  endTime: number
  /** Pixels available. */
  width: number
  height: number
  color: string
  /** Draw a centre line, so silence is visible as symmetry. */
  centreLine?: boolean
}

/**
 * Draw an envelope into `ctx`, spanning the given time range.
 *
 * Downsamples by taking the extreme across the peaks that fall in each pixel,
 * so a peak is never lost just because it is thinner than a pixel. That is the
 * difference between a waveform that is honest at any zoom and one that
 * quietly deletes transients.
 */
export function drawPeaks(
  ctx: CanvasRenderingContext2D,
  peaks: Peak[],
  bufferDuration: number,
  options: DrawPeaksOptions,
): void {
  const { startTime, endTime, width, height, color, centreLine = true } = options
  const span = endTime - startTime
  if (span <= 0 || width <= 0 || height <= 0 || peaks.length === 0) return

  const half = height / 2
  const rate = peaks.length / bufferDuration

  ctx.save()
  ctx.fillStyle = color

  for (let x = 0; x < width; x++) {
    // The time range this column covers.
    const t0 = startTime + (span * x) / width
    const t1 = startTime + (span * (x + 1)) / width

    let from = Math.floor(t0 * rate)
    let to = Math.ceil(t1 * rate)
    if (to <= from) to = from + 1
    from = Math.max(0, Math.min(from, peaks.length - 1))
    to = Math.max(from + 1, Math.min(to, peaks.length))

    let min = 0
    let max = 0
    for (let i = from; i < to; i++) {
      const peak = peaks[i]
      if (!peak) continue
      if (peak.min < min) min = peak.min
      if (peak.max > max) max = peak.max
    }

    const top = half - max * half
    const bottom = half - min * half
    ctx.fillRect(x, top, 1, Math.max(1, bottom - top))
  }

  if (centreLine) {
    ctx.fillStyle = 'rgba(255,255,255,0.12)'
    ctx.fillRect(0, half, width, 1)
  }

  ctx.restore()
}

// ---------------------------------------------------------------------------
// Silence detection
//
// Not in the first version of the waveform, but the peaks already contain
// everything needed, and it is the natural next step: dead air is what people
// are actually looking for.
// ---------------------------------------------------------------------------

export interface SilenceRegion {
  start: number
  end: number
}

export interface SilenceOptions {
  /** Anything quieter than this counts as silence. */
  threshold: number
  /** Ignore silences shorter than this, so breaths are not "dead air". */
  minDuration: number
}

export function findSilence(peaks: Peak[], duration: number, options: SilenceOptions): SilenceRegion[] {
  const { threshold, minDuration } = options
  const perSecond = peaks.length / duration
  const minPeaks = Math.max(1, Math.round(minDuration * perSecond))

  const regions: SilenceRegion[] = []
  let start = -1

  for (let i = 0; i < peaks.length; i++) {
    const peak = peaks[i]!
    const loud = Math.max(Math.abs(peak.min), Math.abs(peak.max)) >= threshold
    if (!loud && start < 0) start = i
    if (loud && start >= 0) {
      if (i - start >= minPeaks) regions.push({ start: start / perSecond, end: i / perSecond })
      start = -1
    }
  }

  // Trailing silence counts too.
  if (start >= 0 && peaks.length - start >= minPeaks) {
    regions.push({ start: start / perSecond, end: duration })
  }

  return regions
}
