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
