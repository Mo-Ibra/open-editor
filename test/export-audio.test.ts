/**
 * The docs/export.md#av-sync sync invariants, and the arithmetic they exist to catch.
 *
 * These were written before the mixing code, on purpose. The plan says the
 * tests come first for A/V sync, and the float-accumulation bug in
 * `frameTimesForClip` was found this way — a test written afterwards would
 * have been written to match whatever the code did.
 *
 * Node has no AudioBuffer, so a minimal stand-in with the same shape. The code
 * under test only ever calls `getChannelData`, `length`, `sampleRate`,
 * `numberOfChannels` and `duration`.
 */
import assert from 'node:assert/strict'
import { buildExportAudio, verifyAudioTrack } from '../src/audio/export-audio.ts'
import { mixTimeline, type MixSegment } from '../src/audio/audio.ts'
import type { Project } from '../src/model/project.ts'

const RATE = 48000
const CHANNELS = 2

class FakeAudioBuffer {
  readonly data: Float32Array[]
  readonly sampleRate: number
  readonly numberOfChannels: number
  readonly length: number
  readonly size: number

  /** Mirrors both real AudioBuffer forms: positional and options-object. */
  constructor(
    a: number | { length: number; numberOfChannels: number; sampleRate: number },
    b?: number,
    c?: number,
    fill = 0,
  ) {
    const length = typeof a === 'number' ? a : a.length
    const channels = typeof a === 'number' ? (b as number) : a.numberOfChannels
    const rate = typeof a === 'number' ? (c as number) : a.sampleRate
    this.length = length
    this.numberOfChannels = channels ?? 2
    this.sampleRate = rate ?? RATE
    this.size = length * this.numberOfChannels * 4
    this.data = Array.from({ length: this.numberOfChannels }, () => new Float32Array(length).fill(fill))
  }

  get duration(): number {
    return this.length / this.sampleRate
  }

  getChannelData(ch: number): Float32Array {
    return this.data[ch]!
  }
}

// Install globally so the modules under test find it.
;(globalThis as { AudioBuffer?: unknown }).AudioBuffer = FakeAudioBuffer

/** The mixer walks the AUDIO lane. */
const project = (clips: Project['audio']): Project => ({ version: 2, assets: {}, video: [], audio: clips })
const clip = (id: string, i: number, o: number, extra: Record<string, unknown> = {}) =>
  ({ id, lane: 'audio', assetId: 'a', in: i, out: o, ...extra }) as Project['audio'][number]

const library = (assets: Record<string, boolean>) =>
  ({ get: (id: string) => (assets[id] ? ({ audioTrack: {}, asset: { name: `${id}.mp4` } } as never) : undefined) }) as never

const tone = (seconds: number, value: number) => {
  const buf = new FakeAudioBuffer(Math.round(seconds * RATE), CHANNELS, RATE, value)
  return buf as unknown as AudioBuffer
}

// --- the mixer lands exactly on the video duration -----------------------
{
  const segments: MixSegment[] = [{ buffer: tone(4, 0.5), start: 0 }]
  const mixed = mixTimeline(segments, 10) as unknown as FakeAudioBuffer
  assert.equal(mixed.length, 10 * RATE, '10s of video yields exactly 10s of samples')
  assert.equal(mixed.numberOfChannels, 2, 'stereo out')
}

// --- a gap in the timeline is silence, not a skip -------------------------
{
  // A clip at 5s, 2s long, in a 10s timeline. The first 5s must be silent, and
  // the sound must sit at 5s — skipping the gap would compress it to the front.
  const segments: MixSegment[] = [{ buffer: tone(2, 1), start: 5 }]
  const mixed = mixTimeline(segments, 10) as unknown as FakeAudioBuffer
  assert.equal(mixed.getChannelData(0)[0], 0, 'before the clip is silent')
  assert.equal(mixed.getChannelData(0)![Math.round(5.5 * RATE)], 1, 'the clip starts at 5s')
  assert.equal(mixed.getChannelData(0)[Math.round(4.99 * RATE)], 0, 'just before the clip is still silent')
  assert.equal(mixed.getChannelData(0)[Math.round(9.99 * RATE)], 0, 'after the clip is silent')
}

// --- gain is applied, mute is honoured ------------------------------------
{
  const segments: MixSegment[] = [
    { buffer: tone(1, 1), start: 0, gain: 0.5 },
    { buffer: tone(1, 1), start: 1, gain: 0 },
  ]
  const mixed = mixTimeline(segments, 2) as unknown as FakeAudioBuffer
  assert.equal(mixed.getChannelData(0)[0], 0.5, 'gain scales the samples')
  assert.equal(mixed.getChannelData(0)[Math.round(1.5 * RATE)], 0, 'a muted segment contributes nothing')
}

// --- overlapping clips sum, they do not clip to the last one -------------
{
  const segments: MixSegment[] = [
    { buffer: tone(1, 0.4), start: 0 },
    { buffer: tone(1, 0.4), start: 0 },
  ]
  const mixed = mixTimeline(segments, 1) as unknown as FakeAudioBuffer
  assert.ok(Math.abs(mixed.getChannelData(0)![0]! - 0.8) < 1e-6, 'overlapping segments sum')
}

// --- end to end: build a mix and hold it to the docs/export.md#av-sync assertions ----------
{
  const p = project([clip('a', 0, 4), clip('b', 2, 8), clip('c', 1, 3)])
  const track = await buildExportAudio(p, 12, {
    library: library({ a: true, b: true, c: true }),
    getAssetAudio: async () => tone(10, 0.3),
  })

  assert.ok(track, 'a track is produced')
  const check = verifyAudioTrack(track!, 12, 30)
  assert.deepEqual(check.problems, [], `expected no sync problems, got: ${check.problems.join('; ')}`)
  assert.ok(check.ok)
  assert.equal(track!.silent, false, 'a non-silent source gives a non-silent mix')
}

// --- a clip with no audio is skipped, not faked ---------------------------
{
  const p = project([clip('a', 0, 4), clip('b', 0, 4)])
  const track = await buildExportAudio(p, 4, {
    library: library({ a: true, b: false }),
    getAssetAudio: async (id) => (id === 'a' ? tone(10, 0.3) : null),
  })
  assert.ok(track, 'the audible clip still produces a track')
  assert.equal(verifyAudioTrack(track!, 4, 30).ok, true)
}

// --- a fully silent mix is reported, not shipped quietly -----------------
{
  const p = project([clip('a', 0, 4, { muted: true })])
  const track = await buildExportAudio(p, 4, {
    library: library({ a: true }),
    getAssetAudio: async () => tone(10, 0.9),
  })
  assert.ok(track, 'a track is still produced so timing can be checked')
  assert.equal(track!.silent, true, 'a muted clip mixes to silence')
  const check = verifyAudioTrack(track!, 4, 30)
  assert.ok(!check.ok, 'silence is a reported problem')
  assert.ok(check.problems.some((p) => p.includes('silent')), 'the silence is named')
}

// --- no audio anywhere means no track, not a silent one -------------------
{
  const p = project([clip('a', 0, 4)])
  const track = await buildExportAudio(p, 4, {
    library: library({ a: false }),
    getAssetAudio: async () => null,
  })
  assert.equal(track, null, 'no audio sources -> no track at all')
}

// --- short audio is caught ------------------------------------------------
{
  const track = { buffer: tone(4, 0.5) as unknown as AudioBuffer, silent: false }
  const check = verifyAudioTrack(track, 10, 30)
  assert.ok(!check.ok, 'audio shorter than the video is a problem')
  assert.ok(check.problems.some((p) => p.includes('short')), 'and it says so')

  // Within one frame of slack is acceptable, not a problem.
  const nearly = { buffer: tone(10 - 1 / 30 + 0.001, 0.5) as unknown as AudioBuffer, silent: false }
  assert.equal(verifyAudioTrack(nearly, 10, 30).ok, true, 'one frame of slack is fine')
}

console.log('export audio assertions passed')
