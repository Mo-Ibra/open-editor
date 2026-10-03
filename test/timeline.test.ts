/**
 * The timeline's pure parts: tick spacing, tick labels, and click modes.
 *
 * These became testable only when they were pulled out of the component. None
 * of them needs a canvas or a store, and each has a failure mode that is
 * invisible until it is annoying: a ruler that becomes an unreadable comb, a
 * label that lies about the time, a modifier that stops extending a selection.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { clipDuration, clipStart, placeClip, type Clip, type Project } from '../src/model/project.ts'
import { collectTargets, snapMove, thresholdInSeconds } from '../src/model/snapping.ts'
import { formatTick, tickInterval, ticks } from '../src/app/view/timeline/ticks.ts'
import { selectModeOf } from '../src/app/view/timeline/use-timeline-drag.ts'

// --- tick spacing ----------------------------------------------------------

test('the interval is the first that leaves room for a label', () => {
  // 0.04s needs 2250px/s to reach the 90px minimum; below that it is too
  // crowded, which is the whole reason the interval is derived.
  assert.equal(tickInterval(2250), 0.04, 'the finest interval, once it fits')
  assert.equal(tickInterval(2000), 0.1, 'and not before — 0.04 would be 80px apart')
  assert.equal(tickInterval(100), 1, 'at 100px/s, 1s ticks are 100px apart')
  assert.equal(tickInterval(1), 120, 'at 1px/s, 2-minute ticks still clear 90px')
  assert.equal(tickInterval(0.1), 1800, 'at 0.1px/s only half an hour fits')
})

test('zooming in makes the interval finer, never coarser', () => {
  let previous = Number.POSITIVE_INFINITY
  for (const zoom of [0.1, 1, 10, 50, 100, 500, 1000, 5000, 50000]) {
    const step = tickInterval(zoom)
    assert.ok(step <= previous, `zoom ${zoom} produced a coarser interval than the one before`)
    previous = step
  }
})

test('a very small zoom still produces ticks rather than dividing by zero', () => {
  assert.ok(tickInterval(0.001) > 0)
  assert.ok(tickInterval(0) > 0, 'a zero zoom must not produce a zero interval')
})

test('ticks are evenly spaced and stop at the duration', () => {
  const out = ticks(10, 100)
  assert.ok(out.length > 0)
  assert.ok(out[0] === 0, 'a timeline starts at zero')
  assert.ok(out.at(-1)! <= 10, 'and no tick is past the end')
  const step = out[1]! - out[0]!
  for (let i = 1; i < out.length; i += 1) {
    assert.ok(Math.abs(out[i]! - out[i - 1]! - step) < 1e-6, `tick ${i} is unevenly spaced`)
  }
})

test('ticks do not accumulate float drift', () => {
  // `t += step` would drift. Note how this checks the count: by *multiplying*
  // an index, not by dividing — `60 / 0.1` is 599.9999…, so a test that
  // divides reintroduces the very bug it is looking for.
  const out = ticks(60, 2000)
  assert.equal(out.length, 601, 'ticks at 0.1s up to and including 60s')
  assert.equal(out[600], 60, 'and the last one is exactly the end')
  for (const t of out) {
    // Rounded to 4dp, so a label can never read 1.2000000000000002s.
    assert.ok(String(t).length <= 6, `${t} carries float noise`)
  }
})

test('the final tick lands exactly on the end rather than past it', () => {
  // The off-by-one here is a whole extra tick at the right edge, which reads
  // as the timeline being longer than it is.
  for (const [duration, zoom] of [[10, 100], [60, 2000], [445.72, 100], [3.7, 30]] as const) {
    const out = ticks(duration, zoom)
    assert.ok(out.at(-1)! <= duration, `${duration}s at ${zoom} overshot to ${out.at(-1)}`)
    assert.ok(duration - out.at(-1)! < tickInterval(zoom), 'and leaves no gap at the end')
  }
})

test('an empty timeline has no ticks at all', () => {
  assert.deepEqual(ticks(0, 100), [])
  assert.deepEqual(ticks(-5, 100), [], 'a negative duration is still empty')
})

// --- tick labels -----------------------------------------------------------

test('sub-second ticks keep enough precision to be distinguishable', () => {
  assert.equal(formatTick(0), '0.00s')
  assert.equal(formatTick(0.04), '0.04s', 'two decimals below a quarter second')
  assert.equal(formatTick(0.5), '0.5s', 'one decimal above it')
  assert.equal(formatTick(1), '1s')
})

test('long timelines read as time, not as seconds since the start', () => {
  assert.equal(formatTick(59), '59s')
  assert.equal(formatTick(60), '1:00', 'minutes appear at 60s')
  assert.equal(formatTick(90), '1:30')
  assert.equal(formatTick(3600), '60:00', 'and past an hour keep counting minutes')
})

test('a label always fits the gap to the next tick', () => {
  // The real constraint is pixels, not characters: a label that overruns the
  // space between two ticks reads as belonging to the *next* one, which is
  // worse than an ugly label. ~6px per character at the ruler's font size.
  const CHAR_PX = 6
  const MIN_GAP_PX = 90
  for (const t of [0, 0.04, 0.5, 1, 59, 60, 599, 3600, 100000]) {
    const label = formatTick(t)
    assert.ok(
      label.length * CHAR_PX < MIN_GAP_PX,
      `"${label}" at ${t}s needs ${label.length * CHAR_PX}px of a ${MIN_GAP_PX}px gap`,
    )
  }
})

test('an absurdly long label still degrades rather than growing without bound', () => {
  // Beyond a few hours, minutes stop being the useful unit. It is not worth
  // switching formats, but it should be noticed rather than assumed.
  assert.equal(formatTick(100000), '1666:40', 'minutes keep counting; it is ugly, not wrong')
  assert.ok(formatTick(1e9).length < 12, 'and it does not run away')
})

// --- click modes -----------------------------------------------------------

const ev = (shiftKey: boolean, ctrlKey = false, metaKey = false) => ({ shiftKey, ctrlKey, metaKey })

test('a plain click replaces the selection', () => {
  assert.equal(selectModeOf(ev(false)), 'replace')
  assert.equal(selectModeOf(ev(false, true)), 'toggle', 'ctrl-click toggles')
  assert.equal(selectModeOf(ev(true)), 'range', 'shift-click extends')
})

test('cmd-click toggles too, because macOS users have no right button', () => {
  assert.equal(selectModeOf(ev(false, false, true)), 'toggle')
})

test('shift wins over ctrl when both are held', () => {
  // Shift means "extend from where I already am", which is the more specific
  // intent. The other order silently changes what ctrl+shift does.
  assert.equal(selectModeOf(ev(true, true)), 'range')
  assert.equal(selectModeOf(ev(true, false, true)), 'range')
})

// --- what a move drag does --------------------------------------------------
//
// A move drag **places** the clip; it never reorders. `placeClip` clamps the
// dragged clip against its predecessor, so:
//
// - dragging **right** pushes the successors along (position is derived);
// - dragging **left** comes to rest against the clip in front and does not cross
//   it. The predecessor stays exactly where it was.
//
// The old handler swapped the dragged clip past its neighbour, which threw the
// neighbour to the far side of the lane: the clip on the left visibly jumped
// away and read as being destroyed. The rule now is the user's own: a clip is a
// wall, not a door.

const c = (id: string, o: number, extra: Partial<Clip> = {}): Clip => ({
  id,
  lane: 'video',
  assetId: 'a',
  in: 0,
  out: o,
  ...extra,
})

const projectOf = (video: Clip[]): Project => ({ version: 2, assets: {}, video, audio: [] })
const startOf = (clips: Clip[], id: string): number => clipStart(clips, clips.findIndex((x) => x.id === id))

test('a clip dragged into free space lands where the pointer says', () => {
  // A(0–10)  B(10–12)  [gap]  C(18–28)
  const p = projectOf([c('A', 10), c('B', 2), c('C', 10, { offset: 8 })])
  const out = placeClip(p, 'video', 2, 21).video
  assert.equal(clipStart(out, 2), 21)
})

test('a clip dragged left stops at its predecessor and never crosses it', () => {
  const p = projectOf([c('A', 10), c('B', 10)])
  // Drag B's head from 10 deep into A.
  const out = placeClip(p, 'video', 1, 4).video
  assert.equal(startOf(out, 'A'), 0, 'A did not move')
  assert.equal(startOf(out, 'B'), 10, 'B stopped against A rather than swapping past it')
  assert.deepEqual(out.map((x) => x.id), ['A', 'B'], 'no reorder happened')
})

test('a clip at the head of the lane cannot be dragged before zero', () => {
  const p = projectOf([c('A', 10)])
  const out = placeClip(p, 'video', 0, -4).video
  assert.equal(clipStart(out, 0), 0)
})

test('dragging a clip right leaves the clip after it where it is', () => {
  // A gap ahead: the clip moves into it and the next clip does not move.
  const p = projectOf([c('A', 10), c('B', 10, { offset: 10 })]) // A 0–10, B 20–30
  const out = placeClip(p, 'video', 0, 3).video
  assert.equal(startOf(out, 'A'), 3, 'A moved into the gap')
  assert.equal(startOf(out, 'B'), 20, 'B stayed put')

  // No gap: A cannot move right without overlapping B, so it is blocked.
  const blocked = placeClip(projectOf([c('A', 10), c('B', 10)]), 'video', 0, 3).video
  assert.equal(startOf(blocked, 'A'), 0, 'A is walled in by B')
  assert.equal(startOf(blocked, 'B'), 10, 'and B is untouched')
})

test('dragging the left half of a cut leaves the right half still', () => {
  // The user's report: piece 1 pulled piece 2. A move now pins the successor.
  const p = projectOf([c('P1', 10), c('P2', 10)]) // P1 0–10, P2 10–20
  // Move P1 right as far as it can go; P2 must not move.
  const right = placeClip(p, 'video', 0, 5).video
  assert.equal(startOf(right, 'P1'), 0, 'P1 cannot overlap P2, so it stops')
  assert.equal(startOf(right, 'P2'), 10, 'P2 did not follow')
  // Give P2 a trailing gap and it is still pinned.
  const withGap = projectOf([c('P1', 10), c('P2', 10, { offset: 4 })]) // P2 at 14
  const moved = placeClip(withGap, 'video', 0, 3).video
  assert.equal(startOf(moved, 'P1'), 3, 'P1 moved into the gap')
  assert.equal(startOf(moved, 'P2'), 14, 'P2 stayed exactly where it was')
})

test('a clip dragged toward a gap stops at the clip in front, not inside the gap', () => {
  // A(0–10)  gap  B(20–30). B may move left within the gap, but not past A.
  const p = projectOf([c('A', 10), c('B', 10, { offset: 10 })])
  assert.equal(startOf(placeClip(p, 'video', 1, 15).video, 'B'), 15, 'it may sit in the gap')
  assert.equal(startOf(placeClip(p, 'video', 1, 4).video, 'B'), 10, 'but it cannot pass A')
})

// --- a single-clip move does not vibrate ------------------------------------
//
// The user's symptom, in one sentence: "when I drag one clip it shakes, but two
// clips together is smooth." Two faults met on the single-clip path. `placeClip`
// subtracted the clip's *own* offset, so each pointermove advanced it half the
// distance asked for and the error never closed; the magnet then fought the lag,
// stepping the clip forward and back. The group path was already smooth because
// `shiftLane` writes an absolute offset. This runs the handler's own arithmetic
// — snap, decide, place — and asserts the one property a vibration violates: the
// clip never moves backwards while the pointer advances.

test('a snapped single-clip move tracks the pointer without vibrating', () => {
  const c = (id: string, i: number, o: number): Clip => ({ id, lane: 'video', assetId: 'a', in: i, out: o })
  const project = (video: Clip[]): Project => ({ version: 2, assets: {}, video, audio: [] })

  let clips = [c('A', 0, 4), c('B', 0, 4)] // A 0–4, B 4–8
  // Grabbed by its head, so the pointer position *is* the desired start.
  const threshold = thresholdInSeconds(10, 80) // a 10px pull at 80px/s
  const snapTargets = collectTargets(project(clips), {
    playhead: 0,
    includePlayhead: false,
    lanes: ['video'],
  }).filter((t) => t.clipId !== 'B') // the dragged clip is never a target for itself

  let locked = null
  let last = clipStart(clips, 1)
  const path: number[] = []

  for (let px = 4; px <= 9.0001; px += 0.05) {
    let start = px
    const snapped = snapMove(px, clipDuration(clips[1]!), snapTargets, threshold, undefined, locked)
    if (snapped) {
      start = snapped.start
      locked = snapped.target
    } else {
      locked = null
    }

    clips = placeClip(project(clips), 'video', 1, start).video

    const now = clipStart(clips, 1)
    assert.ok(now >= last - 1e-9, `at px=${px.toFixed(2)} the clip moved backwards: ${last} → ${now}`)
    last = now
    path.push(now)
  }

  // It also arrives: the magnet releases and the clip reaches the final pointer.
  assert.equal(last, 9, 'the clip ended under the pointer, not short of it')
  // And the motion is one pass, not a stutter: each step is non-negative.
  for (let i = 1; i < path.length; i += 1) {
    assert.ok(path[i]! >= path[i - 1]! - 1e-9, `step ${i} went backwards`)
  }
})

// --- a ruler label must be a timecode ---------------------------------------

test('no tick label is ever an invalid timecode', () => {
  // `formatTick` rounded `t % 60` on its own, so it could reach 60 without
  // carrying: 119.5 gave `1:60`. Reachable, not theoretical — `tickInterval(400)`
  // is 0.5, so zooming in puts half-second ticks under the minute labels.
  const bad: string[] = []
  for (const zoom of [10, 40, 80, 200, 400]) {
    for (const duration of [30, 65, 130, 605, 3600]) {
      for (const label of ticks(duration, zoom).map(formatTick)) {
        const m = label.match(/^(\d+):(\d{2})$/)
        if (m && Number(m[2]) >= 60) bad.push(`${label} at zoom ${zoom}, ${duration}s`)
      }
    }
  }
  assert.deepEqual(bad, [], `invalid timecodes:\n  ${bad.join('\n  ')}`)
})

test('the seconds and the minutes always agree', () => {
  // The specific case that broke: 119.5 has 59.5 seconds, which rounds to 60.
  // Rounding the total and deriving both parts keeps them consistent.
  assert.equal(formatTick(59.5), '1:00', '59.5s is a minute, not 60 seconds')
  assert.equal(formatTick(119.5), '2:00', 'and 119.5s is two minutes')
  assert.equal(formatTick(179.5), '3:00')
  for (const t of [0, 0.04, 59, 60, 61, 3599, 3600]) {
    const label = formatTick(t)
    const m = label.match(/^(\d+):(\d{2})(\d?)$/)
    if (!m) continue
    const total = Number(m[1]) * 60 + Number(m[2])
    assert.ok(Math.abs(total - t) <= 0.5, `${label} does not read as ${t}s`)
    assert.ok(Number(m[2]) < 60, `${label} has 60 or more seconds`)
  }
})
