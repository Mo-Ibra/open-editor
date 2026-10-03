/**
 * Group drag: moving a multi-selection as one rigid block.
 *
 * Pure model logic, so the placement rules are pinned without a pointer. The
 * gesture wiring lives in `use-timeline-drag.ts`; what is tested here is the
 * arithmetic it delegates to.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clipStart, moveSelectionTo, type Clip, type Project } from '../src/model/project.ts'

const clip = (id: string, lane: 'video' | 'audio', out = 5): Clip => ({
  id, lane, assetId: 'a', in: 0, out,
})

const project = (video: Clip[], audio: Clip[] = []): Project => ({ version: 2, assets: {}, video, audio })

/** Timeline start of every clip in a lane. */
const starts = (clips: Clip[]): number[] => clips.map((_, i) => clipStart(clips, i))

test('a group keeps its spacing, and clips after it are pushed along', () => {
  const p = project([clip('a', 'video'), clip('b', 'video'), clip('c', 'video'), clip('d', 'video')])
  assert.deepEqual(starts(p.video), [0, 5, 10, 15])

  // Drag b (at 5) to 7: b and c move by +2, d is pushed, a does not move.
  const moved = moveSelectionTo(p, 'video', 1, 7, new Set(['b', 'c']))
  assert.deepEqual(starts(moved.video), [0, 7, 12, 17], 'the block shifted, a stayed put, d was pushed')
  assert.equal(clipStart(moved.video, 2) - clipStart(moved.video, 1), 5, 'b and c keep their spacing')
})

test('a group dragged left butts against the clip in front rather than crossing it', () => {
  const p = project([clip('a', 'video'), clip('b', 'video'), clip('c', 'video'), clip('d', 'video')])
  // Drag c (at 10) far to the left. Its predecessor b ends at 10, so c can go no
  // further: the drag clamps instead of reordering a whole block.
  const moved = moveSelectionTo(p, 'video', 2, 2, new Set(['c', 'd']))
  assert.deepEqual(starts(moved.video), [0, 5, 10, 15], 'clamped flush against b, and d follows')
})

test('a linked pair moves in both lanes by the same delta', () => {
  const p = project([clip('v1', 'video', 10)], [clip('a1', 'audio', 10)])
  const moved = moveSelectionTo(p, 'video', 0, 3, new Set(['v1', 'a1']))
  assert.equal(clipStart(moved.video, 0), 3, 'picture moved')
  assert.equal(clipStart(moved.audio, 0), 3, 'and so did its sound')
})

test('a linked pair dragged left stays rigid when one lane hits a wall', () => {
  // The picture is at zero and cannot go left; the sound sits behind a gap at
  // 10 and "could" move to 7. Clamping each lane independently let the sound
  // travel while the picture stayed — the pair came apart between the lanes.
  // The block is rigid, so the wall belongs to the whole selection: neither
  // half moves. That is the honest cost of "the selected clips keep their
  // spacing", and it is the opposite of a silent desync.
  const p = project([clip('v1', 'video', 10)], [{ ...clip('a1', 'audio', 10), offset: 10 }])
  assert.equal(clipStart(p.video, 0), 0)
  assert.equal(clipStart(p.audio, 0), 10)

  const moved = moveSelectionTo(p, 'video', 0, -3, new Set(['v1', 'a1']))
  assert.equal(clipStart(moved.video, 0), 0, 'the picture is against the wall')
  assert.equal(clipStart(moved.audio, 0), 10, 'and the sound did not detach to keep going')
})

test('a group drag left is limited by the more constrained of the two lanes', () => {
  // Video's first selected clip is at 6 behind a predecessor ending at 6 (a
  // wall); audio's is at 8 with a predecessor ending at 0, so it could travel
  // to 0. The most constrained lane wins, and both move together.
  const p = project(
    [clip('v0', 'video', 6), clip('v1', 'video', 4)],
    [{ ...clip('a0', 'audio', 4), offset: 8 }],
  )
  assert.equal(clipStart(p.video, 1), 6)
  assert.equal(clipStart(p.audio, 0), 8)

  const moved = moveSelectionTo(p, 'video', 1, 2, new Set(['v1', 'a0']))
  assert.deepEqual(starts(moved.video), [0, 6], 'the video clip butts, it does not cross')
  assert.equal(clipStart(moved.audio, 0), 8, 'and the sound moved by the same achieved delta')
})

test('unselected clips between selected ones are pushed, never overlapped', () => {
  const p = project([clip('a', 'video'), clip('b', 'video'), clip('c', 'video')])
  // Select a and c but not b. Both move by +2; b has nowhere to go but forward.
  const moved = moveSelectionTo(p, 'video', 0, 2, new Set(['a', 'c']))
  assert.deepEqual(starts(moved.video), [2, 7, 12], 'a and c moved, b was pushed out of the way')
  assert.equal(starts(moved.video)[0], 2, 'the grabbed clip lands exactly where it was dragged')
})

test('clips whose own offset did not change keep their identity', () => {
  // A group drag must not remount the whole lane: `<For>` keys on the object
  // reference, and a fresh object per clip repaints every filmstrip. Only the
  // clip whose *own* offset moved — the first selected one, which gained a gap —
  // is a new object; the pushed clip after the group only shifts by derivation.
  const a = clip('a', 'video')
  const b = clip('b', 'video')
  const c = clip('c', 'video')
  const d = clip('d', 'video')
  const p = project([a, b, c, d])

  const moved = moveSelectionTo(p, 'video', 1, 7, new Set(['b', 'c']))
  assert.equal(moved.video[0], a, 'the clip before the group is reused')
  assert.notEqual(moved.video[1], b, 'the clip that gained a gap is a new object')
  assert.equal(moved.video[2], c, 'the rest of the group is reused')
  assert.equal(moved.video[3], d, 'and the pushed clip is reused — it only shifted by derivation')
})

test('a lane with nothing selected is returned untouched', () => {
  const p = project([clip('a', 'video')], [clip('a1', 'audio')])
  const moved = moveSelectionTo(p, 'video', 0, 3, new Set(['a']))
  assert.equal(moved.audio, p.audio, 'the untouched lane is the same reference, not a copy')
})
