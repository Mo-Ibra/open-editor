/**
 * What the preview paints, and whether it says why.
 *
 * This is the decision that used to be made inline in three places in
 * `Preview.tsx`, where the three disagreed: a hidden clip painted black, while a
 * gap and a missing decoder reported a problem and painted *nothing* — leaving
 * the previous clip's last frame frozen on the canvas.
 *
 * For a gap that is not cosmetic. The exporter writes black for every gap, so a
 * preview showing a frozen frame is showing something the exported file will not
 * contain, which is the failure ADR-1 exists to prevent.
 *
 * jsdom has no 2D canvas, so this tests the *decision* rather than the pixels —
 * and the decision is where the bug was.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { trackDuration, type Clip, type Project } from '../src/model/project.ts'
import { paintIntentAt, type Unavailable } from '../src/app/view/preview/paint-intent.ts'
import { emptyProject } from '../src/model/project.ts'

const vid = (id: string, i: number, o: number, extra: Partial<Clip> = {}): Clip => ({
  id,
  trackId: 'video',
  assetId: id,
  in: i,
  out: o,
  ...extra,
})

/** Everything decodable. */
const decodable: Unavailable = () => null

/** The blank intent at `t`, asserting that there is one. */
const blankAt = (clips: Clip[], t: number, u: Unavailable = decodable) => {
  const intent = paintIntentAt([clips], t, u)
  assert.equal(intent.kind, 'blank', `expected black at t=${t}, got ${intent.kind}`)
  if (intent.kind !== 'blank') throw new Error('unreachable, and the assert above said so')
  return intent
}

/** A(0–10)  [gap 10–14]  B(14–24, offset 4) */
const withGap = (): Clip[] => [vid('A', 0, 10), vid('B', 0, 10, { offset: 4 })]

// --- a gap is black, and it is not a fault ---------------------------------

test('a gap paints black', () => {
  const clips = withGap()
  assert.equal(trackDuration(clips), 24, 'the gap is part of the timeline')

  for (const t of [10, 11, 12, 13, 13.999]) {
    const intent = paintIntentAt([clips], t, decodable)
    assert.equal(intent.kind, 'blank', `t=${t} is silence and must be black`)
  }
})

test('a gap is an edit, so nothing is reported', () => {
  // The bug was not only that a gap painted nothing — it also *warned* about it,
  // blaming the end of the timeline for what is usually a two-second hole in the
  // middle. A warning for something the user did on purpose trains the reader to
  // ignore warnings, and the next real one goes unread.
  assert.equal(blankAt(withGap(), 12).fault, null, 'in particular it is not a fault')
})

test('a clip inside the timeline still decodes', () => {
  const clips = withGap()
  for (const t of [0, 5, 9.999, 14, 20, 23.999]) {
    const intent = paintIntentAt([clips], t, decodable)
    assert.equal(intent.kind, 'decode', `t=${t} is inside a clip`)
  }
})

// --- the boundaries, because an off-by-one here is a visible black frame ---

test('the gap is black and its edges are not', () => {
  const clips = withGap()
  assert.equal(paintIntentAt([clips], 9.999, decodable).kind, 'decode', 'the last instant of A')
  assert.equal(paintIntentAt([clips], 10, decodable).kind, 'blank', 'the first instant of silence')
  assert.equal(paintIntentAt([clips], 13.999, decodable).kind, 'blank', 'the last instant of silence')
  assert.equal(paintIntentAt([clips], 14, decodable).kind, 'decode', 'and B resumes')
})

test('a hidden clip is black and silent, like a gap', () => {
  const clips = [vid('A', 0, 10, { hidden: true })]
  assert.equal(blankAt(clips, 5).fault, null, 'hiding is something the user did')
})

test('past the last clip is black and silent too', () => {
  // Reachable without a fault: an audio-only tail makes the timeline longer than
  // the video lane, and the playback clock parks the playhead exactly on
  // `duration()` at the end. Neither is an error.
  const clips = withGap()
  const end = trackDuration(clips)
  assert.equal(blankAt(clips, end).fault, null)
})

test('an empty lane is black and silent', () => {
  assert.equal(blankAt([], 0).fault, null)
})

// --- a fault is a fault: it must be reported -------------------------------

test('a clip with no decoder is black AND reported', () => {
  // The counterpart to the gap case. Both paint black; only one says why, and
  // this is the one that must — "I can see nothing here" with no explanation is
  // what costs hours.
  const clips = [vid('A', 0, 10)]
  const intent = blankAt(clips, 5, (clip) => `no decoder for ${clip.id}`)
  assert.equal(intent.fault, 'no decoder for A')
})

test('missing media is reported with its own reason', () => {
  const gone: Unavailable = (clip) => (clip.id === 'A' ? `media for ${clip.id} was dropped` : null)
  assert.match(blankAt([vid('A', 0, 10)], 5, gone).fault ?? '', /dropped/)
  // A healthy clip does not become a fault — it just decodes.
  assert.equal(paintIntentAt([[vid('B', 0, 10)]], 5, gone).kind, 'decode')
})

// --- the decode case carries what the draw path needs ----------------------

test('the decode intent names the clip and the source time', () => {
  // Not just "there is a frame": the draw path needs the location (it must not
  // ask `clipAtLane` again — it sums the lane from the start on every call) and
  // the source time, which is a *source* position and is not the timeline one.
  // In-point 100s of a long file, laid at timeline 0. A clip cut from 1:40 must
  // seek to 1:47, not to 0:07 — conflating source and timeline time is how a 15s
  // trim once exported as a seven-minute file.
  const clips = [vid('A', 100, 110)]
  const intent = paintIntentAt([clips], 7, decodable)
  assert.equal(intent.kind, 'decode')
  if (intent.kind !== 'decode') return
  assert.equal(intent.loc.clip.id, 'A')
  assert.equal(intent.loc.index, 0)
  assert.equal(intent.loc.start, 0, 'the timeline position, not the source one')
  assert.equal(intent.sourceTime, 107, 'source in-point 100s plus 7s into the clip')
})

test('a gap before a clip does not shift its source time', () => {
  const clips = [vid('A', 0, 10), vid('B', 0, 10, { offset: 4 })]
  const intent = paintIntentAt([clips], 16, decodable)
  assert.equal(intent.kind, 'decode')
  if (intent.kind !== 'decode') return
  // B starts at 14 with in-point 0, so 16 is 2s of source — the timeline gap
  // before it must not leak into the seek.
  assert.equal(intent.sourceTime, 2)
})

// --- the invariant the bug was really about -------------------------------

test('every instant of a gap is blank, for a range of layouts', () => {
  // The general form of the bug: the exporter walks *every frame* of the
  // timeline and fills the gaps, so the preview has to agree at every instant,
  // not at the ones a hand-written case happened to pick.
  const layouts: { label: string; clips: Clip[] }[] = [
    { label: 'one gap', clips: withGap() },
    { label: 'two gaps', clips: [vid('A', 0, 5), vid('B', 0, 5, { offset: 3 }), vid('C', 0, 5, { offset: 7 })] },
    { label: 'a gap first', clips: [vid('A', 0, 5, { offset: 6 }), vid('B', 0, 5)] },
    { label: 'hidden in the middle', clips: [vid('A', 0, 5), vid('B', 0, 5, { hidden: true }), vid('C', 0, 5)] },
  ]

  for (const { label, clips } of layouts) {
    // 10ms steps is finer than any frame rate in play and coarse enough to be quick.
    const step = 0.01
    for (let t = 0; t <= trackDuration(clips) + 1e-9; t += step) {
      const intent = paintIntentAt([clips], t, decodable)
      if (intent.kind !== 'decode') continue
      // If it says decode, the instant really is inside a clip.
      const inside = clips.some((c) => {
        const start = clips.slice(0, clips.indexOf(c)).reduce((n, x) => n + (x.offset ?? 0) + (x.out - x.in), 0) + (c.offset ?? 0)
        return t >= start - 1e-9 && t < start + (c.out - c.in)
      })
      assert.ok(inside, `${label}: claimed a decode at t=${t.toFixed(2)}, which is not inside a clip`)
    }
  }
})

test('an empty project paints black rather than throwing', () => {
  // The state the app boots into. Every action has to survive it, and so does
  // the preview's first frame.
  const project: Project = emptyProject()
  const video = project.tracks.find((t) => t.type === 'video')!.clips
  assert.equal(blankAt(video, 0).fault, null)
})