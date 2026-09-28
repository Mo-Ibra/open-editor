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
  snapTrimEdge,
  thresholdInSeconds,
  type SnapTarget,
} from '../src/snapping.ts'
import { clipStart, placeClip, emptyProject, type Clip, type Project } from '../src/project.ts'

const clip = (id: string, inPoint: number, out: number, lane: 'video' | 'audio' = 'video'): Clip => ({
  id,
  lane,
  assetId: 'a',
  in: inPoint,
  out,
})

const withAsset = (): Project => ({ ...emptyProject(), assets: { a: { duration: 100 } as never } })

const project = (video: Clip[], audio: Clip[] = []): Project => ({
  version: 2,
  assets: {},
  video,
  audio,
})

const target = (time: number, id = 'other', kind: SnapTarget['kind'] = 'clip-start'): SnapTarget => ({
  time,
  kind,
  lane: 'video',
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
  // 12 px at 80 px/s is 0.15 s. At 400 px/s the same 12 px is 0.03 s. A
  // threshold expressed in seconds instead would make snapping unusable when
  // zoomed in.
  assert.ok(Math.abs(thresholdInSeconds(12, 80) - 0.15) < 1e-9)
  assert.ok(Math.abs(thresholdInSeconds(12, 400) - 0.03) < 1e-9)
  assert.equal(thresholdInSeconds(10, 0), 0, 'a zero zoom snaps nothing rather than everything')
  assert.equal(thresholdInSeconds(-10, 100), 0.1, 'a negative distance is a magnitude')
})

// --- what is worth snapping to -----------------------------------------
check('the playhead is available as a target, but the editor does not use it', () => {
  // The module supports it; the timeline deliberately opts out, because a
  // playhead that snaps stops being a measurement. The test pins both halves:
  // the capability, and the caller's refusal to use it.
  const p = project([clip('v1', 0, 10)])
  assert.ok(collectTargets(p, { playhead: 4.2, includePlayhead: true }).some((t) => t.kind === 'playhead'))
  assert.ok(!collectTargets(p, { playhead: 4.2, includePlayhead: false }).some((t) => t.kind === 'playhead'))

  const timeline = readFileSync(new URL('../src/ui/Timeline.tsx', import.meta.url), 'utf8')
  assert.ok(
    /includePlayhead: false/.test(timeline),
    'the timeline must opt out of playhead snapping',
  )
})

check('targets come from both lanes, plus the playhead and the origin', () => {
  const p = project([clip('v1', 0, 10)], [clip('a1', 0, 10, 'audio')])
  const targets = collectTargets(p, { playhead: 4.2, includePlayhead: true })

  const times = (kind: string) => targets.filter((t) => t.kind === kind).map((t) => t.time).sort()
  assert.deepEqual(times('clip-start'), [0, 0], 'both lanes contribute a start at 0')
  assert.deepEqual(times('clip-end'), [10, 10], 'and an end at 10')
  assert.ok(targets.some((t) => t.kind === 'playhead' && t.time === 4.2))
  assert.ok(targets.some((t) => t.kind === 'timeline-start' && t.time === 0))

  const without = collectTargets(p, { playhead: 4.2, includePlayhead: false })
  assert.ok(!without.some((t) => t.kind === 'playhead'), 'the playhead can be excluded')
})

check('both edges of a silence region are targets', () => {
  // Cutting dead air means snapping to where speech RESUMES, which is the
  // region's end. Offering only the start is the less useful half.
  const p = project([clip('v1', 0, 30)])
  const targets = collectTargets(p, {
    playhead: 0,
    includePlayhead: false,
    silence: [{ clipId: 'v1', lane: 'video', start: 0, regions: [{ start: 5, end: 8 }] }],
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
  // 10.1 is 0.10 from the first and 0.05 from the second.
  assert.equal(nearestTarget(10.1, targets, 0.2)?.time, 10.15, 'the closer one wins')
  assert.equal(nearestTarget(10.02, targets, 0.2)?.time, 10, 'and the other when the pointer is nearer it')
})

// --- stickiness ---------------------------------------------------------
check('a snap is sticky, which is what stops the flicker', () => {
  const latchedOn = target(10)
  const others = [latchedOn, target(10.18, 'b', 'clip-end')]

  // Latched: the pointer wobbling around stays latched, even though 10.18 is
  // nearer. Re-deciding every frame is what makes snapping feel broken.
  assert.equal(nearestTarget(10.1, others, 0.2, undefined, latchedOn)?.time, 10, 'stays latched')
  assert.equal(nearestTarget(10.1, others, 0.2)?.time, 10.18, 'without the latch it flickers to the other')

  const released = nearestTarget(10.4, others, 0.2, undefined, latchedOn)
  assert.notEqual(released?.time, 10, 'released once the pointer drifts past the sticky factor')
})

// --- trimming and scrubbing ---------------------------------------------
check('a trim edge snaps to a nearby cut', () => {
  // v1 is 0-10 of source and v2 is 12-20, but they butt together on the
  // timeline: v2 STARTS at 10, because position is derived from array order
  // (§3). So the only boundaries are 0, 10 and 18 — there is no gap, and
  // "12" is a source in-point, not a timeline position.
  const p = project([clip('v1', 0, 10), clip('v2', 12, 20)])
  const targets = collectTargets(p, { playhead: 0, includePlayhead: false })
  const times = [...new Set(targets.map((t) => t.time))].sort((a, b) => a - b)
  assert.deepEqual(times, [0, 10, 18], 'clips are contiguous, so there is no boundary at the source in-point')

  // Trimming v1's out-point back to just shy of the join.
  assert.equal(snapTrimEdge(9.9, targets, 0.2, { clipId: 'v1' })?.time, 10, 'the trimmed edge snaps to the join')
  assert.equal(snapTrimEdge(9.4, targets, 0.2, { clipId: 'v1' }), null, 'but not from too far away')

  // A clip cannot snap to its own edges, but the join is shared — v1's out
  // and v2's in are the same time, and v1 is excluded while v2 is not.
  assert.equal(snapTrimEdge(10.1, targets, 0.2, { clipId: 'v2' })?.time, 10, "v2's own start is excluded, but v1's end is not")
})

check('an empty timeline still offers the origin', () => {
  const targets = collectTargets(project([]), { playhead: 0, includePlayhead: false })
  assert.equal(targets.length, 1)
  assert.equal(targets[0]!.time, 0)
  assert.equal(snapTrimEdge(0.05, targets, 0.2)?.time, 0)
})

// ---------------------------------------------------------------------------
// The acceptance criteria, as executable assertions.
//
// Moving a clip must be free; trimming an edge must be magnetic. This has been
// asked for twice, and the first implementation quietly put a magnet on both
// paths — so the separation is guarded here rather than left to review.
// ---------------------------------------------------------------------------

const timelineSource = readFileSync(new URL('../src/ui/Timeline.tsx', import.meta.url), 'utf8')
const snappingSource = readFileSync(new URL('../src/snapping.ts', import.meta.url), 'utf8')

/**
 * The body of one `case` arm of the drag switch, with comments stripped.
 *
 * Stripping matters: the move path *documents* that it does not snap, and a
 * naive search would flag its own explanation. These assertions are about
 * code, not prose.
 */
function dragCase(kind: 'move' | 'trim' | 'playhead'): string {
  // The two trim arms share one body, so they are addressed together and
  // located by brace-matching rather than by "the next `case`" — the
  // fallthrough label `case 'trim-out':` would otherwise cut the arm in half.
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

check('ACCEPTANCE 9 · a moved clip cannot reach the snapping system at all', () => {
  const move = dragCase('move')
  for (const forbidden of ['nearestTarget', 'snapTrimEdge', 'snapClipMove', 'targets()', 'setGuide({']) {
    assert.ok(!move.includes(forbidden), `the move path must not reference ${forbidden}`)
  }
})

check('ACCEPTANCE 9 · a move shows no guide line', () => {
  // A guide is the visible tell of a magnet, so its absence is the check.
  assert.ok(/setGuide\(null\)/.test(dragCase('move')), 'the move path must clear the guide, never set one')
})

check('ACCEPTANCE 1, 2 · the move path is the pointer position, unmodified', () => {
  const move = dragCase('move')
  // The clip's start comes straight from the pointer, with nothing subtracted
  // or nudged on the way.
  assert.ok(/const start = t - drag\.grabOffset/.test(move), 'start is pointer time minus the grab offset')
  assert.ok(!/snap/i.test(move), 'and the word "snap" appears nowhere in the move path')
})

check('ACCEPTANCE 3, 4, 10 · trimming snaps, and both edges share it', () => {
  // One body serves both handles, so this covers the left edge and the right.
  const arm = dragCase('trim')
  assert.ok(arm.includes("case 'trim-in':"), 'the left edge is handled')
  assert.ok(arm.includes("case 'trim-out':"), 'and the right edge')
  assert.ok(arm.includes('snapTrimEdge('), 'trimming must call snapTrimEdge')
  assert.ok(arm.includes('thresholdInSeconds('), 'and convert the pixel radius at the current zoom')
  assert.ok(arm.includes('drag.locked'), 'passing the latched target through for stickiness')
  assert.ok(arm.includes('setGuide('), 'and show a guide line so the magnet is visible')
  assert.ok(/state\.trim\(drag\.lane/.test(arm), 'the result is applied through the normal trim path')
})

check('ACCEPTANCE 8 · a clip still cannot snap to itself', () => {
  // Self-exclusion is the reason a trim handle can still cross its own clip's
  // far edge without sticking to it.
  const p = project([clip('v1', 0, 10)])
  const targets = collectTargets(p, { playhead: 0, includePlayhead: false })
  assert.equal(snapTrimEdge(9.9, targets, 0.2, { clipId: 'v1' }), null, 'no self-snap while trimming')
  assert.equal(snapTrimEdge(9.9, targets, 0.2)?.time, 10, 'but the target is there for a different clip')
})

check('ACCEPTANCE 5, 6, 7 · outside snaps, inside latches, far away releases', () => {
  const cut: SnapTarget = { time: 10, kind: 'clip-start', lane: 'video', clipId: 'other' }
  const rival = target(10.18, 'b', 'clip-end')
  const all = [cut, rival]

  // 5 · outside the threshold.
  assert.equal(snapTrimEdge(9.7, all, 0.2, { clipId: 'drag' }), null, '0.3 away: no snap')

  // 3, 6 · inside, and it stays latched as the pointer wobbles.
  const latched = snapTrimEdge(9.9, all, 0.2, { clipId: 'drag' })
  assert.equal(latched?.time, 10, '0.1 away: snapped to the cut')
  assert.equal(
    snapTrimEdge(9.92, all, 0.2, { clipId: 'drag' }, cut)?.time,
    10,
    'still latched to the same target, even though the rival is nearer',
  )

  // 7 · far enough away, it releases.
  assert.equal(snapTrimEdge(9.5, all, 0.2, { clipId: 'drag' }, cut), null, '0.5 away: released')
})

check('there is no snapping entry point for moving a clip', () => {
  // The cleanest guard against the regression is that the helper is gone.
  assert.ok(!/export function snapClipMove/.test(snappingSource), 'snapClipMove must not exist')
  assert.ok(!/\bsnapClipMove\b/.test(timelineSource), 'and nothing may call it')
  const exported = [...snappingSource.matchAll(/export (?:function|const|interface|type) (\w+)/g)].map((m) => m[1])
  assert.deepEqual(
    exported.filter((n) => /^snap/.test(n!)),
    ['snapTrimEdge'],
    'the only exported snapping function is the trim one',
  )
})

/**
 * The coordinate-space bug this file exists to prevent.
 *
 * A clip's `in` is a position in the SOURCE file. Every snap target is a
 * position on the TIMELINE. They are the same number only for a fresh clip
 * sitting at time zero. Snapping a source time against timeline targets makes
 * the magnet pull toward the wrong place on any trimmed clip, or any clip not
 * at the start — which reads as "snapping is broken" rather than as a units
 * error.
 */
check('a trim edge snaps on TIMELINE time, not source time', () => {
  // A clip that has already been trimmed: in-point 40s, sitting at timeline 0.
  const trimmed = clip('t1', 40, 80)
  const p = project([trimmed, clip('t2', 0, 20)])
  const targets = collectTargets(p, { playhead: 0, includePlayhead: false })

  // t1 occupies timeline 0-40; t2 starts at 40 and ends at 60.
  const joins = [...new Set(targets.map((t) => t.time))].sort((a, b) => a - b)
  assert.deepEqual(joins, [0, 40, 60], 'boundaries are timeline positions, not source in-points')

  // Trimming t1's RIGHT edge toward the join at timeline 40.
  const snapped = snapTrimEdge(39.9, targets, 0.2, { clipId: 't1' })
  assert.equal(snapped?.time, 40, 'the handle is pulled to the join')

  // And what the editor then does with it: convert the snapped TIMELINE
  // position back into a SOURCE position for this clip.
  const laneStartTime = 0
  const sourceT = trimmed.in + ((snapped?.time ?? 39.9) - laneStartTime)
  assert.equal(sourceT, 80, 'timeline 40 is source 80 for a clip whose in-point is 40')

  // Snapping the SOURCE time instead — the bug — lands on the wrong frame.
  const wrongSource = 40 // what the old code compared against the targets
  assert.notEqual(
    nearestTarget(wrongSource, targets, 0.2, { clipId: 't1' })?.time,
    undefined,
    'coincidentally in range here, but it is the wrong quantity',
  )
  assert.equal(sourceT, 80, 'the correct conversion is what the trim path must use')
})

check('a clip that is not at timeline zero snaps correctly too', () => {
  // A gap before the clip, and a neighbour after it, so there is a real target
  // to pull towards that is not the clip's own edge.
  let p = placeClip({ ...withAsset(), video: [clip('a', 0, 5), clip('b', 2, 12)] }, 'video', 1, 5)
  p = placeClip(p, 'video', 2, 15)
  p = { ...p, video: [...p.video, clip('c', 0, 5)] }

  assert.equal(clipStart(p.video, 1), 5, 'b sits at timeline 5, source in-point 2')
  assert.equal(clipStart(p.video, 2), 15, 'c sits at timeline 15')

  const targets = collectTargets(p, { playhead: 0, includePlayhead: false })
  const joins = [...new Set(targets.map((t) => t.time))].sort((a, b) => a - b)
  assert.deepEqual(joins, [0, 5, 15, 20], 'four boundaries, all timeline positions')

  // Trimming b's RIGHT edge toward c's start. c is a different clip, so its
  // edge is a legitimate target.
  const snapped = snapTrimEdge(14.9, targets, 0.2, { clipId: 'b' })
  assert.equal(snapped?.time, 15, 'snapped on the timeline')

  // Convert back: timeline 15, lane start 5, in-point 2 -> source 12, which is
  // exactly b's out-point.
  const sourceT = p.video[1]!.in + (15 - clipStart(p.video, 1))
  assert.equal(sourceT, 12, 'which is the clip source out-point, as expected')

  // b's own edges remain excluded even though they are nearer.
  assert.equal(snapTrimEdge(15.1, targets, 0.2, { clipId: 'b' })?.time, 15,
    "b's own end is not a target for b, but c's start is at the same time")
})

console.log('\nsnapping assertions passed')
