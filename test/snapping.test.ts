/**
 * Magnetic snapping.
 *
 * The three behaviours that decide whether this feels right or feels broken:
 * the pixel threshold, the sticky latch, and never snapping a clip to itself.
 * All pure logic, so all testable without a mouse.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  collectTargets,
  nearestTarget,
  snapMove,
  snapPlayhead,
  snapTrimEdge,
  targetTracks,
  thresholdInSeconds,
  type SnapTarget,
} from '../src/model/snapping.ts'
import { clipStart, movingInTrack, placeClip, emptyProject, type Clip, type Project } from '../src/model/project.ts'

const clip = (id: string, inPoint: number, out: number, trackId: string = 'video'): Clip => ({
  id,
  trackId,
  assetId: 'a',
  in: inPoint,
  out,
})

const withAsset = (): Project => ({ ...emptyProject(), assets: { a: { duration: 100 } as never } })

const project = (tracks: { id: string; type: 'video' | 'audio'; clips: Clip[] }[]): Project => ({
  version: 3,
  assets: {},
  tracks,
})

const target = (time: number, id = 'other', kind: SnapTarget['kind'] = 'clip-start'): SnapTarget => ({
  time,
  kind,
  trackId: 'video',
  clipId: id,
})

function check(name: string, fn: () => void): void {
  try {
    fn()
  } catch (err) {
    console.error(`  ✗ ${name}`)
    throw err
  }
  console.log(`  ✓ ${name}`)
}

// --- the threshold is in pixels, converted at the current zoom ----------
check('threshold converts pixels to seconds at the current zoom', () => {
  assert.ok(Math.abs(thresholdInSeconds(12, 80) - 0.15) < 1e-9)
  assert.ok(Math.abs(thresholdInSeconds(12, 400) - 0.03) < 1e-9)
  assert.equal(thresholdInSeconds(10, 0), 0, 'a zero zoom snaps nothing rather than everything')
  assert.equal(thresholdInSeconds(-10, 100), 0.1, 'a negative distance is a magnitude')
})

// --- what is worth snapping to -----------------------------------------
check('the playhead is not a snap target, though it now snaps itself', () => {
  const p = project([{ id: 'video', type: 'video', clips: [clip('v1', 0, 10)] }])
  assert.ok(collectTargets(p, { playhead: 4.2, includePlayhead: true }).some((t) => t.kind === 'playhead'))
  assert.ok(!collectTargets(p, { playhead: 4.2, includePlayhead: false }).some((t) => t.kind === 'playhead'))

  const timeline = readFileSync(new URL('../src/app/view/timeline/use-timeline-drag.ts', import.meta.url), 'utf8')
  assert.ok(
    /includePlayhead: false/.test(timeline),
    'the timeline must not offer the playhead as a target',
  )
})

check('targets come from all tracks, plus the playhead and the origin', () => {
  const p = project([
    { id: 'video', type: 'video', clips: [clip('v1', 0, 10)] },
    { id: 'audio', type: 'audio', clips: [clip('a1', 0, 10, 'audio')] },
  ])
  const targets = collectTargets(p, { playhead: 4.2, includePlayhead: true })

  const times = (kind: string) => targets.filter((t) => t.kind === kind).map((t) => t.time).sort()
  assert.deepEqual(times('clip-start'), [0, 0], 'both tracks contribute a start at 0')
  assert.deepEqual(times('clip-end'), [10, 10], 'and an end at 10')
  assert.ok(targets.some((t) => t.kind === 'playhead' && t.time === 4.2))
  assert.ok(targets.some((t) => t.kind === 'timeline-start' && t.time === 0))

  const without = collectTargets(p, { playhead: 4.2, includePlayhead: false })
  assert.ok(!without.some((t) => t.kind === 'playhead'), 'the playhead can be excluded')
})

check('clip and lane snapping are independent target sets', () => {
  const p = project([
    { id: 'video', type: 'video', clips: [clip('v1', 0, 10)] },
    { id: 'audio', type: 'audio', clips: [clip('a1', 0, 10, 'audio')] },
  ])

  const both = collectTargets(p, { playhead: 0, includePlayhead: false })
  assert.equal(both.filter((t) => t.trackId === 'video').length, 2, 'both tracks by default')
  assert.equal(both.filter((t) => t.trackId === 'audio').length, 2)

  const videoOnly = collectTargets(p, { playhead: 0, includePlayhead: false, tracks: ['video'] })
  assert.equal(videoOnly.filter((t) => t.trackId === 'audio').length, 0, 'no audio edges')
  assert.ok(videoOnly.some((t) => t.kind === 'timeline-start'), 'but the origin is still offered')

  const audioOnly = collectTargets(p, { playhead: 0, includePlayhead: false, tracks: ['audio'] })
  assert.equal(audioOnly.filter((t) => t.trackId === 'video').length, 0, 'no video edges')
  assert.equal(audioOnly.filter((t) => t.trackId === 'audio').length, 2)
})

check('both edges of a silence region are targets', () => {
  const p = project([{ id: 'video', type: 'video', clips: [clip('v1', 0, 30)] }])
  const targets = collectTargets(p, {
    playhead: 0,
    includePlayhead: false,
    silence: [{ clipId: 'v1', trackId: 'video', start: 0, regions: [{ start: 5, end: 8 }] }],
  })
  const silence = targets.filter((t) => t.kind === 'silence').map((t) => t.time).sort()
  assert.deepEqual(silence, [5, 8], 'the start and the end of the silent run')
})

// --- the threshold boundary ---------------------------------------------
check('within the threshold snaps, outside it does not', () => {
  const targets = [target(10)]
  assert.equal(nearestTarget(10, targets, 0.2)?.time, 10, 'exact')
  assert.equal(nearestTarget(10.19, targets, 0.2)?.time, 10, 'just inside')
  assert.equal(nearestTarget(10.21, targets, 0.2), null, 'just outside')
  assert.equal(nearestTarget(5, targets, 0.2), null, 'far away')
  assert.equal(nearestTarget(10.2, targets, 0.2)?.time, 10, 'exactly at the threshold snaps')
})

check('the nearest target wins', () => {
  const targets = [target(10, 'a'), target(10.15, 'b', 'clip-end')]
  assert.equal(nearestTarget(10.1, targets, 0.2)?.time, 10.15, 'the closer one wins')
  assert.equal(nearestTarget(10.02, targets, 0.2)?.time, 10, 'and the other when the pointer is nearer it')
})

// --- stickiness ---------------------------------------------------------
check('a snap is sticky, which is what stops the flicker', () => {
  const latchedOn = target(10)
  const others = [latchedOn, target(10.18, 'b', 'clip-end')]

  assert.equal(nearestTarget(10.1, others, 0.2, undefined, latchedOn)?.time, 10, 'stays latched')
  assert.equal(nearestTarget(10.1, others, 0.2)?.time, 10.18, 'without the latch it flickers to the other')

  const released = nearestTarget(10.4, others, 0.2, undefined, latchedOn)
  assert.notEqual(released?.time, 10, 'released once the pointer drifts past the sticky factor')
})

// --- trimming and scrubbing ---------------------------------------------
check('a trim edge snaps to a nearby cut', () => {
  const p = project([{ id: 'video', type: 'video', clips: [clip('v1', 0, 10), clip('v2', 12, 20)] }])
  const targets = collectTargets(p, { playhead: 0, includePlayhead: false })
  const times = [...new Set(targets.map((t) => t.time))].sort((a, b) => a - b)
  assert.deepEqual(times, [0, 10, 18], 'clips are contiguous, so there is no boundary at the source in-point')

  assert.equal(snapTrimEdge(9.9, targets, 0.2, { clipId: 'v1' })?.time, 10, 'the trimmed edge snaps to the join')
  assert.equal(snapTrimEdge(9.4, targets, 0.2, { clipId: 'v1' }), null, 'but not from too far away')

  assert.equal(snapTrimEdge(10.1, targets, 0.2, { clipId: 'v2' })?.time, 10, "v2's own start is excluded, but v1's end is not")
})

check('an empty timeline still offers the origin', () => {
  const targets = collectTargets(project([]), { playhead: 0, includePlayhead: false })
  assert.equal(targets.length, 1)
  assert.equal(targets[0]!.time, 0)
  assert.equal(snapTrimEdge(0.05, targets, 0.2)?.time, 0)
})

check('moving snaps whichever edge is nearer a target', () => {
  const targets = [target(10, 'neighbour')]
  const byStart = snapMove(9.8, 4, targets, 0.25)
  assert.equal(byStart?.edge, 'start', 'the start edge latched')
  assert.equal(byStart?.start, 10, 'so the clip starts on the target')

  const byEnd = snapMove(5.9, 4, targets, 0.25)
  assert.equal(byEnd?.edge, 'end', 'the end edge latched')
  assert.equal(byEnd?.start, 6, 'and the start is placed one duration back')
})

check('a moving clip cannot snap to its own edges', () => {
  const p = project([{ id: 'video', type: 'video', clips: [clip('v1', 0, 10)] }])
  const targets = collectTargets(p, { playhead: 0, includePlayhead: false })
  assert.equal(snapMove(9.9, 10, targets, 0.2, { clipId: 'v1' }), null, 'its own edges are excluded')
})

check('a drag moves the selected clips and everything after them', () => {
  const clips = [clip('a', 0, 5), clip('b', 0, 5), clip('c', 0, 5), clip('d', 0, 5)]
  assert.deepEqual([...movingInTrack(clips, new Set(['b']))], ['b', 'c', 'd'], 'b and its successors move')
  assert.deepEqual([...movingInTrack(clips, new Set(['a']))], ['a', 'b', 'c', 'd'], 'everything after the first')
  assert.deepEqual([...movingInTrack(clips, new Set())], [], 'nothing selected, nothing moves')
})

check('a move snaps either edge, and neither can overlap what it snapped to', () => {
  const targets = [target(8, 'a', 'clip-end'), target(2, 'b', 'clip-start')]

  const byStart = snapMove(2.05, 3, targets, 0.1)
  assert.equal(byStart?.edge, 'start')
  assert.equal(byStart?.start, 2, 'flush against the neighbour')

  const byEnd = snapMove(5.05, 3, targets, 0.1)
  assert.equal(byEnd?.edge, 'end')
  assert.equal(byEnd?.start, 5, 'landing its start one duration back')

  const self = [target(5, 'me', 'clip-start')]
  assert.equal(snapMove(5.05, 3, self, 0.1, { clipId: 'me' }), null, 'its own edges are excluded')
})

check('playhead snap lands exactly on a timeline edge', () => {
  const p = project([{ id: 'video', type: 'video', clips: [clip('v1', 0, 5), clip('v2', 0, 5)] }])
  const targets = collectTargets(p, { playhead: 0, includePlayhead: false })

  assert.equal(snapPlayhead(4.94, targets, 0.1)?.time, 5, 'onto a clip start / cut at 5')
  assert.equal(snapPlayhead(9.95, targets, 0.1)?.time, 10, 'onto a clip end at 10')
  assert.equal(snapPlayhead(0.06, targets, 0.1)?.time, 0, 'onto the timeline start')
  assert.equal(snapPlayhead(4.5, targets, 0.1), null, 'outside the threshold it does not snap')
})

check('playhead snap uses the zoom-scaled pixel threshold, not a fixed time', () => {
  const targets = [target(5, 'n')]
  assert.equal(snapPlayhead(4.9, targets, thresholdInSeconds(10, 80))?.time, 5, 'snaps when zoomed out')
  assert.equal(snapPlayhead(4.9, targets, thresholdInSeconds(10, 400)), null, 'does not when zoomed in')
})

// ---------------------------------------------------------------------------
// The acceptance criteria, as executable assertions.
// ---------------------------------------------------------------------------

const timelineSource = readFileSync(new URL('../src/app/view/timeline/use-timeline-drag.ts', import.meta.url), 'utf8')
const snappingSource = readFileSync(new URL('../src/model/snapping.ts', import.meta.url), 'utf8')

function dragCase(kind: 'move' | 'trim' | 'playhead'): string {
  const needle = kind === 'trim' ? "case 'trim-in':" : `case '${kind}':`
  const start = timelineSource.indexOf(needle)
  assert.ok(start > 0, `no ${needle} in Timeline.tsx`)

  const open = timelineSource.indexOf('{', start)
  let depth = 0
  let end = open
  for (; end < timelineSource.length; end++) {
    if (timelineSource[end] === '{') depth++
    else if (timelineSource[end] === '}' && --depth === 0) break
  }

  return timelineSource
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

check('ACCEPTANCE 1, 2 · moving follows the pointer, then snaps to a nearby edge', () => {
  const move = dragCase('move')
  assert.ok(/const raw = t - drag\.grabOffset/.test(move), 'the raw start is pointer time minus the grab offset')
  assert.ok(move.includes('snapMove('), 'moving snaps its start or its end to a target')
  assert.ok(move.includes('state.snapping()'), 'and only when snapping is on')
  assert.ok(move.includes('drag.locked'), 'carrying the latched target through for stickiness')
  assert.ok(/setGuide\(/.test(move), 'showing the guide line while aligned, and clearing it when not')
  assert.ok(move.includes('drag.snapTargets'), 'the move snaps against a captured target list')
  assert.ok(!move.includes('targets()'), 'and never rebuilds it mid-drag')
})

check('ACCEPTANCE 3, 4, 10 · trimming snaps, and both edges share it', () => {
  const arm = dragCase('trim')
  assert.ok(arm.includes("case 'trim-in':"), 'the left edge is handled')
  assert.ok(arm.includes("case 'trim-out':"), 'and the right edge')
  assert.ok(arm.includes('snapTrimEdge('), 'trimming must call snapTrimEdge')
  assert.ok(arm.includes('thresholdInSeconds('), 'and convert the pixel radius at the current zoom')
  assert.ok(arm.includes('drag.locked'), 'passing the latched target through for stickiness')
  assert.ok(arm.includes('setGuide('), 'and show a guide line so the magnet is visible')
  assert.ok(/state\.trim\(drag\.trackId/.test(arm), 'the result is applied through the normal trim path')
})

check('ACCEPTANCE 8 · a clip still cannot snap to itself', () => {
  const p = project([{ id: 'video', type: 'video', clips: [clip('v1', 0, 10)] }])
  const targets = collectTargets(p, { playhead: 0, includePlayhead: false })
  assert.equal(snapTrimEdge(9.9, targets, 0.2, { clipId: 'v1' }), null, 'no self-snap while trimming')
  assert.equal(snapTrimEdge(9.9, targets, 0.2)?.time, 10, 'but the target is there for a different clip')
})

check('ACCEPTANCE 5, 6, 7 · outside snaps, inside latches, far away releases', () => {
  const cut: SnapTarget = { time: 10, kind: 'clip-start', trackId: 'video', clipId: 'other' }
  const rival = target(10.18, 'b', 'clip-end')
  const all = [cut, rival]

  assert.equal(snapTrimEdge(9.7, all, 0.2, { clipId: 'drag' }), null, '0.3 away: no snap')

  const latched = snapTrimEdge(9.9, all, 0.2, { clipId: 'drag' })
  assert.equal(latched?.time, 10, '0.1 away: snapped to the cut')
  assert.equal(
    snapTrimEdge(9.92, all, 0.2, { clipId: 'drag' }, cut)?.time,
    10,
    'still latched to the same target, even though the rival is nearer',
  )

  assert.equal(snapTrimEdge(9.5, all, 0.2, { clipId: 'drag' }, cut), null, '0.5 away: released')
})

check('the playhead snaps, under its own toggle', () => {
  const playhead = dragCase('playhead')
  assert.ok(playhead.includes('snapPlayhead('), 'the playhead pulls to a nearby edge')
  assert.ok(playhead.includes('state.playheadSnap()'), 'gated by its own toggle')
  assert.ok(!playhead.includes('state.snapping()'), 'not by the clip/lane gate')
  assert.ok(
    !playhead.includes('state.clipSnap()') && !playhead.includes('state.laneSnap()'),
    'and not by either clip toggle',
  )
  assert.ok(/state\.seek\(/.test(playhead), 'the result is applied through seek')
})

check('clip and lane snapping do not depend on the playhead toggle', () => {
  const move = dragCase('move')
  const trim = dragCase('trim')
  assert.ok(move.includes('state.snapping()'), 'moving uses the clip/lane gate')
  assert.ok(trim.includes('state.snapping()'), 'trimming uses the clip/lane gate')
  assert.ok(
    !move.includes('playheadSnap') && !trim.includes('playheadSnap'),
    'neither consults the playhead toggle',
  )
})

check('snapping has exactly three entry points, one per mode', () => {
  assert.ok(!/export function snapClipMove/.test(snappingSource), 'the old helper name is not resurrected')
  const exported = [...snappingSource.matchAll(/export (?:function|const|interface|type) (\w+)/g)].map((m) => m[1])
  assert.deepEqual(
    exported.filter((n) => /^snap/.test(n!)).sort(),
    ['snapMove', 'snapPlayhead', 'snapTrimEdge'],
    'trim, move and playhead are the whole snapping surface',
  )
})

check('a trim edge snaps on TIMELINE time, not source time', () => {
  const trimmed = clip('t1', 40, 80)
  const p = project([{ id: 'video', type: 'video', clips: [trimmed, clip('t2', 0, 20)] }])
  const targets = collectTargets(p, { playhead: 0, includePlayhead: false })

  const joins = [...new Set(targets.map((t) => t.time))].sort((a, b) => a - b)
  assert.deepEqual(joins, [0, 40, 60], 'boundaries are timeline positions, not source in-points')

  const snapped = snapTrimEdge(39.9, targets, 0.2, { clipId: 't1' })
  assert.equal(snapped?.time, 40, 'the handle is pulled to the join')

  const trackStartTime = 0
  const sourceT = trimmed.in + ((snapped?.time ?? 39.9) - trackStartTime)
  assert.equal(sourceT, 80, 'timeline 40 is source 80 for a clip whose in-point is 40')

  const wrongSource = 40
  assert.notEqual(
    nearestTarget(wrongSource, targets, 0.2, { clipId: 't1' })?.time,
    undefined,
    'coincidentally in range here, but it is the wrong quantity',
  )
  assert.equal(sourceT, 80, 'the correct conversion is what the trim path must use')
})

check('a clip that is not at timeline zero snaps correctly too', () => {
  let p = placeClip({ ...withAsset(), tracks: [{ id: 'video', type: 'video', clips: [clip('a', 0, 5), clip('b', 2, 12)] }] }, 'video', 1, 5)
  p = placeClip(p, 'video', 2, 15)
  p = { ...p, tracks: [...p.tracks.map((t) => t.id === 'video' ? { ...t, clips: [...t.clips, clip('c', 0, 5)] } : t)] }

  const vTrack = p.tracks.find((t) => t.type === 'video')!
  assert.equal(clipStart(vTrack.clips, 1), 5, 'b sits at timeline 5, source in-point 2')
  assert.equal(clipStart(vTrack.clips, 2), 15, 'c sits at timeline 15')

  const targets = collectTargets(p, { playhead: 0, includePlayhead: false })
  const joins = [...new Set(targets.map((t) => t.time))].sort((a, b) => a - b)
  assert.deepEqual(joins, [0, 5, 15, 20], 'four boundaries, all timeline positions')

  const snapped = snapTrimEdge(14.9, targets, 0.2, { clipId: 'b' })
  assert.equal(snapped?.time, 15, 'snapped on the timeline')

  const sourceT = vTrack.clips[1]!.in + (15 - clipStart(vTrack.clips, 1))
  assert.equal(sourceT, 12, 'which is the clip source out-point, as expected')

  assert.equal(snapTrimEdge(15.1, targets, 0.2, { clipId: 'b' })?.time, 15,
    "b's own end is not a target for b, but c's start is at the same time")
})

console.log('\nsnapping assertions passed')

// --- which tracks are eligible targets --------------------------------------

check('the two snap toggles are independent, and say which tracks they mean', () => {
  const allTracks = ['video', 'audio']
  assert.deepEqual(targetTracks('video', allTracks, true, true), ['video', 'audio'], 'both on means all tracks')
  assert.deepEqual(targetTracks('video', allTracks, true, false), ['video'], 'clip snap alone is this track')
  assert.deepEqual(targetTracks('video', allTracks, false, true), ['audio'], 'lane snap alone is the other tracks')
  assert.deepEqual(targetTracks('video', allTracks, false, false), [], 'neither means nothing')

  assert.deepEqual(targetTracks('audio', allTracks, true, false), ['audio'])
  assert.deepEqual(targetTracks('audio', allTracks, false, true), ['video'])
})

check('a drop and a drag resolve the same tracks, because they call the same function', () => {
  // Phase 2 will update store code to use targetTracks
  const read = (f: string): string => readFileSync(new URL(f, import.meta.url), 'utf8')
  for (const file of ['../src/app/store/assets.ts', '../src/app/view/timeline/use-timeline-drag.ts']) {
    const code = read(file)
    assert.match(code, /targetTracks\(/, `${file} must ask targetTracks, not answer the question itself`)
  }
})

check('collectTargets honours the track list it is given', () => {
  const project: Project = { ...emptyProject(), tracks: [
    { id: 'video', type: 'video', clips: [clip('v', 0, 5)] },
    { id: 'audio', type: 'audio', clips: [clip('a', 0, 5, 'audio')] },
  ] }
  const both = collectTargets(project, { playhead: 0, includePlayhead: false })
  const videoOnly = collectTargets(project, { playhead: 0, includePlayhead: false, tracks: ['video'] })
  const none = collectTargets(project, { playhead: 0, includePlayhead: false, tracks: [] })

  assert.ok(both.some((t) => t.trackId === 'audio'), 'both tracks by default')
  assert.ok(!videoOnly.some((t) => t.trackId === 'audio'), 'and only what was asked for')
  assert.deepEqual(none.map((t) => t.kind), ['timeline-start'], 'the origin is not a track')
})
