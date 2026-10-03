/**
 * Position arithmetic is linear, not quadratic — and says so out loud.
 *
 * The invariant under test is deliberately a *shape*, not a timing: `clipStart`
 * sums the lane from zero, which is free once and catastrophic in a loop, and the
 * loops were everywhere. `clipAtLane` asked per index on every preview frame,
 * `collectTargets` per index on every trim `pointermove`, and the lane's `<For>`
 * asked per clip on every repaint.
 *
 * So this asserts the *number of summations* rather than the wall clock. A timing
 * assertion would be flaky on shared CI and would stop catching the bug on a fast
 * machine; counting the calls catches it everywhere, and is why it is written
 * against a counting proxy rather than a stopwatch.
 *
 * The correctness half matters just as much: these are the same numbers as before,
 * and "faster" is worthless if they differ. Exact equality is asserted against
 * `clipStart`, and `clipAtLane` is compared against the definition it replaced at
 * every 17ms of a lane built out of the shapes that break hand-rolled
 * accumulators — offsets, a zero-length clip, a leading gap.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  clipAtLane,
  clipDuration,
  clipOffset,
  clipStart,
  clipStarts,
  laneDuration,
  type Clip,
  type Project,
} from '../src/model/project.ts'
import { collectTargets } from '../src/model/snapping.ts'

const vid = (i: number, extra: Partial<Clip> = {}): Clip => ({
  id: `c${i}`,
  lane: 'video',
  assetId: 'a',
  in: 0,
  out: 1,
  ...extra,
})

const lane = (n: number, extra: Partial<Clip> = {}): Clip[] =>
  Array.from({ length: n }, (_, i) => vid(i, extra))

/**
 * Count how many times each clip is *touched* while positions are computed.
 *
 * Not a stopwatch: a quadratic pass over N clips touches each one a growing
 * number of times, and counting is exact where timing is not. The proxy
 * intercepts `offset` and `in`/`out`, which is everything the arithmetic reads.
 */
function touchCount(n: number, run: (clips: Clip[]) => void): number {
  const clips = lane(n)
  let touches = 0
  const counted = clips.map((c) => ({
    get id() { return c.id },
    get lane() { return c.lane },
    get assetId() { return c.assetId },
    get in() { touches++; return c.in },
    get out() { touches++; return c.out },
    get offset() { touches++; return c.offset },
  })) as Clip[]
  run(counted)
  return touches
}

// --- the shape -------------------------------------------------------------

test('a clip lookup touches each clip a constant number of times', () => {
  // The preview calls this once per frame. Quadratic here is 72 ms of every second
  // of playback on a long timeline.
  const single = touchCount(64, (clips: Clip[]) => { clipAtLane(clips, 32.5) })
  const double = touchCount(128, (clips: Clip[]) => { clipAtLane(clips, 64.5) })
  assert.ok(
    double < single * 3,
    `doubling the lane more than doubled the work: ${single} → ${double} touches. That is quadratic.`,
  )
})

test('a playhead past the end of the lane is a gap, not a clip', () => {
  // Worth stating because it walks the whole lane and returns null. There used to
  // be an early exit here for a playhead *before* the lane, which `seek` clamps
  // away before it can happen — so it was a branch and a comment for an
  // unreachable case, and it is gone.
  const clips = lane(500)
  assert.equal(clipAtLane(clips, laneDuration(clips)), null, 'the end is not inside the last clip')
  assert.equal(clipAtLane(clips, laneDuration(clips) + 60), null)
  assert.equal(clipAtLane(clips, -5), null)
  assert.equal(clipAtLane(lane(500), 499.5)?.index, 499, 'but the last clip is still findable')
})

test('every position in a lane costs one pass, not one pass per clip', () => {
  // This is what a repaint does, and what a `<For>` over N clips used to do
  // N times over: 3.1 ms to lay out an 800-clip lane, on every drag frame.
  const touches = touchCount(64, (clips: Clip[]) => { clipStarts(clips) })
  assert.ok(
    touches <= 64 * 3,
    `clipStarts touched ${touches} clips for 64; a per-clip accessor would touch ~2000`,
  )
})

test('collecting snap targets is linear in clips', () => {
  // Called on every trim `pointermove`.
  const single = touchCount(64, (clips: Clip[]) => {
    collectTargets({ version: 2, assets: {}, video: clips, audio: [] }, { playhead: 0, includePlayhead: false })
  })
  const double = touchCount(128, (clips: Clip[]) => {
    collectTargets({ version: 2, assets: {}, video: clips, audio: [] }, { playhead: 0, includePlayhead: false })
  })
  assert.ok(double < single * 3, `${single} → ${double} touches: quadratic`)
})

// --- the numbers must not have changed ------------------------------------

test('clipStarts agrees with clipStart exactly', () => {
  const cases: Clip[][] = [
    lane(5),
    [vid(0, { offset: 3 }), vid(1), vid(2, { offset: 7 })],
    [vid(0, { offset: 5 })],
    [{ ...vid(0), out: 5 }, { ...vid(1), in: 1, out: 1 }, vid(2)], // zero-length in the middle
    [],
  ]
  let checked = 0
  for (const clips of cases) {
    const starts = clipStarts(clips)
    assert.equal(starts.length, clips.length)
    for (let i = 0; i < clips.length; i++) {
      assert.equal(starts[i], clipStart(clips, i), `clip ${i} of ${clips.length}`)
      checked++
    }
  }
  assert.ok(checked > 10, 'and it actually compared something')
})

test('a gap is part of the timeline in both answers', () => {
  const clips = [vid(0, { out: 4 }), vid(1, { out: 4, offset: 3 })]
  assert.deepEqual(clipStarts(clips), [0, 7], 'the second clip is at 4 + its own 3s offset')
  assert.equal(laneDuration(clips), 11)
})

test('clipAtLane matches the definition it replaced, at every instant', () => {
  // The old implementation was `clipStart(clips, i)` per index. Recomputed here
  // the slow way, deliberately: "faster" is worthless if the answer differs.
  const clips = [
    vid(0, { out: 4 }),
    vid(1, { out: 2, offset: 3 }),
    { ...vid(2), in: 1, out: 1 }, // zero-length: must be stepped over, never returned
    vid(3, { out: 3, offset: 5 }),
  ]
  const total = laneDuration(clips)
  const reference = (t: number) => {
    for (let i = 0; i < clips.length; i++) {
      const s = clipStart(clips, i)
      if (t >= s && t < s + clipDuration(clips[i]!)) return { clip: clips[i]!.id, index: i, start: s }
    }
    return null
  }

  let inside = 0
  let gaps = 0
  for (let t = 0; t <= total + 0.5; t += 0.017) {
    const loc = clipAtLane(clips, t)
    const want = reference(t)
    const got = loc ? { clip: loc.clip.id, index: loc.index, start: loc.start } : null
    assert.deepEqual(got, want, `t=${t.toFixed(3)}`)
    if (want) inside++
    else gaps++
  }
  assert.ok(inside > 100 && gaps > 20, `the sweep covered real clips (${inside}) and real gaps (${gaps})`)
})

test('a zero-length clip is never returned and never blocks a later one', () => {
  // A clip can arrive shorter than MIN_CLIP from an overwrite. It must be
  // invisible to the lookup without swallowing what follows it — and note the
  // clip *after* it starts at the same instant, because the sliver occupies no
  // time at all. So the answer at that instant is the next real clip, not nothing.
  const clips = [{ ...vid(0), out: 4 }, { ...vid(1), in: 1, out: 1 }, vid(2, { out: 4 })]
  const starts = clipStarts(clips)
  assert.equal(starts[1], 4, 'the sliver sits at 4')
  assert.equal(starts[2], 4, 'and so does the clip after it')
  assert.equal(clipAtLane(clips, 3.999)?.clip.id, 'c0', 'the clip before it still works')
  assert.equal(clipAtLane(clips, 4)?.clip.id, 'c2', 'at 4s the sliver is stepped over')
  assert.equal(clipAtLane(clips, 4.001)?.clip.id, 'c2')
  // Never the sliver, at any instant.
  for (let t = 0; t < 8; t += 0.01) {
    assert.notEqual(clipAtLane(clips, t)?.clip.id, 'c1', `the sliver was returned at t=${t}`)
  }
})

test('offsets contribute to the clip they belong to', () => {
  // A gap sits *before* a clip, so it counts toward where that clip lands. The
  // one thing the single-pass rewrite could have got wrong.
  const clips = [vid(0, { out: 2 }), vid(1, { out: 2, offset: 5 })]
  assert.equal(clipStarts(clips)[1], 7)
  assert.equal(clipOffset(clips[1]!), 5)
})

// --- what the callers now do ----------------------------------------------

test('snap targets carry the positions the bulk pass computed', () => {
  const clips = [vid(0, { out: 4 }), vid(1, { out: 2, offset: 3 })]
  const targets = collectTargets(
    { version: 2, assets: {}, video: clips, audio: [] } as Project,
    { playhead: 0, includePlayhead: false, lanes: ['video'] },
  )
  const starts = clipStarts(clips)
  const edges = targets.filter((t) => t.lane === 'video').map((t) => t.time)
  assert.deepEqual(edges, [0, 4, 7, 9], 'two clips, four edges, at the derived positions')
  assert.ok(targets.some((t) => t.kind === 'timeline-start' && t.time === 0))
  assert.equal(starts[1], 7)
})