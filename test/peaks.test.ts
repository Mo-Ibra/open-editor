/**
 * Waveform peaks.
 *
 * The failure that matters here is a waveform that *looks* right and hides a
 * transient, because a user cutting on speech boundaries would then cut in the
 * wrong place with confidence. So the tests care about extremes being
 * preserved, not about the picture.
 */
import assert from 'node:assert/strict'
import { computePeaks, drawPeaks, findSilence, PEAKS_PER_SECOND, type Peak } from '../src/peaks.ts'

const RATE = 48000

const bufferOf = (values: Float32Array[]) => ({
  length: values[0]?.length ?? 0,
  numberOfChannels: values.length,
  sampleRate: RATE,
  getChannelData: (ch: number) => values[ch]!,
})

const seconds = (n: number) => Math.round(n * RATE)
/** Float32Array round-trips are not exact — 0.8 reads back as 0.80000001. */
const near = (a: number, b: number, tolerance = 1e-6) => Math.abs(a - b) <= tolerance
const ramp = (n: number, from: number, to: number) => {
  const data = new Float32Array(n)
  for (let i = 0; i < n; i++) data[i] = from + ((to - from) * i) / n
  return data
}

// --- a silent buffer is flat --------------------------------------------
{
  const peaks = computePeaks(bufferOf([new Float32Array(seconds(1))]))
  assert.equal(peaks.length, PEAKS_PER_SECOND, `${PEAKS_PER_SECOND} peaks per second`)
  for (const p of peaks) {
    assert.equal(p.min, 0)
    assert.equal(p.max, 0)
  }
}

// --- extremes are captured, not averaged --------------------------------
{
  // One spike per second at 1.0, silence otherwise. Averaging would flatten
  // this to near-nothing; the waveform must show the spike.
  const data = new Float32Array(seconds(3))
  for (const at of [0.5, 1.5, 2.5]) data[Math.round(at * RATE)] = 1
  const peaks = computePeaks(bufferOf([data]))
  const loudest = peaks.reduce((m, p) => Math.max(m, p.max), 0)
  assert.ok(near(loudest, 1), `a one-sample spike is fully preserved, got ${loudest}`)
  assert.ok(peaks.filter((p) => p.max > 0).length >= 3, 'all three spikes survive')
}

// --- min AND max, so the shape is symmetric ----------------------------
{
  const data = new Float32Array(seconds(1))
  data[100] = 0.8
  data[200] = -0.6
  const peaks = computePeaks(bufferOf([data]))
  assert.ok(near(peaks[0]!.max, 0.8), `positive excursion, got ${peaks[0]!.max}`)
  assert.ok(near(peaks[0]!.min, -0.6), `negative excursion, got ${peaks[0]!.min}`)
}

// --- multiple channels reduce to the loudest ----------------------------
{
  const quiet = new Float32Array(seconds(1))
  const loud = new Float32Array(seconds(1))
  quiet[0] = 0.1
  loud[0] = 0.9
  const peaks = computePeaks(bufferOf([quiet, loud]))
  assert.ok(near(peaks[0]!.max, 0.9), `the loudest channel wins, got ${peaks[0]!.max}`)
}

// --- stereo with content in only the right channel is not lost ----------
{
  const left = new Float32Array(seconds(1))
  const right = new Float32Array(seconds(1))
  right[10] = 0.7
  const peaks = computePeaks(bufferOf([left, right]))
  assert.ok(near(peaks[0]!.max, 0.7), `a signal on the right channel still shows, got ${peaks[0]!.max}`)
}

// --- silence detection --------------------------------------------------
{
  // Loud 0-1s, silent 1-3s, loud 3-4s.
  const data = new Float32Array(seconds(4))
  for (let i = 0; i < seconds(1); i++) data[i] = 0.5
  for (let i = seconds(3); i < seconds(4); i++) data[i] = 0.5
  const peaks = computePeaks(bufferOf([data]))

  const regions = findSilence(peaks, 4, { threshold: 0.01, minDuration: 0.5 })
  assert.equal(regions.length, 1, 'one run of silence')
  assert.ok(Math.abs(regions[0]!.start - 1) < 0.02, `silence starts at ~1s, got ${regions[0]!.start}`)
  assert.ok(Math.abs(regions[0]!.end - 3) < 0.02, `silence ends at ~3s, got ${regions[0]!.end}`)

  // A threshold of 0.01 against a 0.5 signal must not report the loud parts.
  assert.ok(!regions.some((r) => r.start < 0.5), 'loud audio is never called silence')

  // Minimum duration filters out a short gap between words.
  const short = findSilence(peaks, 4, { threshold: 0.01, minDuration: 5 })
  assert.equal(short.length, 0, 'a 2s silence is not a 5s silence')
}

// --- trailing silence is reported ---------------------------------------
{
  const data = new Float32Array(seconds(3))
  for (let i = 0; i < seconds(1); i++) data[i] = 0.5
  const peaks = computePeaks(bufferOf([data]))
  const regions = findSilence(peaks, 3, { threshold: 0.01, minDuration: 0.5 })
  assert.equal(regions.length, 1)
  assert.ok(Math.abs(regions[0]!.end - 3) < 0.02, 'runs to the end')
}

// --- drawing is total: no throw, no work for degenerate input -----------
{
  const pixels: number[] = []
  const ctx = {
    fillStyle: '',
    save() {},
    restore() {},
    fillRect(x: number, y: number, w: number, h: number) {
      pixels.push(Math.round(x), Math.round(y), Math.round(w), Math.round(h))
    },
  } as unknown as CanvasRenderingContext2D

  const data = ramp(seconds(1), -1, 1)
  const peaks = computePeaks(bufferOf([data]))

  drawPeaks(ctx, peaks, 1, { startTime: 0, endTime: 1, width: 100, height: 40, color: '#fff' })
  assert.ok(pixels.length > 100, 'it drew something for every column')

  // Degenerate inputs must be no-ops, not crashes: a clip being dragged can
  // produce a zero-width or inverted range momentarily.
  for (const opts of [
    { startTime: 0, endTime: 0, width: 10, height: 10, color: '#fff' },
    { startTime: 0, endTime: 1, width: 0, height: 10, color: '#fff' },
    { startTime: 0, endTime: 1, width: 10, height: 0, color: '#fff' },
    { startTime: 1, endTime: 0, width: 10, height: 10, color: '#fff' },
  ]) {
    drawPeaks(ctx, peaks, 1, opts)
  }
  drawPeaks(ctx, [], 1, { startTime: 0, endTime: 1, width: 10, height: 10, color: '#fff' })

  // A view outside the buffer must clamp rather than read past the end.
  drawPeaks(ctx, peaks, 1, { startTime: 0.5, endTime: 5, width: 10, height: 10, color: '#fff' })
}

console.log('peak assertions passed')
