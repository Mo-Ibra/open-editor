/**
 * Timeline zoom geometry.
 *
 * The property worth protecting is not "the zoom changes" but **the time under
 * the pointer stays under the pointer**. Zooming about the timeline origin also
 * changes the zoom, and the difference is invisible in a screenshot and obvious
 * in the hand: the thing you were looking at slides out from under your cursor.
 *
 * Pure geometry, so all of this is checkable without a browser or a wheel.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  clampZoom,
  notchesFromDelta,
  scrollLeftAfterZoom,
  zoomAfterNotches,
  zoomFactor,
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_RATIO_PER_NOTCH,
} from '../src/app/store/zoom.ts'

/** The instant shown at a given pixel, given the scroll offset and zoom. */
const timeAt = (scrollLeft: number, localX: number, zoom: number): number =>
  (scrollLeft + localX) / zoom

test('one notch is fast enough to cross the range in a sane number of clicks', () => {
  // Measured on a real browser: at 1.15x a mouse user needed 11.5 clicks to go
  // from 80 to 400px/s, which reads as broken. The full range is only 40:1, so
  // a notch can afford to be brisker than the browser's own page zoom.
  // The realistic gesture: from the default, across to a close-up.
  const practical = Math.log(400 / 80) / Math.log(ZOOM_RATIO_PER_NOTCH)
  assert.ok(
    practical <= 7,
    `80 -> 400px/s should take at most 7 notches, takes ${practical.toFixed(1)} (was 11.5 at 1.15x)`,
  )
  assert.ok(ZOOM_RATIO_PER_NOTCH >= 1.25, 'a notch must be a decisive step, not a nudge')

  // The full 40:1 range is rarely walked end to end, but it must not be silly.
  const full = Math.log(ZOOM_MAX / ZOOM_MIN) / Math.log(ZOOM_RATIO_PER_NOTCH)
  assert.ok(full < 16, `the whole range should take under 16 notches, takes ${full.toFixed(1)}`)
})

test('notches are additive, so a burst is one gesture', () => {
  // Ten small trackpad deltas that together equal one notch must equal one
  // notch. This is what makes coalescing lossless.
  const one = notchesFromDelta(-100, 0)
  let summed = 0
  for (let i = 0; i < 10; i++) summed += notchesFromDelta(-10, 0)
  assert.ok(Math.abs(summed - one) < 1e-9, `${summed} vs ${one}`)
  assert.ok(Math.abs(zoomAfterNotches(80, summed) - zoomAfterNotches(80, one)) < 1e-9)
})

test('a burst of notches applies in one step', () => {
  const after = zoomAfterNotches(80, 4)
  assert.equal(after, Math.round(80 * ZOOM_RATIO_PER_NOTCH ** 4))
  assert.ok(after > zoomAfterNotches(80, 1), 'four notches go further than one')
  assert.equal(clampZoom(after), after, 'and a sane burst stays in range')
})

test('zero notches leaves the zoom alone', () => {
  assert.equal(zoomAfterNotches(80, 0), 80)
  assert.equal(zoomAfterNotches(80, Number.NaN), 80, 'a nonsense burst is ignored, not applied')
})

test('an enormous burst still clamps rather than exploding', () => {
  assert.equal(zoomAfterNotches(100, 10_000), ZOOM_MAX)
  assert.equal(zoomAfterNotches(100, -10_000), ZOOM_MIN)
})

test('a plain notch zooms in, and scrolling up zooms out', () => {
  assert.ok(zoomFactor(-100, 0) > 1, 'wheel up zooms in')
  assert.ok(zoomFactor(100, 0) < 1, 'wheel down zooms out')
})

test('one notch is the same ratio whatever the delta is measured in', () => {
  // A mouse reports pixels, some platforms report lines. One notch must be one
  // notch, or the same physical gesture zooms by different amounts.
  // Browsers report about 3 lines per wheel click, so 3 is one notch.
  const pixels = zoomFactor(-100, 0)
  const lines = zoomFactor(-3, 1)
  const pages = zoomFactor(-1, 2)
  assert.ok(Math.abs(pixels - lines) < 0.01, `pixel ${pixels} vs line ${lines}`)
  assert.ok(Math.abs(pixels - pages) < 0.01, `pixel ${pixels} vs page ${pages}`)
})

test('a notch is a constant ratio, not a constant number of pixels', () => {
  // Zooming in by a fixed *pixel* step feels progressively more sluggish and
  // reads as the wheel breaking. A ratio feels identical at every zoom.
  const small = zoomFactor(-100, 0)
  const large = zoomFactor(-400, 0)
  assert.ok(Math.abs(large - small ** 4) < 0.01, 'four notches should be four applications')
})

test('a gentle trackpad pinch moves less than a wheel notch', () => {
  // Trackpads send many small deltas. Treating each as a full notch makes
  // zooming feel uncontrollable.
  const gentle = zoomFactor(-10, 0)
  const notch = zoomFactor(-100, 0)
  assert.ok(gentle > 1 && gentle < notch, `${gentle} should be a smaller step than ${notch}`)
})

// --- the anchor ------------------------------------------------------------

const ZOOM_BEFORE = 80
const POINTER_X = 400
const SCROLL = 1000

test('the time under the cursor does not move', () => {
  for (const zoomAfter of [40, 80, 160, 400]) {
    const nextScroll = scrollLeftAfterZoom({
      scrollLeft: SCROLL,
      localX: POINTER_X,
      zoomBefore: ZOOM_BEFORE,
      zoomAfter,
    })
    const before = timeAt(SCROLL, POINTER_X, ZOOM_BEFORE)
    const after = timeAt(nextScroll, POINTER_X, zoomAfter)
    assert.ok(
      Math.abs(before - after) < 1e-9,
      `at ${zoomAfter}px/s the cursor moved from ${before}s to ${after}s`,
    )
  }
})

test('the anchor holds at the far left of the viewport', () => {
  const nextScroll = scrollLeftAfterZoom({
    scrollLeft: 0,
    localX: 0,
    zoomBefore: ZOOM_BEFORE,
    zoomAfter: 200,
  })
  assert.equal(nextScroll, 0, 'the origin stays put')
})

test('the anchor holds at the far right of the viewport', () => {
  const nextScroll = scrollLeftAfterZoom({
    scrollLeft: 5000,
    localX: 800,
    zoomBefore: ZOOM_BEFORE,
    zoomAfter: 160,
  })
  const before = timeAt(5000, 800, ZOOM_BEFORE)
  const after = timeAt(nextScroll, 800, 160)
  assert.ok(Math.abs(before - after) < 1e-9)
})

test('zooming out pulls the scroll left, zooming in pushes it right', () => {
  const out = scrollLeftAfterZoom({ scrollLeft: SCROLL, localX: POINTER_X, zoomBefore: 80, zoomAfter: 40 })
  const into = scrollLeftAfterZoom({ scrollLeft: SCROLL, localX: POINTER_X, zoomBefore: 80, zoomAfter: 160 })
  assert.ok(out < SCROLL, 'zooming out reduces the offset')
  assert.ok(into > SCROLL, 'zooming in increases it')
})

test('zooming about the origin is NOT the same thing, which is the bug', () => {
  // The wrong implementation scales the scroll by the same ratio as the zoom.
  // It looks reasonable and it moves the cursor's time, so it is worth pinning
  // that the two genuinely differ.
  const correct = scrollLeftAfterZoom({ scrollLeft: SCROLL, localX: POINTER_X, zoomBefore: 80, zoomAfter: 160 })
  const naive = SCROLL * (160 / 80)
  assert.notEqual(correct, naive)
  const anchored = timeAt(correct, POINTER_X, 160)
  const drifted = timeAt(naive, POINTER_X, 160)
  assert.ok(Math.abs(anchored - drifted) > 1, 'the naive version really does move the time')
})

// --- bounds ----------------------------------------------------------------

test('zoom is clamped to the range the slider offers', () => {
  assert.equal(clampZoom(1), ZOOM_MIN)
  assert.equal(clampZoom(10_000), ZOOM_MAX)
  assert.equal(clampZoom(80), 80)
  assert.equal(clampZoom(ZOOM_MIN), ZOOM_MIN, 'the bounds themselves are allowed')
  assert.equal(clampZoom(ZOOM_MAX), ZOOM_MAX)
})

test('a nonsense zoom falls back to the default rather than rendering nothing', () => {
  // NaN px/s would make every clip width zero and the timeline blank.
  assert.equal(clampZoom(Number.NaN), ZOOM_DEFAULT)
  assert.equal(clampZoom(Number.POSITIVE_INFINITY), ZOOM_MAX)
  assert.equal(clampZoom(Number.NEGATIVE_INFINITY), ZOOM_MIN)
})

test('zoom is rounded so the slider and the wheel agree exactly', () => {
  // 80.4px/s would show a fractional value the slider cannot represent.
  assert.equal(clampZoom(80.4), 80)
  assert.equal(clampZoom(80.6), 81)
})

test('the bounds are ordered and the default sits inside them', () => {
  assert.ok(ZOOM_MIN < ZOOM_DEFAULT && ZOOM_DEFAULT < ZOOM_MAX)
})
