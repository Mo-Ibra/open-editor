# Trace 02 — pressing play

This is the trace that explains the app's most important asymmetry:

> **Preview is approximate. Export is exact. The difference is the frame source,
> and nothing else.**

If you understand why, you understand most of what a video editor is.

## The whole path at a glance

```
keydown ' '
  └─ app/store/transport.ts   togglePlay()
      ├─ audio/audio-engine.ts   play()  — schedule every audio clip
      │                            └─ returns #runStart (an AudioContext time)
      └─ setPlaying(true)

app/view/preview/use-playback-clock.ts   120Hz poll
  └─ app/store/transport.ts   advanceClock() — read audio.now()
      └─ setPlayhead(t)                    ← a signal, nothing else

app/view/preview/Preview.tsx   createEffect sees playhead change
  └─ draw()
      ├─ preview/paint-intent.ts  paintIntentAt() — which clip, which source time
      ├─ media/frame-cache.ts  find()       — or do we already have it?
      ├─ media/library.ts      getCanvas()  — decode, async, may be stale
      └─ render/render.ts      renderFrame() — the one draw call
```

## 1. `togglePlay` — and why it can refuse

`src/app/store/transport.ts:204`:

```ts
async function togglePlay(): Promise<void> {
  if (project.tracks.every((t) => t.clips.length === 0)) {
    notify('warn', hasImportedFiles()
      ? 'Add a clip to the timeline first — double-click a file under Media.'
      : 'Drop a video file to get started.')
    return
  }
```

The empty check produces *different advice* depending on whether files are
imported. It is a small thing, and it is the sort of detail that distinguishes a
finished product from a working one.

Then the pause branch, which contains the first real lesson:

```ts
  if (playing()) {
    // Where the audio actually got to, not where we last drew the playhead.
    const at = audio.now() ?? playhead()
    // Read the position first, then stop — `setPlaying` owns stopping the engine.
    setPlaying(false)
    setPlayhead(at)
    return
  }
```

The playhead is snapped to `audio.now()`, not left where the last frame was
painted. Those are different numbers — the picture lags the sound by however
long the last decode took — and using the painted position is how a player ends
up jumping backwards when you press pause. Note the comment on the order: the
position is read *before* `setPlaying(false)`, because stopping the engine is what
`audio.now()` is asking about.

## 2. The AudioContext is the master clock

`src/audio/audio-engine.ts:1` states the three rules, and the first is the
important one:

> 1. **The AudioContext clock is the master.** It is a sound card clock; it does
>    not drift the way `performance.now()` and `setInterval` do. So the playhead
>    is *derived* from audio time while playing, rather than audio being nudged
>    to follow a JS timer.

Read that twice. The causality is reversed from the usual assumption. Most
players drive audio from a timer. This one drives the playhead from audio, and
`advanceClock` (`src/app/store/transport.ts:235`) shows the shape:

```ts
function advanceClock(): void {
  if (!playing()) return
  // Prefer the audio clock: it is the one the viewer is listening to.
  const audioTime = audio.now()
  if (audioTime !== null) {
    setPlayhead(Math.max(0, Math.min(audioTime, duration())))
    return
  }
  if (wallClockAnchor) { /* performance.now() fallback */ }
}
```

The fallback exists but is second, and only runs when `audio.now()` returns
`null` — meaning audio never started. If the sound card is the reference, then
when there is no sound card you are at least honest about falling back to the
wall clock, and you do so in exactly one place.

## 3. Scheduling audio is where seeking is won or lost

`src/audio/audio-engine.ts:133`, `play()`. Three decisions, each with a failure
mode behind it:

**`this.#runStart = ctx.currentTime + START_LEAD`** — deliberately in the
*future*, a beat of slack so scheduled sources are ready when they start. The
cost is that for the first `START_LEAD` ms, elapsed time is negative, which
produced a playhead of `t = -0.06`, a negative source timestamp, a decoder that
answered `null`, and a failure path that spun hundreds of times per second and
hung the tab. Hence the `Math.max(0, elapsed)` clamp in `now()` (`:121`), whose
comment records all of it. **This is the single best argument in the codebase for
reading comments before editing code.**

**`const sourceFrom = clip.in + offsetIntoClip`** — when playback starts
mid-clip, audio starts at the matching source offset, not at the beginning of the
clip. Getting this wrong is "the sound is out by a bit": invisible in a
five-second test, obvious in a ten-minute edit.

**`const delay = Math.max(0, startsAt - position)`** — a clip that begins in the
future is scheduled against the timeline clock, so the silence before it is real
silence rather than a hole. Skipping the gap would compress the sound and desync
everything after it.

The loop also skips clips entirely in the past, which is the one case where
skipping *is* correct.

## 4. The clock that only polls

`src/app/view/preview/use-playback-clock.ts` runs a 120 Hz interval while
playing, and every tick calls `advanceClock()`. Its docblock is the second thing
worth reading in full, because it explains a decision that looks wrong:

> **And it is deliberately not `requestAnimationFrame`.** rAF is suspended
> whenever the page is not being painted: a background tab, a minimised window,
> a devtools panel that took focus. A video editor is exactly the app where the
> user has devtools open, so making rAF load-bearing for the clock means
> playback silently does nothing.

Timers are *throttled* when hidden but still fire, and each step is computed from
`performance.now()` rather than accumulated — so it resumes in step rather than
drifting. The interval also warns on `visibilitychange` when playing in a hidden
tab, because "it went choppy" otherwise gets reported as a bug.

The 120 Hz is faster than any display and exists only so the playhead looks
smooth. It is not a precision requirement — the audio clock is.

## 5. A signal, and Solid does the rest

`src/app/view/preview/Preview.tsx:576`:

```ts
createEffect(() => {
  if (props.layout.pictureHidden()) return
  state.playhead()
  state.videoTracks()
  state.texts()
  state.project.assets
  canvas.width
  if (stageHeight() !== canvas.height) setStageHeight(canvas.height)
  draw()
  if (!inFlight && paintedAt !== state.playhead() && !lastError) drawDiagnostic()
})
```

There is no call to `render()` from the clock. The clock sets a signal; the
effect re-runs because it read that signal. That is the entire update mechanism
of this application.

The single guard reads a signal too, which is why it is there: hiding the picture
unmounts the canvas, so `canvas.width` would throw on a hidden stage. Tracking
`pictureHidden` means the effect also fires when the picture comes *back*.

The second half of the effect is a health check: nothing painted, no decode in
flight, no error — that combination means the loop is wedged, so say so on the
canvas instead of leaving a black rectangle.

## 6. From a timeline time to a source time

`draw()` at `src/app/view/preview/Preview.tsx:316` gets the frame's location and
source time from one function, `paintIntentAt` (`src/app/view/preview/paint-intent.ts:82`),
which is the conversion the whole app turns on:

```ts
const intent = paintIntentAt(state.videoTracks(), t, unavailable)
// → { kind: 'decode', loc, sourceTime: sourceTimeAt(loc, t) }
```

`sourceTimeAt` (`src/model/project.ts:305`) is the actual arithmetic:

```ts
const sourceTime = loc.clip.in + (t - loc.start)
```

`clip.in` is the offset into the source file; the timeline position is not.
Getting this backwards is how a preview ends up showing the wrong frame of a
trimmed clip while everything looks plausible.

`paintIntentAt` walks the video tracks from the top down (top layer wins) and
returns one of exactly two things: a clip to decode, or a blank — where the blank
carries a `fault: string | null`. That distinction is the point: a **gap** the
user cut has `fault: null` and is painted black without comment, because the
exporter fills it with black too; a missing decoder carries a reason and is
explained on screen. The comment at `Preview.tsx:349` records why it lives in one
function: it used to be decided inline in three places in `draw()`, and the three
disagreed.

The other early exits are all diagnostic: empty timeline, a hidden canvas, an
unknown asset. Each calls `explain()`, which logs the full context and draws the
overlay — because "black rectangle" is not a bug report.

## 7. Cache first, always

`src/app/view/preview/Preview.tsx:409`:

```ts
const cached = state.frameCache.find(sourceTime)
if (cached) { paint(cached.canvas, loc.clip, t); ...; return }
if (inFlight) return   // a decode is running; it will catch up
```

`FrameCache` is a 24-entry ring buffer (`src/media/frame-cache.ts:20`) holding
*held* frames — each entry covers a time span, so one entry can answer many
requests while you scrub slowly. That is the difference between a drag that
stutters and one that glides.

Then the rule that took a rewrite to get right, at `src/app/view/preview/Preview.tsx:437`:

```ts
// Cache the frame FIRST, unconditionally.
//
// A frame is identified by the source time it covers, so it stays valid however
// long the decode took. Discarding it because the playhead moved in the meantime
// throws away perfectly good data — and because the cache was never populated,
// every subsequent tick missed and asked for another decode. The result was ~150
// successful decodes and 3 paints: correct frames, all thrown away.
//
// Staleness governs the *paint*, never the *cache*.
```

That is a real measured number from a real bug, preserved because the fix is not
obvious. The asymmetry — a stale frame is fine to *keep* but not fine to *show*
— is the entire lesson.

Two more guards in the same function: `if (requestedAt !== forTime) return`
before painting (the playhead moved; the `finally` will redraw), and a `null`
from `getCanvas` treated as legitimate when `sourceTime < 0`, because that is
before the track's first timestamp and mediabunny documents it as a valid answer
rather than a failure.

## 8. The one draw call

`paint()` at `src/app/view/preview/Preview.tsx:511` computes how the frame fits
(an image `cover`s the frame, a video `contain`s its own aspect inside it) and
makes one call into `src/render/render.ts`:

```ts
renderFrame(context(), source, clip, { ...viewport, fit }, layersAt(at))
```

That function is also what the exporter calls.
[ADR-1](../decisions/0001-one-render-function.md) exists because this is the one
invariant that no test can enforce: there is no test that fails when you add a
second drawing path. Preview and export sharing `renderFrame` means there is
nothing that can drift between what you see and what you get. The only difference
between them is *which source frame is fetched* — never how it is drawn.

## Where the asymmetry comes from

Now the two paths can be compared, and the difference is small and total:

| | Preview | Export |
| --- | --- | --- |
| Frame source | `CanvasSink.getCanvas(t)` — nearest keyframe, async | `canvasesAtTimestamps` — exact batch |
| Frame timing | whatever the decoder gives | every frame, at the output fps |
| Audio | live `AudioBufferSource` graph | one pre-mixed `Float32Array` |
| Clock | audio, polled at 120 Hz | sample indices, computed once |
| Draw call | `renderFrame` | `renderFrame` |

Preview is approximate in exactly the two places it has to be — frame accuracy
and scheduling — and *shares* everything else. That is why the audio contract in
[trace 03](03-audio.md) matters so much: the preview's approximate clock and the
export's exact clock must agree about where every sample goes, or the two
disagree with each other and you get a file that does not match what you saw.

## What to do next

Read `src/app/store/transport.ts` in full — 305 lines, and every branch is a
decision about time. Then read `test/exporter.test.ts`, which is mostly about
the source-versus-output distinction that [trace 01](01-split.md) hinted at.
