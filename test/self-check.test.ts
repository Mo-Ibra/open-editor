/**
 * The export self-check.
 *
 * The interesting behaviour is the refusal. A `<video>` element reports audio in
 * three different ways, each arriving at a different moment, and a naive
 * `something || something` says "no audio" the instant a file that *does* have
 * audio loads. That produces a false alarm on a correct export, which is how
 * this check gets switched off — and then the real failure it exists to catch
 * goes unnoticed.
 *
 * So: three states, and 'not yet confirmed' is a first-class answer.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  audioVerdict,
  canJudgeAudio,
  readMediaFacts,
  selfCheckLine,
  type MediaFacts,
} from '../src/output/self-check.ts'

const facts = (over: Partial<MediaFacts> = {}): MediaFacts => ({
  width: 1920,
  height: 1080,
  duration: 15,
  enabledTrackCount: 0,
  decodedBytes: undefined,
  mozHasAudio: undefined,
  ...over,
})

// --- the three states ------------------------------------------------------

test('Firefox settles it outright, and it outranks everything else', () => {
  // mozHasAudio is a real answer, not a hint. It wins even when Chrome's
  // counters are still zero, which is exactly the moment a naive OR gets it
  // wrong.
  assert.equal(audioVerdict(facts({ mozHasAudio: true, decodedBytes: 0 }), true), 'present')
  assert.equal(audioVerdict(facts({ mozHasAudio: false, decodedBytes: 999 }), true), 'absent')
})

test('decoded bytes beat the track count', () => {
  // Chrome reports zero tracks until they are enabled, so the count is the
  // least reliable signal and must never outrank real evidence.
  assert.equal(audioVerdict(facts({ decodedBytes: 4096, enabledTrackCount: 0 }), true), 'present')
})

test('a browser with no signal at all says "not yet confirmed", never "absent"', () => {
  // The false-alarm case. We added audio, and the element has told us nothing:
  // claiming "absent" here would condemn a correct file.
  assert.equal(audioVerdict(facts(), true), 'not yet confirmed')
})

test('with no signal and no audio added, "absent" is a real answer', () => {
  assert.equal(audioVerdict(facts(), false), 'absent')
})

test('a silent export is confirmed absent once it has decoded nothing', () => {
  // We added no audio, and the browser has now actually looked and decoded
  // zero bytes. That is a verdict, not an absence of one.
  assert.equal(audioVerdict(facts({ decodedBytes: 0 }), false), 'absent')
})

test('an enabled audio track is treated as present', () => {
  assert.equal(audioVerdict(facts({ enabledTrackCount: 2 }), false), 'present')
})

test('canJudgeAudio is false only when the browser has no audio signal at all', () => {
  assert.equal(canJudgeAudio(facts()), false, 'Chrome before any decode')
  assert.equal(canJudgeAudio(facts({ mozHasAudio: false })), true, 'Firefox always')
  assert.equal(canJudgeAudio(facts({ decodedBytes: 0 })), true, 'Chrome once it has looked')
})

// --- the readout -----------------------------------------------------------

test('the readout names size, length and the audio verdict', () => {
  const line = selfCheckLine(facts({ decodedBytes: 2048 }), true)
  assert.match(line, /^1920×1080 · 15\.00s · audio present$/)
})

test('the readout says "not yet confirmed" rather than guessing', () => {
  assert.match(selfCheckLine(facts(), true), /audio not yet confirmed$/)
  assert.match(selfCheckLine(facts(), false), /audio absent$/)
})

test('a fraction of a second survives the formatting', () => {
  // A 15-second export that came out at 14.97s is the interesting case, and
  // `toFixed(2)` is what makes the disagreement visible.
  const line = selfCheckLine(facts({ duration: 14.967, decodedBytes: 1 }), true)
  assert.match(line, /14\.97s/)
})

test('a non-finite duration reads as zero, not NaN', () => {
  // A streaming blob mid-load reports NaN. That is "not known", and printing
  // NaN into the one diagnostic line makes the whole line untrustworthy.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const line = selfCheckLine(facts({ duration: bad, decodedBytes: 1 }), true)
    assert.ok(!line.includes('NaN'), line)
    assert.ok(!line.includes('Infinity'), line)
    assert.match(line, /0×0 · 0\.00s|\d+×\d+ · 0\.00s/)
  }
})

test('the reader passes the duration through untouched', () => {
  // Normalising in the reader as well would be the same rule in two places, and
  // the formatter is the one that must not print NaN.
  const fake = { videoWidth: 4, videoHeight: 2, duration: Number.NaN, audioTracks: [] }
  const info = readMediaFacts(fake as unknown as HTMLVideoElement)
  assert.ok(Number.isNaN(info.duration), 'the reader reports what it saw')
  assert.ok(!selfCheckLine(info, true).includes('NaN'), 'and the formatter copes')
})

test('the reader understands each browser\'s own audio signal', () => {
  const base = { videoWidth: 1, videoHeight: 1, duration: 1 }
  assert.equal(readMediaFacts({ ...base, audioTracks: [1, 2] } as never).enabledTrackCount, 2)
  assert.equal(
    readMediaFacts({ ...base, webkitAudioDecodedByteCount: 512 } as never).decodedBytes,
    512,
  )
  assert.equal(readMediaFacts({ ...base, mozHasAudio: true } as never).mozHasAudio, true)
  // Absent signals must be undefined, not 0 — 0 means "looked and found none".
  assert.equal(readMediaFacts(base as never).decodedBytes, undefined)
  assert.equal(readMediaFacts(base as never).mozHasAudio, undefined)
})
