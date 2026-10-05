/**
 * The export timestamp mapping.
 *
 * These are the invariants that keep a multi-clip timeline from silently
 * producing a file that is the wrong length, out of order, or with a gap. They
 * are pure functions precisely so they can be checked without a browser, an
 * encoder, or a media file.
 */
import assert from 'node:assert/strict'
import { clipRendersBlack, frameTimesForClip, totalFramesFor } from '../src/output/exporter.ts'
import { projectDuration, type Clip, type Project } from '../src/model/project.ts'

const c = (id: string, i: number, o: number): Clip => ({ id, trackId: 'video', assetId: 'a', in: i, out: o })
/** The exporter walks the VIDEO tracks; a real project also has audio tracks. */
const project = (clips: Clip[]): Project => ({
  version: 3,
  assets: {},
  tracks: [
    { id: 'video', type: 'video', clips },
    { id: 'audio', type: 'audio', clips: [] },
  ],
})

const clips = [c('a', 0, 10), c('b', 5, 25), c('c', 2, 4)] // 10s, 20s, 2s
const FPS = 30

// --- every clip's frames tile the timeline exactly, with no overlap or gap ---
const all = clips.flatMap((_, i) => frameTimesForClip(clips, i, 10_000, FPS))
assert.equal(all.length, totalFramesFor(project(clips), FPS), 'frames == ceil(duration * fps)')
assert.equal(all.length, 960, '32s at 30fps')

for (let i = 1; i < all.length; i++) {
  assert.ok(all[i]! > all[i - 1]!, `timestamp ${i} (${all[i]}) must exceed the previous (${all[i - 1]})`)
  assert.ok(all[i]! - all[i - 1]! <= 1 / FPS + 1e-6, `gap at ${i} exceeds one frame`)
}

assert.equal(all[0], 0, 'timeline starts at zero')
assert.equal(all.at(-1), Number((32 - 1 / FPS).toFixed(6)), 'last frame is one step before the end')

// --- clip boundaries land on frame boundaries ---
const firstClipTimes = frameTimesForClip(clips, 0, 10_000, FPS)
const secondClipTimes = frameTimesForClip(clips, 1, 10_000, FPS)
assert.equal(secondClipTimes[0], 10, 'the second clip starts where the first ended')
assert.ok(secondClipTimes[0]! > firstClipTimes.at(-1)!)

// --- budget caps the run: the last clip must not overrun the timeline ---
const tight = frameTimesForClip(clips, 2, 5, FPS)
assert.equal(tight.length, 5, 'budget is respected')

// --- a clip with no room gets nothing rather than a negative index ---
assert.deepEqual(frameTimesForClip(clips, 0, 0, FPS), [])
assert.deepEqual(frameTimesForClip([], 0, 10, FPS), [])

// --- fps rounding: 24 and 60 must both tile cleanly ---
for (const fps of [24, 25, 30, 50, 60]) {
  const times = clips.flatMap((_, i) => frameTimesForClip(clips, i, 10_000, fps))
  assert.equal(times.length, totalFramesFor(project(clips), fps), `fps ${fps}: frame count`)
  assert.equal(times[0], 0, `fps ${fps}: starts at zero`)
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i]! > times[i - 1]!, `fps ${fps}: monotonic at ${i}`)
  }
}

// --- an empty timeline exports nothing, rather than throwing ---
assert.equal(totalFramesFor(project([]), FPS), 0)
assert.equal(projectDuration(project([])), 0)

console.log('export timestamp assertions passed')

// ---------------------------------------------------------------------------
// Source vs output time
//
// A trimmed clip has two independent positions: where it sits on the timeline,
// and where it is read from in the source file. Conflating them exported the
// whole source from 0s, so a 15s cut of a 7-minute file came out 7 minutes long.
//
// The regression these guard: the output timestamp was built as
// `((cursor + i) * totalFrames) / totalFrames`, which cancels to `cursor + i` —
// a frame index handed to the muxer as if it were seconds.
// ---------------------------------------------------------------------------

import { sourceTimesForClip } from '../src/output/exporter.ts'

const FPS30 = 30

// --- the bug, stated as a property ---
{
  // A 15s clip cut from 10s to 25s of a 445.72s source.
  const trimmed: Clip = { id: 't', trackId: 'video', assetId: 'a', in: 10, out: 25 }

  const outTimes = frameTimesForClip([trimmed], 0, 10_000, FPS30)
  const sourceTimes = sourceTimesForClip(trimmed, outTimes.length, FPS30)

  assert.equal(outTimes.length, 450, '15s at 30fps is 450 frames')
  assert.equal(outTimes.at(-1), Number((15 - 1 / FPS30).toFixed(6)), 'output ends just under 15s')

  assert.equal(sourceTimes[0], 10, 'the first frame is read from 10s into the source')
  assert.equal(sourceTimes.at(-1), Number((25 - 1 / FPS30).toFixed(6)), 'the last from just under 25s')

  // The failure mode: output timestamps that are frame indices read as seconds.
  assert.ok(
    outTimes.every((t) => t < 16),
    `every output timestamp must be under 16s, got max ${Math.max(...outTimes)}`,
  )
  assert.notEqual(
    outTimes.length,
    Math.round(outTimes.at(-1)!),
    'the last timestamp must not equal the frame count',
  )
}

// --- a clip that starts at source zero is unaffected -----------------------
{
  const flush: Clip = { id: 'f', trackId: 'video', assetId: 'a', in: 0, out: 3 }
  assert.deepEqual(sourceTimesForClip(flush, 3, FPS30), [0, 0.033333, 0.066667])
}

// --- gaps and multiple clips: source times restart per clip ---------------
{
  const a: Clip = { id: 'a', trackId: 'video', assetId: 'a', in: 100, out: 102 }
  const b: Clip = { id: 'b', trackId: 'video', assetId: 'b', in: 5, out: 7 }
  const lane = [a, b]

  const firstOut = frameTimesForClip(lane, 0, 10_000, FPS30)
  const secondOut = frameTimesForClip(lane, 1, 10_000, FPS30)
  const firstSrc = sourceTimesForClip(a, firstOut.length, FPS30)
  const secondSrc = sourceTimesForClip(b, secondOut.length, FPS30)

  // Each clip reads from its own source, whatever its timeline position.
  assert.equal(firstSrc[0], 100)
  assert.equal(secondSrc[0], 5)

  // Output is continuous: clip b starts where clip a ended.
  assert.equal(secondOut[0], Number((2).toFixed(6)), 'b starts at 2s on the timeline')
  assert.equal(outTimesAreContiguous(firstOut, secondOut), true)
}

function outTimesAreContiguous(a: number[], b: number[]): boolean {
  return b[0]! > a.at(-1)!
}

// --- the whole-tile invariant still holds with the new mapping ------------
{
  const lane = [
    c('a', 0, 10),
    c('b', 5, 25),
    c('c', 2, 4),
  ]
  const out = lane.flatMap((_, i) => frameTimesForClip(lane, i, 10_000, FPS30))
  const src = lane.flatMap((cl, i) => sourceTimesForClip(cl, frameTimesForClip(lane, i, 10_000, FPS30).length, FPS30))

  assert.equal(out.length, 960, 'still 32s at 30fps')
  assert.equal(out.at(-1)!, 31.966667, 'output ends one frame before 32s')
  // The last source time must be inside its own source range, never past it.
  assert.ok(src.at(-1)! <= 4, `last source time ${src.at(-1)} must be within clip c (0–4s)`)
}

/**
 * Which clips come out black.
 *
 * The rule decides whether the exported file matches what the preview showed, so
 * it is pinned here rather than left inline in a 450-line loop. Two inputs: does
 * the asset have video at all, and did the user hide the clip.
 */
const blackFor = (clip: object, hasVideoSink: boolean): boolean => clipRendersBlack(clip as never, hasVideoSink)

const vid = (over: object = {}): object => ({ trackId: 'video', in: 0, out: 2, ...over })

assert.equal(blackFor(vid(), true), false, 'a normal video clip renders its frames')
assert.equal(
  blackFor(vid(), false),
  true,
  'an asset with no video track renders black — an audio file on the video lane, which still occupies its span',
)
assert.equal(
  blackFor(vid({ hidden: true }), true),
  true,
  'a hidden clip is black even when the asset decodes fine',
)
assert.equal(
  blackFor(vid({ hidden: false }), true),
  false,
  'an explicit hidden:false is not hidden — hence the `=== true` in the rule',
)
assert.equal(
  blackFor({ trackId: 'audio', in: 0, out: 2, muted: true }, true),
  false,
  'muting is a gain, not a picture decision; the video rule must not care',
)
