/**
 * Group drag: moving a multi-selection as one rigid block.
 *
 * Pure model logic, so the placement rules are pinned without a pointer. The
 * gesture wiring lives in `use-timeline-drag.ts`; what is tested here is the
 * arithmetic it delegates to.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clipStart, moveClipsToTrack, moveSelectionTo, type Clip, type Project } from '../src/model/project.ts'

const clip = (id: string, trackId: string, out = 5): Clip => ({
  id, trackId, assetId: 'a', in: 0, out,
})

const project = (tracks: { id: string; type: 'video' | 'audio'; clips: Clip[] }[]): Project => ({
  version: 3, assets: {}, tracks,
})

const videoClips = (p: Project) => p.tracks.find((t) => t.type === 'video')!.clips
const audioClips = (p: Project) => p.tracks.find((t) => t.type === 'audio')!.clips

/** Timeline start of every clip in a track. */
const starts = (clips: Clip[]): number[] => clips.map((_, i) => clipStart(clips, i))

test('a group keeps its spacing, and clips after it are pushed along', () => {
  const p = project([{ id: 'video', type: 'video', clips: [clip('a', 'video'), clip('b', 'video'), clip('c', 'video'), clip('d', 'video')] }])
  assert.deepEqual(starts(videoClips(p)), [0, 5, 10, 15])

  const moved = moveSelectionTo(p, 'video', 1, 7, new Set(['b', 'c']))
  assert.deepEqual(starts(videoClips(moved)), [0, 7, 12, 17], 'the block shifted, a stayed put, d was pushed')
  assert.equal(clipStart(videoClips(moved), 2) - clipStart(videoClips(moved), 1), 5, 'b and c keep their spacing')
})

test('a group dragged left butts against the clip in front rather than crossing it', () => {
  const p = project([{ id: 'video', type: 'video', clips: [clip('a', 'video'), clip('b', 'video'), clip('c', 'video'), clip('d', 'video')] }])
  const moved = moveSelectionTo(p, 'video', 2, 2, new Set(['c', 'd']))
  assert.deepEqual(starts(videoClips(moved)), [0, 5, 10, 15], 'clamped flush against b, and d follows')
})

test('a linked pair moves in both tracks by the same delta', () => {
  const p = project([
    { id: 'video', type: 'video', clips: [clip('v1', 'video', 10)] },
    { id: 'audio', type: 'audio', clips: [clip('a1', 'audio', 10)] },
  ])
  const moved = moveSelectionTo(p, 'video', 0, 3, new Set(['v1', 'a1']))
  assert.equal(clipStart(videoClips(moved), 0), 3, 'picture moved')
  assert.equal(clipStart(audioClips(moved), 0), 3, 'and so did its sound')
})

test('a linked pair dragged left stays rigid when one track hits a wall', () => {
  const p = project([
    { id: 'video', type: 'video', clips: [clip('v1', 'video', 10)] },
    { id: 'audio', type: 'audio', clips: [{ ...clip('a1', 'audio', 10), offset: 10 }] },
  ])
  assert.equal(clipStart(videoClips(p), 0), 0)
  assert.equal(clipStart(audioClips(p), 0), 10)

  const moved = moveSelectionTo(p, 'video', 0, -3, new Set(['v1', 'a1']))
  assert.equal(clipStart(videoClips(moved), 0), 0, 'the picture is against the wall')
  assert.equal(clipStart(audioClips(moved), 0), 10, 'and the sound did not detach to keep going')
})

test('a group drag left is limited by the more constrained of the two tracks', () => {
  const p = project([
    { id: 'video', type: 'video', clips: [clip('v0', 'video', 6), clip('v1', 'video', 4)] },
    { id: 'audio', type: 'audio', clips: [{ ...clip('a0', 'audio', 4), offset: 8 }] },
  ])
  assert.equal(clipStart(videoClips(p), 1), 6)
  assert.equal(clipStart(audioClips(p), 0), 8)

  const moved = moveSelectionTo(p, 'video', 1, 2, new Set(['v1', 'a0']))
  assert.deepEqual(starts(videoClips(moved)), [0, 6], 'the video clip butts, it does not cross')
  assert.equal(clipStart(audioClips(moved), 0), 8, 'and the sound moved by the same achieved delta')
})

test('unselected clips between selected ones are pushed, never overlapped', () => {
  const p = project([{ id: 'video', type: 'video', clips: [clip('a', 'video'), clip('b', 'video'), clip('c', 'video')] }])
  const moved = moveSelectionTo(p, 'video', 0, 2, new Set(['a', 'c']))
  assert.deepEqual(starts(videoClips(moved)), [2, 7, 12], 'a and c moved, b was pushed out of the way')
  assert.equal(starts(videoClips(moved))[0], 2, 'the grabbed clip lands exactly where it was dragged')
})

test('clips whose own offset did not change keep their identity', () => {
  const a = clip('a', 'video')
  const b = clip('b', 'video')
  const c = clip('c', 'video')
  const d = clip('d', 'video')
  const p = project([{ id: 'video', type: 'video', clips: [a, b, c, d] }])

  const moved = moveSelectionTo(p, 'video', 1, 7, new Set(['b', 'c']))
  const vClips = videoClips(moved)
  assert.equal(vClips[0], a, 'the clip before the group is reused')
  assert.notEqual(vClips[1], b, 'the clip that gained a gap is a new object')
  assert.equal(vClips[2], c, 'the rest of the group is reused')
  assert.equal(vClips[3], d, 'and the pushed clip is reused — it only shifted by derivation')
})

test('a track with nothing selected is returned untouched', () => {
  const p = project([
    { id: 'video', type: 'video', clips: [clip('a', 'video')] },
    { id: 'audio', type: 'audio', clips: [clip('a1', 'audio')] },
  ])
  const moved = moveSelectionTo(p, 'video', 0, 3, new Set(['a']))
  assert.equal(audioClips(moved), audioClips(p), 'the untouched track is the same reference, not a copy')
})

/** Clips of the track with this id. */
const clipsOf = (p: Project, id: string) => p.tracks.find((t) => t.id === id)!.clips

test('a single clip dragged up joins the other video track at the pointer time', () => {
  const p = project([
    { id: 'v2', type: 'video', clips: [] },
    { id: 'video', type: 'video', clips: [clip('a', 'video'), clip('b', 'video')] },
    { id: 'audio', type: 'audio', clips: [] },
  ])
  const moved = moveClipsToTrack(p, 'v2', new Set(['b']), 'b', 7)
  assert.deepEqual(clipsOf(moved, 'video').map((c) => c.id), ['a'], 'it left the track it came from')
  assert.deepEqual(clipsOf(moved, 'v2').map((c) => c.id), ['b'])
  assert.equal(clipStart(clipsOf(moved, 'v2'), 0), 7, 'and starts where the pointer put it')
  assert.equal(clipsOf(moved, 'v2')[0]!.trackId, 'v2', 'the clip now belongs to the new track')
})

test('a group crossing tracks keeps its spacing and pushes the target along', () => {
  const p = project([
    { id: 'v2', type: 'video', clips: [clip('x', 'v2')] },
    { id: 'video', type: 'video', clips: [clip('a', 'video'), clip('b', 'video'), clip('c', 'video')] },
  ])
  const moved = moveClipsToTrack(p, 'v2', new Set(['b', 'c']), 'b', 3)
  assert.deepEqual(clipsOf(moved, 'v2').map((c) => c.id), ['x', 'b', 'c'], 'the existing clip stays in front')
  assert.deepEqual(starts(clipsOf(moved, 'v2')), [0, 5, 10])
  assert.equal(starts(clipsOf(moved, 'v2'))[2]! - starts(clipsOf(moved, 'v2'))[1]!, 5, 'b and c keep their spacing')
})

test('a linked pair crossing tracks keeps picture and sound in step', () => {
  const p = project([
    { id: 'v2', type: 'video', clips: [] },
    { id: 'video', type: 'video', clips: [clip('v1', 'video', 10)] },
    { id: 'audio', type: 'audio', clips: [clip('a1', 'audio', 10)] },
  ])
  const moved = moveClipsToTrack(p, 'v2', new Set(['v1', 'a1']), 'v1', 4)
  assert.equal(clipStart(clipsOf(moved, 'v2'), 0), 4, 'the picture moved layer and time')
  assert.equal(clipStart(clipsOf(moved, 'audio'), 0), 4, 'the sound followed by the same delta, staying linked')
  assert.deepEqual(clipsOf(moved, 'video'), [], 'and it left its old video track')
})

test('a target with a clip in the way pushes it right, never overlapping', () => {
  const p = project([
    { id: 'v2', type: 'video', clips: [clip('x', 'v2', 5)] },
    { id: 'video', type: 'video', clips: [clip('a', 'video')] },
  ])
  const moved = moveClipsToTrack(p, 'v2', new Set(['a']), 'a', 0)
  const v2 = clipsOf(moved, 'v2')
  assert.deepEqual(v2.map((c) => c.id), ['x', 'a'], 'the incumbent keeps the front, the mover lands after it')
  assert.deepEqual(starts(v2), [0, 5], 'no overlap: the mover was pushed to where the incumbent ends')
})

test('a clip pulled out of a track leaves a hole, not a shift', () => {
  const p = project([
    { id: 'v2', type: 'video', clips: [] },
    { id: 'video', type: 'video', clips: [clip('a', 'video'), clip('b', 'video'), clip('c', 'video')] },
  ])
  assert.deepEqual(starts(clipsOf(p, 'video')), [0, 5, 10])

  const moved = moveClipsToTrack(p, 'v2', new Set(['b']), 'b', 0)
  assert.deepEqual(clipsOf(moved, 'video').map((c) => c.id), ['a', 'c'], 'b is gone')
  assert.deepEqual(starts(clipsOf(moved, 'video')), [0, 10], 'c stays where it was; the hole is left open')
})

test('an anchor that is not in the selection changes nothing', () => {
  const p = project([
    { id: 'v2', type: 'video', clips: [] },
    { id: 'video', type: 'video', clips: [clip('a', 'video')] },
  ])
  const moved = moveClipsToTrack(p, 'v2', new Set(['a']), 'missing', 3)
  assert.equal(moved, p, 'the same project came back')
})
