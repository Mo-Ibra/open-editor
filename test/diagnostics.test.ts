/**
 * Preview diagnostics.
 *
 * The luma sampler is the part that can silently lie: sample too densely and a
 * 5-second timer becomes a denial of service; sample wrongly and "the video is
 * black" becomes a conclusion drawn from noise. The readouts matter for a
 * different reason — they are the only thing distinguishing a black frame from a
 * canvas that has collapsed to 0x0, which look identical from outside.
 *
 * All pure: pixel bytes in, wording out.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  audioLine,
  healthLine,
  layoutFault,
  layoutLine,
  overlayLines,
  sampleLuma,
  HEALTH_INTERVAL_MS,
  type Luma,
  type PreviewFacts,
} from '../src/dev/preview-diagnostics.ts'

/** RGBA bytes; `px` is a list of [r,g,b] pixels. */
const rgba = (px: [number, number, number][]): Uint8ClampedArray => {
  const data = new Uint8ClampedArray(px.length * 4)
  px.forEach(([r, g, b], i) => {
    data[i * 4] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = 255
  })
  return data
}

// --- luma ------------------------------------------------------------------

test('a black frame reads as 0, which is the "nothing was drawn" signal', () => {
  const black = rgba(new Array(256).fill([0, 0, 0]))
  assert.deepEqual(sampleLuma(black), { max: 0, mean: 0 })
})

test('a white frame reads as 255', () => {
  const white = rgba(new Array(256).fill([255, 255, 255]))
  assert.deepEqual(sampleLuma(white), { max: 255, mean: 255 })
})

test('luma is the average of the three channels, not a single one', () => {
  // Pure red is dark, pure green is bright. A red-only frame must not read 255.
  const red = rgba(new Array(256).fill([255, 0, 0]))
  assert.equal(sampleLuma(red).max, 85, '255/3 rounds to 85')
})

test('the sample step trades accuracy for cost, and is honest about it', () => {
  // One white pixel among black. A sparse sampler is allowed to miss it — which
  // is the trade — but the default must not be so sparse it misses everything.
  const one = rgba([[255, 255, 255], ...new Array(255).fill([0, 0, 0])])
  const dense = sampleLuma(one, 1)
  assert.equal(dense.max, 255, 'a per-pixel sample finds it')
  const sparse = sampleLuma(one, 64)
  assert.ok(sparse.max <= 255)
})

test('sampling is O(data / step), not O(data)', () => {
  // A 1280x720 canvas is 3.7MB of RGBA. The reason for the sparse grid is that
  // a full read at 60Hz is not a diagnostic.
  const big = new Uint8ClampedArray(1280 * 720 * 4)
  const t0 = performance.now()
  sampleLuma(big, 64)
  const elapsed = performance.now() - t0
  assert.ok(elapsed < 200, `sampling 3.7MB took ${elapsed.toFixed(0)}ms`)
})

test('an empty buffer does not divide by zero', () => {
  const empty = sampleLuma(new Uint8ClampedArray(0))
  assert.deepEqual(empty, { max: 0, mean: 0 })
  assert.equal(Number.isFinite(empty.mean), true)
})

test('luma is rounded to whole numbers so the log stays readable', () => {
  const odd = rgba(new Array(256).fill([1, 2, 3]))
  const l: Luma = sampleLuma(odd)
  assert.equal(Number.isInteger(l.max), true)
  assert.equal(Number.isInteger(l.mean), true)
})

// --- readouts --------------------------------------------------------------

const facts = (over: Partial<PreviewFacts> = {}): PreviewFacts => ({
  timeline: { playhead: 1.5, videoCount: 1, audioCount: 1, duration: 10, cachedFrames: 24 },
  counters: { paints: 282, blackFrames: 0, luma: { max: 199, mean: 27 } },
  layout: {
    width: 1540, height: 866, left: 289, top: 60,
    display: 'block', visibility: 'visible', opacity: '1', hidden: false,
  },
  clip: {
    index: 0, in: 0, out: 445.717, sourceTime: 1.548,
    assetName: 'clip.mp4', assetWidth: 1920, assetHeight: 1080, assetCodec: 'avc',
  },
  runtime: { inFlight: false, overlayOn: false, lastError: null },
  audio: { context: 'running', running: false },
  viewport: { width: 1280, height: 720 },
  decoder: { ready: true, error: undefined },
  cached: { width: 1920, height: 1080 },
  ...over,
})

test('the health line names every number you need to judge liveness', () => {
  const line = healthLine(facts())
  assert.match(line, /282 paints/)
  assert.match(line, /0 fully black/)
  assert.match(line, /max=199 mean=27/)
  assert.match(line, /cache=24 frames/)
})

test('the health line reports black frames, because silence is not a signal', () => {
  const line = healthLine(facts({ counters: { paints: 10, blackFrames: 10, luma: { max: 0, mean: 0 } } }))
  assert.match(line, /10 fully black/)
})

test('the layout line includes geometry, not just a size', () => {
  const line = layoutLine(facts())
  assert.match(line, /1540x866/)
  assert.match(line, /at 289,60/)
  assert.match(line, /display=block visibility=visible opacity=1/)
})

test('a collapsed canvas is a fault, not a health line', () => {
  // Correct frames on a 0x0 canvas look exactly like a black video.
  const collapsed = facts({
    layout: { width: 0, height: 0, left: 0, top: 0, display: 'block', visibility: 'visible', opacity: '1', hidden: false },
  })
  const fault = layoutFault(collapsed)
  assert.ok(fault, 'a zero-size canvas must be reported')
  assert.match(fault!, /no size on screen/)
  assert.equal(layoutFault(facts()), null, 'a healthy canvas reports nothing')
})

test('a tiny-but-nonzero canvas is still a fault', () => {
  assert.ok(layoutFault(facts({
    layout: { width: 1, height: 400, left: 0, top: 0, display: 'block', visibility: 'visible', opacity: '1', hidden: false },
  })))
})

test('a hidden picture is the requested state, not a fault', () => {
  // A zero-size canvas with `hidden` set is the user asking for more timeline.
  // Reporting it as a LAYOUT fault every five seconds is a monitor that cries
  // wolf, and a monitor that cries wolf stops being read.
  const hidden = facts({
    layout: { width: 0, height: 0, left: 0, top: 0, display: '', visibility: '', opacity: '', hidden: true },
  })
  assert.equal(layoutFault(hidden), null, 'a deliberately hidden picture is not a fault')
  assert.match(layoutLine(hidden), /picture hidden/)
  assert.doesNotMatch(layoutLine(hidden), /0x0/, 'and must not print a scary 0x0')
})

test('the audio line is the engine describing itself', () => {
  const line = audioLine(facts())
  assert.match(line, /^audio: /)
  assert.match(line, /"context":"running"/)
})

// --- the overlay -----------------------------------------------------------

test('the overlay is a fixed set of labelled lines', () => {
  const lines = overlayLines(facts())
  assert.equal(lines.length, 8)
  for (const prefix of ['t=', 'asset', 'clip', 'decoder', 'canvas', 'viewport', 'pixels']) {
    assert.ok(lines.some((l) => l.startsWith(prefix)), `missing the "${prefix}" line`)
  }
})

test('the overlay says which clip and how far into it', () => {
  const lines = overlayLines(facts())
  assert.ok(lines[0]!.includes('t=1.50'), 'playhead to 2dp')
  assert.ok(lines[0]!.includes('clip=0'), 'and which clip')
  assert.ok(lines[0]!.includes('idle'), 'and that nothing is decoding')
  assert.match(lines[2]!, /in=0\.00s out=445\.72s/)
  assert.match(lines[2]!, /source t=1\.55s/)
})

test('the overlay shows decoding state and the overlay toggle', () => {
  const busy = overlayLines(facts({
    runtime: { inFlight: true, overlayOn: true, lastError: null },
  }))
  assert.ok(busy[0]!.includes('decoding…'), 'a long ellipsis, not three dots')
  assert.ok(busy[0]!.includes('[D] overlay on'))
})

test('the overlay survives an empty timeline', () => {
  // The state the app boots into. Nothing here may throw or print NaN.
  const empty = facts({
    clip: null,
    timeline: { playhead: 0, videoCount: 0, audioCount: 0, duration: 0, cachedFrames: 0 },
    cached: null,
    decoder: { ready: false, error: undefined },
  })
  const joined = overlayLines(empty).join('\n')
  assert.match(joined, /clip=none/)
  assert.match(joined, /asset {2}none/)
  assert.match(joined, /in=—s out=—s/, 'dashes, not NaN')
  assert.match(joined, /nothing cached yet/)
  assert.match(joined, /decoder MISSING/)
  assert.ok(!joined.includes('NaN'), 'no NaN anywhere')
  assert.ok(!joined.includes('undefined'), 'no undefined anywhere')
})

test('the overlay names the problem when there is one', () => {
  const lines = overlayLines(facts({
    runtime: { inFlight: false, overlayOn: false, lastError: 'no video clips' },
  }))
  assert.match(lines.at(-1)!, /^PROBLEM {2}no video clips$/)
})

test('the overlay says ok when there is not', () => {
  assert.equal(overlayLines(facts()).at(-1), 'ok')
})

test('a decoder error is shown rather than swallowed', () => {
  const lines = overlayLines(facts({ decoder: { ready: false, error: 'unsupported codec' } }))
  assert.match(lines[3]!, /MISSING — unsupported codec/)
})

test('the health interval is slow enough to read', () => {
  // A timer that logs every frame is a denial of service wearing a diagnostic's
  // clothes; the whole point is that it is scannable.
  assert.ok(HEALTH_INTERVAL_MS >= 2000, `${HEALTH_INTERVAL_MS}ms is too chatty`)
})
