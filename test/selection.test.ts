/**
 * Clip selection.
 *
 * Extracted from the store specifically so this could be tested without a
 * browser, a project store, or any of the audio and media machinery. The
 * policy worth pinning here is not the mechanics of a Set — it is the three
 * judgement calls that are easy to get wrong and impossible to notice:
 *
 *   - a plain click on an already-selected clip keeps the multi-selection
 *   - a range extends from the *primary*, and merges rather than replaces
 *   - a selection that outlives its clips is pruned, not left to rot
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createSelection } from '../src/app/selection.ts'
import { emptyProject, type Clip, type Project } from '../src/model/project.ts'

const clip = (id: string, lane: 'video' | 'audio' = 'video'): Clip => ({
  id, lane, assetId: 'a', in: 0, out: 5,
})

function withClips(...clips: Clip[]): Project {
  return {
    ...emptyProject(),
    video: clips.filter((c) => c.lane === 'video'),
    audio: clips.filter((c) => c.lane === 'audio'),
  }
}

/** Video lane a, b, c then audio lane a1, b1. */
function timeline(): Project {
  return withClips(clip('a'), clip('b'), clip('c'), clip('a1', 'audio'), clip('b1', 'audio'))
}

test('a plain click selects exactly one clip', () => {
  const s = createSelection(timeline())
  s.select('a')
  assert.deepEqual(s.ids(), ['a'])
  assert.equal(s.count(), 1)
  assert.equal(s.primary(), 'a')
})

test('a plain click on an already-selected clip keeps a multi-selection', () => {
  // The one that is easy to break: ctrl-click three clips, then click one of
  // them again to move it, and the other two silently vanish.
  const s = createSelection(timeline())
  s.select('a')
  s.select('b', 'toggle')
  s.select('c', 'toggle')
  assert.equal(s.count(), 3)

  s.select('b')
  assert.equal(s.count(), 3, 'clicking a member must not collapse the selection')
  assert.equal(s.primary(), 'b', 'but it does become the primary')
})

test('clicking the sole selected clip again is a no-op', () => {
  const s = createSelection(timeline())
  s.select('a')
  s.select('a')
  assert.deepEqual(s.ids(), ['a'])
})

test('ctrl-click toggles a clip in and out', () => {
  const s = createSelection(timeline())
  s.select('a')
  s.select('b', 'toggle')
  assert.deepEqual(s.ids(), ['a', 'b'])
  s.select('b', 'toggle')
  assert.deepEqual(s.ids(), ['a'])
})

test('the last clicked clip is the primary', () => {
  const s = createSelection(timeline())
  s.select('a')
  s.select('b', 'toggle')
  s.select('c', 'toggle')
  assert.equal(s.primary(), 'c')
})

test('setPrimary promotes without changing membership', () => {
  const s = createSelection(timeline())
  s.select('a')
  s.select('b', 'toggle')
  s.select('c', 'toggle')
  s.setPrimary('a')
  assert.equal(s.primary(), 'a')
  assert.equal(s.count(), 3)
  assert.deepEqual([...s.ids()].sort(), ['a', 'b', 'c'])
})

test('setPrimary on an unselected clip does nothing', () => {
  const s = createSelection(timeline())
  s.select('a')
  s.setPrimary('c')
  assert.deepEqual(s.ids(), ['a'], 'no phantom selection')
})

test('shift-click selects the span, in timeline order', () => {
  const s = createSelection(timeline())
  s.select('a')
  s.select('c', 'range')
  assert.deepEqual(s.ids(), ['a', 'b', 'c'])
})

test('shift-click works backwards', () => {
  const s = createSelection(timeline())
  s.select('c')
  s.select('a', 'range')
  assert.deepEqual(s.ids(), ['a', 'b', 'c'])
})

test('a range spans lanes, in video-then-audio order', () => {
  const s = createSelection(timeline())
  s.select('b')
  s.select('b1', 'range')
  assert.deepEqual(s.ids(), ['b', 'c', 'a1', 'b1'])
})

test('a range after a toggle merges rather than discarding', () => {
  // ctrl then shift should extend the existing selection, not eat it. The span
  // runs from the primary ('c') to the target, so it covers c, a1, b1 — and
  // 'a' survives because it was already selected, not because it was spanned.
  const s = createSelection(timeline())
  s.select('a')
  s.select('c', 'toggle')
  s.select('b1', 'range')
  assert.deepEqual([...s.ids()].sort(), ['a', 'a1', 'b1', 'c'])
  assert.ok(!s.ids().includes('b'), "'b' was never selected and the span skipped it")
})

test('a range from a clip that has since vanished falls back to one clip', () => {
  const s = createSelection(timeline())
  s.select('a')
  s.select('b', 'toggle')
  // 'a' is removed from the project without pruning, as if a stale anchor.
  s.replaceAll(['b'])
  s.select('c', 'range')
  assert.deepEqual(s.ids(), ['b', 'c'], 'no crash, and a sensible span')
})

test('selected clips come back in timeline order regardless of click order', () => {
  const s = createSelection(timeline())
  s.select('c')
  s.select('a1', 'toggle')
  assert.deepEqual(s.clips().map((c) => c.id), ['c', 'a1'])
})

test('lanes reports only the lanes that actually hold a selection', () => {
  const s = createSelection(timeline())
  s.select('a')
  assert.deepEqual(s.lanes(), ['video'])
  s.select('a1', 'toggle')
  assert.deepEqual(s.lanes(), ['video', 'audio'])
})

test('selectAll takes both lanes', () => {
  const s = createSelection(timeline())
  s.selectAll()
  assert.equal(s.count(), 5)
  assert.deepEqual(s.lanes(), ['video', 'audio'])
})

test('replaceAll overwrites whatever was selected', () => {
  const s = createSelection(timeline())
  s.selectAll()
  s.replaceAll(['b'])
  assert.deepEqual(s.ids(), ['b'])
  s.replaceAll([])
  assert.equal(s.count(), 0)
})

test('prune drops ids whose clip is gone', () => {
  const project = timeline()
  const s = createSelection(project)
  s.selectAll()
  assert.equal(s.count(), 5)

  // Simulate the store having removed one lane's clips.
  project.video = [clip('a')]
  s.prune()
  assert.deepEqual([...s.ids()].sort(), ['a', 'a1', 'b1'], 'only the surviving clips remain')
})

test('prune removes everything when the timeline is emptied', () => {
  const project = timeline()
  const s = createSelection(project)
  s.selectAll()
  project.video = []
  project.audio = []
  s.prune()
  assert.equal(s.count(), 0, 'a selection of nothing is not a selection')
})

test('prune keeps the primary when that clip survives', () => {
  const project = timeline()
  const s = createSelection(project)
  s.select('a')
  s.select('c', 'toggle')
  project.video = [clip('a'), clip('b'), clip('c')]
  s.prune()
  assert.equal(s.primary(), 'c')
})

test('selecting a clip that is not in the project is harmless', () => {
  const s = createSelection(timeline())
  s.select('ghost')
  assert.deepEqual(s.ids(), ['ghost'], 'recorded, but it resolves to no clip')
  assert.deepEqual(s.clips(), [], 'and contributes nothing to the selection')
})

test('an empty timeline selects nothing', () => {
  const s = createSelection(emptyProject())
  s.selectAll()
  assert.equal(s.count(), 0)
})
