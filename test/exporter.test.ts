/**
 * The export timestamp mapping.
 *
 * These are the invariants that keep a multi-clip timeline from silently
 * producing a file that is the wrong length, out of order, or with a gap. They
 * are pure functions precisely so they can be checked without a browser, an
 * encoder, or a media file.
 */
import assert from 'node:assert/strict'
import { frameTimesForClip, totalFramesFor } from '../src/exporter.ts'
import { projectDuration, type Clip, type Project } from '../src/project.ts'

const c = (id: string, i: number, o: number): Clip => ({ id, assetId: 'a', in: i, out: o })
const project = (clips: Clip[]): Project => ({ version: 1, assets: {}, clips })

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
