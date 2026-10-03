# Bug list

Nineteen bugs found by reading the timeline, lane and playhead paths against
the model's own stated invariants, then **executing** each one. Every "CONFIRMED"
below was reproduced by running the real modules — the store, the model, or the
view helpers — not inferred from reading alone.

## The uncomfortable part first

`npm test` is **fully green**: 250 node-runner tests plus 6 component tests, zero
failures. Every bug here sits outside what the suite reaches.

That is not surprising once you look at what the suite covers. The tests are
mostly *model* tests — `model.test.ts`, `snapping.test.ts`, `zoom.test.ts` — and
they do their job well. The bugs cluster in the three places a model test cannot
see:

| Where | Why no test reaches it |
|---|---|
| `app/view/timeline/use-timeline-drag.ts` | Gesture logic lives in a hook that needs a live `PointerEvent`, a `getBoundingClientRect`, and a store. |
| Cross-slice wiring in `app/store/` | `edits.ts` and `transport.ts` hold each other through deferred thunks. `state.test.ts` exists precisely because a type checker cannot see this. |
| Agreement *between* two files | Nothing asserts that `Timeline.tsx`'s drop lane and `Lane.tsx`'s drop lane are the same lane, or that the preview's gap behaviour matches the exporter's. |

The repo already has the right instinct about this — `test/dom.test.ts` exists
because "behaviour that cannot be seen is tested at the source level". These need
the same treatment, plus real component tests for the gesture paths.

## Severity

Ordered by what a user would notice, not by how hard the fix is.

**Twenty fixed** — see [Fixed](#fixed) for what changed and what the regression tests
pin.

**#20 was found by the user, not by reading.** It is the worst bug on this list
and every test in the repo passed while it was live.

| # | Area | Bug | Severity | Status |
|---|---|---|---|---|
| [20](#20-dragging-one-clip-shakes--it-crawls-at-half-the-pointer-speed) | Clip | **Dragging one clip shakes; two or more is smooth** | **Critical** | ✅ fixed |
| [1](#1-a-trim-handle-dragged-past-the-other-edge-creates-a-zero-length-clip) | Clip | Trim handle past the far edge → zero-length clip | **High** | ✅ fixed |
| [3](#3-stopping-playback-with-a-click-does-not-stop-the-audio) | Playhead | Click-to-stop mutes the picture; audio keeps playing | **High** | ✅ fixed |
| [4](#4-in-a-gap-the-preview-keeps-the-last-frame-instead-of-going-black) | Playhead | Preview shows a stale frame in a gap; exporter writes black | **High** | ✅ fixed |
| [5](#5-a-group-drag-left-comes-apart-between-the-two-lanes) | Lane | Group drag desyncs the two lanes it moved together | **High** | ✅ fixed |
| [6](#6-after-one-split-a-linked-pair-is-four-clips-sharing-a-linkid) | Link | One split makes 4 clips share a `linkId` | **High** | ✅ fixed |
| [7](#7-split-selection-at-playhead-stops-working-after-one-split) | Lane | "Split selection" says *nothing to split* when there is | **High** | ✅ fixed |
| [8](#8-trimming-a-selected-linked-pair-trims-only-the-video) | Lane | Trim-to-playhead silently skips the audio half | **High** | ✅ fixed |
| [2](#2-dragging-a-clip-left-across-a-gap-teleports-it-to-the-front-of-the-lane) | Clip | Drag left across a gap teleports the clip to index 0 | **High** | ✅ fixed |
| [16](#16-position-math-is-onn2-everywhere) | Perf | `clipStart` sums from zero, inside a loop | **High at scale** | ✅ fixed |
| [9](#9-the-playhead-is-left-past-the-end-when-the-timeline-shrinks) | Playhead | Playhead outlives the timeline | Medium | ✅ fixed |
| [10](#10-s-pushes-a-phantom-undo-entry-when-it-splits-nothing) | Clip | `S` on empty space costs an undo step | Medium | ✅ fixed |
| [11](#11-dragging-the-out-handle-left-past-the-playhead-freezes-the-picture) | Clip | Trim-out drag does not move the preview | Medium | ✅ fixed |
| [12](#12-drop-snapping-ignores-the-clip-and-lane-toggles) | Snap | Drops snap to same-lane edges with clip snap **off** | Medium | ✅ fixed |
| [13](#13-turning-clip-snap-off-also-kills-butt-forward-snapping) | Snap | The end-edge target can never exist | Medium | ✅ fixed |
| [14](#14-after-a-swap-graboffset-is-never-rebased) | Clip | Clip jumps under the pointer after a reorder | Medium | ✅ fixed |
| [15](#15-the-ruler-prints-invalid-timecode) | Lane | Ruler label reads `1:60` | Medium | ✅ fixed |
| [17](#17-the-peaks-effect-re-enters-computepeaks-on-every-audio-lane-write) | Perf | Whole-buffer peak recompute per drag frame | Medium | ✅ fixed |
| [18](#18-arrow-keys-always-step-130-s) | Clip | Frame stepping ignores the source frame rate | Low | ✅ fixed |
| [19](#19-an-insert-drop-near-an-edge-lands-at-the-end-of-the-clip-it-landed-on) | Clip | Drop lands somewhere the pointer never was | Low | ✅ fixed |

**20 fixed, 0 open.**

The last four (5, 6, 7, 8) were closed together: 6, 7 and 8 are one root cause —
*a linked pair must stay a pair* — and 5 is the group-drag twin of the same
"two lanes disagree" fault. See [Fixed below](#fixed-the-last-four) for what
changed.

Plus one **found by inspection, not reproduced** — see
[the last section](#found-by-inspection-not-reproduced).

---

# Fixed

## ✅ 3. Stopping playback with a click does not stop the audio

**Cause.** "Playing" was two pieces of state — a signal and a running
AudioContext — and only `togglePlay` knew that. `setPlaying` was the bare signal
setter, so the two callers outside `togglePlay` (a click on the timeline, and the
end-of-timeline check in the playback clock) cleared the flag and left the sound
running. The two bugs covered for each other: `seek` reads `if (playing())`, so
once the flag was false `seek` took the quiet branch and nothing looked wrong.

**Fix** — `src/app/store/transport.ts`. `setPlaying` is now a function that owns
both halves, and `togglePlay` delegates to it so there is one owner rather than
one owner plus two that forgot:

```ts
function setPlaying(value: boolean): void {
  // Unconditional rather than `if (playing())`. A guard keyed on the flag is the
  // same assumption that caused this bug.
  if (!value) audio.stop()
  setPlayingFlag(value)
}
```

**And one extra thing the fix required.** `seek` during playback is
`void restartAt(...)` — fire-and-forget — so the `await` inside `restartAt` is a
window in which the user can click, and the run that was just cancelled would
land *afterwards* and start playing on a stopped transport. Same defect, one step
later. `restartAt` now checks `playing()` after the await and stops what it
started.

**Pinned by** (`test/state.test.ts`): *stopping playback stops the audio, not just
the flag* and *a seek in flight cannot resurrect a stopped transport*.

## ✅ 9. The playhead is left past the end when the timeline shrinks

**Cause.** `seek` clamps to `duration()` and `advanceClock` clamps to
`duration()`, but **neither runs when the lanes change** — only on playback and on
user seeks. Delete the clip you were parked on and nothing moved the playhead
back, leaving it at 20s on a timeline of nothing, drawn at x=1600 inside a 600px
track: clipped out of sight and unreachable by dragging.

**Fix** — `src/app/store/state.ts`, in `setProject`, which already exists for
exactly this shape of hazard (it prunes the selection, "because a selection
outliving the clip it names is a live hazard"). The playhead is the same kind of
orphan:

```ts
projects.markDirty()
transport.clampPlayhead()
```

plus the same call in `replaceProject`, since opening a shorter project
deliberately bypasses `setProject` key by key. `clampPlayhead` only writes when
the playhead is actually out of range — `setProject` runs on every drag frame,
and writing an unchanged value would dirty the preview's redraw effect for
nothing.

**Pinned by** (`test/state.test.ts`): *the playhead cannot outlive the timeline*,
*the playhead is pulled back when a lane is cleared*, and *a project write that
does not shorten the timeline leaves the playhead alone* (so the clamp cannot
become a hidden per-frame write).

**Side effect worth knowing:** dragging a trim handle left past the playhead now
pulls the playhead back, which removes part of the freeze in bug 11 — but 11 is
still open, because trim-*out* still does not move the preview.

## ✅ 20. Dragging one clip shakes — it crawls at half the pointer's speed

**Found by the user, in one sentence: "When I drag a clip, it moves but there's a
shake in the clip while I'm holding it. But when I drag two clips together, it
moves smoothly."**

**Severity: the worst on this list.** Not a cosmetic jitter — the clip does not
arrive. Everything else here is a wrong result; this one is a wrong *gesture*, and
it is on the most-used interaction in the app.

**Cause** — `src/model/project.ts:361` (`placeClip`), one term:

```ts
next[index] = { ...clip, offset: target - clipStart(clips, index) }
```

`clipStart` deliberately includes the clip's **own** offset — a gap sits *before*
a clip, so it counts toward where the clip lands. The docstring even warns about
the consequence of getting that wrong. But subtracting it here means:

```
target - (prefix + offsetNow)   ==   the increment, not the offset
```

`target` is absolute and fresh from the pointer on every `pointermove`, so each
move advanced the clip **half** the distance it had asked for, and the error never
closed. It is a first-order lag, `s(n) = s(n-1) + (target - s(n-1))`, not rounding:

```
pointer says | clip lands at | error
       4.05  |          4.05 |  0.00
       4.30  |          4.20 |  0.10
       6.00  |          5.20 |  0.80
       8.00  |          6.80 |  1.20   ← and it keeps growing
```

Replaying the real gesture through the actual `use-timeline-drag` branch, at 4px
per event with snapping off, so the magnet is out of the picture:

```
before:  ONE  deltas {0.05, 0}   4.00 -> 4.05 -> 4.05 -> 4.10 -> 4.10   ← every other move does nothing
         TWO  deltas {0.05}      4.00 -> 4.05 -> 4.10 -> 4.15 -> 4.20   ← linear
after:   ONE  deltas {0.05}      4.00 -> 4.05 -> 4.10 -> 4.15 -> 4.20
         TWO  deltas {0.05}      4.00 -> 4.05 -> 4.10 -> 4.15 -> 4.20
```

With snapping **on** the lag and the magnet fight each other, which is the visible
shake: deltas of `+0.2, -0.15` — the clip steps forward, then back.

**And a clip that already sits behind a gap could not be moved at all.** Every call
recomputed the same increment, so the clip never left its position:

```
c1 starts at 6 (offset 2);  placeClip(..., 8)  ->  6      ← did not move
```

**Why two clips were smooth** — the user had found the exact difference between the
two code paths. `shiftLane` accumulates its own `cursor` over the *new* layout, so
each clip's offset is absolute:

```
moveSelectionTo, same gesture:  error 0.00 at every step
```

`moveSelectionTo` is internally consistent even though it also computes a
delta-like term, because `shiftLane` reads the same current positions it was
derived from — the two cancel exactly. It was only the single-clip path that had
nobody to cancel against it.

**Fix** — subtract the prefix alone, so the offset written is absolute:

```ts
const prefix = index === 0 ? 0 : clipEnd(clips, index - 1)
const target = Math.max(prefix, start)
next[index] = { ...clip, offset: target - prefix }
```

**Why no test caught it.** Every existing `placeClip` assertion calls it **once**,
on a clip whose offset is `undefined`. And from a zero offset,
`clipStart(clips, index)` happens to equal `clipEnd(clips, index - 1)` exactly — so
the two expressions are the same number and the test passes either way. The bug
needs the *second* call, which is what only a drag does. The same
"offset 0 makes the difference invisible" trap applies to bug 1.

**Pinned by** (`test/model.test.ts`): *repeated placement tracks the pointer
exactly* (eight successive targets, each asserted to 1e-9), *a clip that already
has a gap can still be moved* (both directions), and *one clip and a group of clips
land in the same place* — which is the user's own sentence, turned into an
assertion.

## ✅ 4. In a gap the preview keeps the last frame instead of going black

**The worst kind of bug on this list: the preview and the export disagreed, and
the user is the only one who finds out.**

**Cause** — `src/app/view/Preview.tsx:173`. Three lines:

```ts
const loc = clipAtLane(state.project.video, t)
if (!loc) {
  explain(`playhead ${t}s is past the end of the timeline (${duration}s)`)
  return                       // ← nothing painted
}
```

The canvas keeps whatever was last drawn, so the picture **froze on the last frame
of the previous clip** for the whole gap. Meanwhile the exporter, walking the same
timeline, does the opposite:

```ts
// exporter.ts:339 — "A gap between clips is still timeline: the video must hold
// black for its duration, or the export comes out shorter than the timeline."
const emitBlankUntil = async (untilFrame) => { … renderBlank(ctx, renderOptions) … }
```

and `laneDuration`'s docstring states the rule the preview broke: *"A gap is part
of the timeline: the video holds black for it."*

**So this is an [ADR-1](docs/decisions/0001-one-render-function.md) violation** —
and the sharpest one available, because ADR-1 exists precisely so preview and
export cannot drift. The most reachable instance is an **audio-only tail**: the
timeline is as long as its longest lane, so any project with audio longer than its
video freezes on the last video frame for the whole tail, logging a warning about
the "end of the timeline" every two seconds.

**Why it survived: three inline decisions that disagreed.**

| | painted? | reported as |
|---|---|---|
| a hidden clip | yes | deliberate |
| a gap | **no** | a warning |
| no decoder | **no** | a fault |

Two of the three left the last frame on the canvas. So the fix is not "add
`renderBlank`" — it is that **black is a decision, and it had three owners.** It
now has one, in `src/app/view/preview/paint-intent.ts`, and the distinction it
draws is not *blank or not* but **an edit or a fault**:

- `fault: null` — the blackness is something the user did. A gap, a hidden clip,
  a clip with no picture track. Paint black, say nothing.
- `fault: <why>` — media gone from the library, or a decoder that will not open.
  Paint black **and** say so.

The second half matters as much as the first: the old code emitted a *warning* for
a deliberate gap, blaming the end of the timeline for what is usually a two-second
hole in the middle. A warning for something the user did on purpose trains the
reader to ignore warnings, so the next real one goes unread.

**Extended to a live path for the same bug.** The mid-decode re-check
(`Preview.tsx:296`) tested only for `hidden` — so **deleting** the clip under the
playhead while its frame was decoding painted that frame straight over the black.
Same fault, one step later. It now goes through the same function, and a reorder
that moves the clip out from under an in-flight decode is discarded too.

**The `entry.videoSink!` assertion** at the decode site is deliberate and
commented: `paintIntentAt` was handed the predicate and returns `decode` only when
it passes, so a second `if (!sink)` would be a second answer to a question with
one owner.

**Pinned by:**

- `test/paint-intent.test.ts` — 13 tests. *a gap paints black*, *a gap is an edit,
  so nothing is reported*, the boundary instants either side of a gap, *a clip
  with no decoder is black AND reported*, and *every instant of a gap is blank, for
  a range of layouts* — the general form, since the exporter walks every frame and
  the preview has to agree at all of them.
- `test/dom.test.ts` — two structural guards, because jsdom has no 2D canvas and
  the pixels cannot be asserted here: the blank branch must call `renderBlank`
  rather than only set a flag, and the mid-decode re-check must go through
  `paintIntentAt` rather than testing `hidden` alone.

**A structural guard had to be rewritten, not deleted.** `dom.test.ts` already
asserted the hidden-only re-check. Its *intent* was right and its *shape* was the
defect, so it now requires the re-check to name `paintIntentAt` and explicitly
forbids `current?.clip.hidden`.

## ✅ 2. Dragging a clip left across a gap teleports it to the front of the lane

**Cause** — `use-timeline-drag.ts:174`, one fallback:

```ts
const loc = clipAtLane(laneOf(state.project, lane), t)
return loc ? loc.index : 0        // ← a gap is not index 0
```

"Nothing here" and "the first clip" are different facts. This answered both with
`0`, and the answer fed the swap. So a clip whose leading edge rested over a gap
was sent to slot 0 — the front of the lane.

Two things were wrong, and only fixing the first would have left a bug behind:

- **a gap is not a slot** (above), and
- **the wrong point was being looked up.** The swap asked for
  `start + duration / 2` — the clip's *midpoint*, half a clip-length further on.
  For a long clip dragged slightly left, that names whatever lies *past* the
  neighbour actually being crossed.

**Reproduced.** With `A(0–10) B(10–12) [gap] C(20–30)`, dragging C's head to 11s
— unambiguously "swap with B" — put the midpoint at 16s, inside the gap, so the
clip went to index 0 instead of B's slot at 1.

**Fix.** Both decisions moved into a pure, exported `moveIntent(clips, index,
start)` with three answers, because "the clip goes where the pointer says" and
"the leading edge crossed a neighbour" and "the leading edge is over a gap and is
asking for nothing" are genuinely different outcomes and the old code had two
slots for three cases:

```ts
if (!clips[index]) return { kind: 'place', start }
if (index <= 0) return { kind: 'place', start }
if (start >= clipEnd(clips, index - 1) - 1e-6) return { kind: 'place', start }
const target = clipAtLane(clips, start)?.index ?? null
if (target === null || target === index) return { kind: 'hold' }
return { kind: 'swap', index: target }
```

The `!clips[index]` guard is load-bearing in a second way: `clipEnd(clips, index - 1)`
on a lane it has run out of returns `NaN`, and `NaN` compares false against
everything, so a stale index would have fallen through into a swap against slot 0
— the same teleport, one layer down.

Extracted as a pure function because that is the repo's own rule: *pure logic is
separated from I/O*, and `ticks.ts` exists for exactly this reason. `selectModeOf`
already sets the precedent in the same file.

**Pinned by** (`test/timeline.test.ts`): *a leading edge over a neighbour takes its
slot* (one event, one swap — not a cascade of one swap per clip crossed), *a
leading edge over a GAP asks for nothing, and does not teleport*, *the leading
edge decides, not the midpoint*, *the boundary between place and swap is the
predecessor end*, *a clip at the head of the lane places rather than swapping*,
and *an index that is not there places rather than throwing*.

## ✅ 14. After a swap, `grabOffset` is never rebased

**Cause** — `use-timeline-drag.ts:330`. The swap updated `drag.index` and nothing
else. But `moveClip` re-places a clip **flush** in its new slot
(`project.ts:344`, correct on its own: a gap is placed deliberately and a reorder
is a rearrangement), so two things were stale at once — where the clip is, and the
grab measured against where it was.

```
pointer 14, grabOffset 7 → raw 7; prevEnd 10
before:     [0, 10]  [A, B]
after swap: [0, 10]  [B, A]     ← B flush at 0, pointer says 7
next move:  [7, 17]             ← yanked 7s out from under the cursor
```

**Fix** — two lines, and the test established that they are not equally
important:

- **`place` after the `reorder`.** This is the load-bearing half. `moveClip` puts
  the clip flush in the new slot, which throws away where the pointer is; placing
  it straight after means the clip is where the pointer asked, in one step.
- **re-derive `grabOffset` from the clip's real position.** While `place` never
  clamps this is a **no-op** — the clip lands exactly where the old grab said. It
  is kept because `placeClip` *does* clamp against the new predecessor, and on that
  event the stale value leaves the clip trailing by the clamp.

The invariant worth stating is physical, and it is what the test asserts:

> **The point the pointer went down on is still under the pointer.**

Stated that way it catches the bug without depending on how `grabOffset` is
maintained — which matters, because a re-grab *alone* makes a broken gesture look
self-consistent. That was the first version of the test and it passed against the
broken handler.

**Pinned by** — two layers, because neither reaches the handler on its own:

- `test/timeline.test.ts`, *across a swap the grabbed point stays under the
  pointer*: replays the handler's arithmetic over a 340-event drag and asserts the
  grab point under the cursor every step. Also asserts that **each half alone
  fails**, so a regression says which half came back.
- `test/dom.test.ts`, *a swap places at the pointer and re-derives the grab*: a
  structural guard, because the replay test proves the arithmetic is *possible*,
  not that the handler *does* it. This is the repo's stated convention —
  "behaviour that cannot be seen is tested at the source level".

## ✅ 1. A trim handle dragged past the other edge creates a zero-length clip

**Cause.** `MIN_CLIP` was enforced by `splitOne`, `splitLinked` and
`survivorsInRange`, but **not** by `trimClip` — the one write path a user reaches
by dragging a handle. So dragging the out handle left past the in point produced
`in === out`, which is the state `survivorsInRange`'s own comment calls corrupt.
Such a clip is skipped by `clipAtLane`, so the playhead can never land on it, it
cannot be split, and it still sits in the array shifting everything after it.

**Fix** — `src/model/project.ts`. `MIN_CLIP` moved above `trimClip`, because it is
a rule about *every* write path rather than about splitting, and `trimClip` now
refuses a trim that would leave less than `MIN_CLIP`:

```ts
if (outClamped - inClamped < MIN_CLIP) return project
```

**Refused rather than clamped**, and that is the whole design of the fix: which
end the user is holding is not an argument to `trimClip`, and clamping both ends
would move the one they are keeping still. The visible result is identical
anyway, because every `pointermove` is its own call — the last accepted one is
where the handle comes to rest.

A clip that arrived from elsewhere already shorter than `MIN_CLIP` (an overwrite
can leave a sliver) can still be *grown*. Only shrinking it further is refused.

**One existing assertion changed.** `test/model.test.ts` pinned the old
behaviour — `trimClip(p, 'video', 0, 5, 1).video[0].out === 5`, labelled "out is
never before in". That test was asserting the bug: it only passed because the
zero-length clip came back. It now asserts the lane is returned untouched.

**Pinned by** (`test/model.test.ts`): *a trim cannot produce a clip too short to
split* — four assertions, including one either side of the 40 ms limit so the
guard cannot quietly become a "trims below 40 ms do nothing" cliff.

## ✅ 10. `S` pushes a phantom undo entry when it splits nothing

**Cause.** `splitAt` called `history.commit()` on its first line, before knowing
whether there was a clip under the playhead. The model already had the right
instinct elsewhere: `duplicateClips` returns the *same* project for a no-op
precisely "so callers can rely on that to skip a history entry for a no-op", and
`splitSelectionAtPlayhead` commits only after `split > 0`. `splitAt` was missed.

The user paid twice — once for the phantom entry, and again when the undo they
pressed to be safe ate their previous real edit.

**Fix** — `src/app/store/edits.ts`. Compute first, then commit. `splitLinked`
returns the identical project when the cut is refused, so **identity is the
honest test**:

```ts
if (next === before) return
history.commit()
setProject(replace(next))
```

The three cases (named lane / one clip selected / nothing selected) are unchanged
in behaviour, including the fall-through to the both-lanes loop when a selection
outlives its clip. The unconditional `setProject` in the no-selection branch is
gone too, so a `S` over empty space no longer dirties the project either.

**Extended to the sibling function.** `splitSelectionAtPlayhead` had the same
defect for a *different* reason, found while fixing this one: it guards with
`MIN_SPLIT = 0.01` but `splitLinked` enforces `MIN_CLIP = 0.04`, so a cut between
10 ms and 40 ms from an edge passed the store's guard, was refused by the model,
and was still counted, committed and announced as "Split 1 clip." Fixed with the
same identity check rather than by reconciling the two constants — the two
numbers answer different questions (how close is too close *to attempt* versus to
*produce*), and one of them being wrong is not a reason to make them agree.

**Pinned by** (`test/state.test.ts`): *a split that split nothing costs nothing*
and *a split refused as too close to an edge costs nothing either* (the second
uses the 20 ms case, which is inside `MIN_SPLIT` and outside `MIN_CLIP`).

## ✅ The last four: a linked pair must stay a pair

**#6, #7 and #8 are one root cause, and #5 is its group-drag twin.** The fix was
made in the model, not at the three symptoms, because patching them separately
would let them drift apart again.

**#6 — after one split, four clips shared a `linkId`.** `splitLinked` left the
original id on *all four* halves. `linkedPartner` searched both lanes and returned
the first other clip with that id, so video-right's partner resolved to
video-*left* — a same-lane clip. Everything downstream then acted on the wrong
pair, and the audio half of the second cut was never touched:

```
cut once at 5s:  V0──V1        A0──A1     (one id L across all four)
cut again at 10: V0──V1──V1'   A0──A1     ← audio did not split
```

**Fix** — two changes in `src/model/project.ts`:

- `splitLinked` gives the right halves **one fresh `linkId` between them**, and
  leaves the original id on the left halves. The two sides are now two real
  pairs, exactly the shape `duplicateClips` already used for a copy.
- `linkedPartner` **requires the other lane**. A link pairs picture with sound,
  so the answer can only be the same id in the opposite lane. The old search
  returning a same-lane match was the other half of the bug; requiring the lane
  also makes an old project written by a previous build safe to open.

**#7 and #8 — the store copied split's link dedupe into trim.** The dedupe exists
so a selected pair is split once (`splitLinked` cuts both halves). `trim` does
*not* touch the partner, so applying the same dedupe dropped the audio half:
"Split selection" could report "nothing to split" when a cuttable pair sat under
the playhead, and "Trim selection" trimmed only the picture. Fixed by deduping
per pair (which the per-pair ids now give for free) on the split path, and by
removing the dedupe entirely from `trimSelectionToPlayhead` — each selected clip
takes its own nearest edge, which is what its docstring always claimed.

**#5 — a leftward group drag clamped each lane independently.** `shiftLane`
clamps by the first selected clip's predecessor, and that wall is at a different
place in each lane whenever one side sits behind a gap. So the picture stopped at
zero while its sound kept travelling: one gesture, two outcomes, no undo entry
that says so. `moveSelectionTo` now derives the desired delta, clamps it **once**
to the most-constrained lane, and applies that single delta to both. The block
stays rigid — it may stop short of the pointer, which is the honest cost of the
docstring's promise.

**Pinned by:**

- `test/model.test.ts` — *splitting a linked pair splits BOTH* now asserts two
  separate pairs and the defining partner property; *a linked pair survives being
  split more than once* cuts a pair twice and checks every half still finds its
  own partner.
- `test/state.test.ts` — *a second cut cuts the sound too*, *splitting a
  multi-selection still finds the pair under the playhead*, and *trim selection
  trims both halves of a selected pair*.
- `test/move-selection.test.ts` — *a linked pair dragged left stays rigid when one
  lane hits a wall* and *a group drag left is limited by the more constrained of
  the two lanes*.

---

# Clips

## 1. ✅ A trim handle dragged past the other edge creates a zero-length clip

**Status: fixed** — see [Fixed](#1-✅-a-trim-handle-dragged-past-the-other-edge-creates-a-zero-length-clip).

**Where:** `src/model/project.ts:705` (`trimClip`). `MIN_CLIP` is defined at
`:718` and used by `splitOne:497`, `splitLinked:734` and the partner split at
`:753` — but **not** by the one path a user reaches by dragging a handle.

`trimClip` clamps `out >= in` and nothing else, so `out === in` is reachable and
legal as far as the model is concerned.

**Why it matters more than it looks:** `survivorsInRange`'s own comment at `:553`
says producing one is a bug —

> Treating "fully inside" as "straddles the end" produced a clip with out < in — a
> zero-length clip, which the model calls a corrupt clip, and which divides by
> zero somewhere later.

So the codebase has already been bitten by this and wrote a guard. The trim path
was missed.

**Reproduced:**

```
before: v[0] in=2 out=12
drag the OUT handle left past the IN point →  in=2 out=2   duration=0
drawn width = Math.max(2, 0) = 2px
clipAtLane(0..5) → null null null null null null
```

The clip becomes a 2px sliver that `clipAtLane` can never return — so the
playhead skips it, the preview never shows it, and `splitAt` refuses to split it.
It is still in the array, still exported, and still shifts everything after it.

**Fix:** apply the same `MIN_CLIP` floor in `trimClip` that every other edit
path applies, so a handle stops at the minimum instead of passing through.

## 2. Dragging a clip left across a gap teleports it to the front of the lane

**Where:** `src/app/view/timeline/use-timeline-drag.ts:174`

```ts
function indexAtTime(t: number, lane: Lane): number {
  const loc = clipAtLane(laneOf(state.project, lane), t)
  return loc ? loc.index : 0        // ← a gap is not index 0
}
```

The `loc ? … : 0` fallback is fine for "nothing here, use 0" and wrong for
"something is here, and it is a gap". It feeds the swap at `:327`:

```ts
const target = indexAtTime(start + clipDuration(clip) / 2, drag.lane)
if (target !== drag.index && target >= 0) {
  state.reorder(drag.lane, drag.index, target)
```

**Reproduced.** With `A(0–10) B(10–12) [gap 12–20] C(20–30)`, dragging C's head
to 11s — which reads unambiguously as "swap with B" — gives a midpoint of 16s,
which is inside the gap:

```
midpoint 16s → GAP → index 0
reorder target = 0     (WRONG: C teleports in front of A)

control, same drag with no gap → index 2   (correct)
```

Delete the gap and the identical gesture is correct. The bug only exists because
gaps are a first-class feature of this model — the app encourages them.

**Note** the midpoint itself is a second problem: it is `start + duration / 2`,
so a long clip dragged slightly left puts its midpoint well past the intended
target. Both halves of this need addressing: a gap-aware "what is at or around
this time" query, and a swap test based on the dragged clip's leading edge
rather than its midpoint.

**Fix:** return `null` for a gap and handle it explicitly — the honest answer to
"which clip is under 16s" is "none", and the swap branch needs a defined answer
for "none".

## 10. ✅ `S` pushes a phantom undo entry when it splits nothing

**Status: fixed** — see [Fixed](#10-✅-s-pushes-a-phantom-undo-entry-when-it-splits-nothing).

**Where:** `src/app/store/edits.ts:99`

```ts
function splitAt(time: number, lane?: Lane): void {
  history.commit()          // ← before we know there is anything to split
  if (lane) {
    const loc = clipAtLane(laneOf(project, lane), time)
    if (!loc) return        // …and we have already paid for it
```

The model is careful about this elsewhere — `duplicateClips` returns the *same*
project for a no-op precisely so callers "can skip a history entry for a no-op"
(`project.ts:670`). `splitSelectionAtPlayhead:169` does the same, committing only
after `split > 0`. `splitAt` was missed.

**Reproduced:**

```
S with the playhead past the end of the selected clip:
  video clips: 1 (unchanged — nothing was split)
  canUndo: true            ← a phantom entry
one undo later:
  video clips: 1           ← nothing happened, and the stack is now empty
```

**Fix:** move `history.commit()` below the point where the edit is known to be
real, matching `splitSelectionAtPlayhead`.

## ✅ 11. Dragging the out handle left past the playhead freezes the picture

**Where:** `src/app/view/timeline/use-timeline-drag.ts:342-384`

`onPointerMove` seeks the playhead in exactly one case — `case 'playhead'`. The
`move` and `trim-in`/`trim-out` cases never call `state.seek`. So during a
gesture the playhead stays wherever `onPointerDown` put it (`:190`).

Two consequences, one of them good:

- **Trim-in works by accident.** `sourceTimeAt(loc, t)` is `clip.in + (t - start)`,
  so dragging the in-handle changes `clip.in`, which changes the source time the
  preview asks for. The picture follows.
- **Trim-out does not work at all.** `clip.out` is not part of `sourceTimeAt`, so
  the preview keeps showing the same frame for the whole gesture. And once the
  new out-point passes the playhead, `clipAtLane` returns null and the preview
  hits bug **#4** — it logs "past the end of the timeline" and stops painting.

**`move` does not seek, and that is correct** — see the fix note. Dragging a clip
must not drag the playhead with it; that is what every editor does, and it is what
keeps the playhead a measurement rather than a follower. The earlier version of
this entry listed it as a symptom, which was wrong.

**Fix:** seek to the dragged edge on each `pointermove` for `trim-out`, which is
the one case with no other mechanism making the preview follow.

## 14. After a swap, `grabOffset` is never rebased

**Where:** `src/app/view/timeline/use-timeline-drag.ts:330`

```ts
state.reorder(drag.lane, drag.index, target)
drag = { ...drag, index: target }        // index is updated…
                                       // …grabOffset is not
```

`moveClip` re-places the moved clip **flush** against its new predecessor
(`project.ts:344`, which is correct — a reorder is not a gap). But `grabOffset`
was measured against the old layout, so `raw = t - drag.grabOffset` no longer
corresponds to the point the user grabbed. The clip visibly jumps on the next
`pointermove`.

**Reproduced** with a grab 7s into the clip and a pointer move that triggers the
swap:

```
pointer 14, grabOffset 7 → raw start 7; prevEnd 10
before:     [0, 10]  [A, B]
after swap: [0, 10]  [B, A]        ← B is flush at 0
next move places at raw=7: [7, 17]  ← B jumps from 0 to 7 under the pointer
```

**Fix:** recompute `grabOffset` against the post-reorder layout, so the grabbed
point stays under the pointer across the index change.

## 18. Arrow keys always step 1/30 s

**Where:** `src/app/store/transport.ts:30` and `:160`

```ts
const OUTPUT_FPS = 30                        // "Fixed, because the export muxer wants a constant rate"
function step(frames: number): void {
  seek(playhead() + frames / outputFps())
}
```

The muxer wanting a constant rate is true and irrelevant to *playback* stepping.
The step should be the **source's** frame rate, or a whole number of frames at
that rate.

**Reproduced** with a 24 fps source:

```
source is 24fps; outputFps() = 30
one ArrowRight moved the playhead 0.033333s = 1/30s = 0.8 of a frame
```

Repeated stepping walks off frame boundaries, so `←`/`→` do not land on
distinguishable frames.

## 19. An insert drop near an edge lands at the end of the clip it landed on

**Where:** `src/model/project.ts:516`

This one is **deliberate** — the comment at `:523` says so — but the consequence
is worth writing down because the pointer position is discarded entirely.

```
dropped at 0.01s inside a clip starting at 0 (insert mode):
  v[0] x   0-10  @0.00
  v[1] new 0-4   @10.00     ← the pointer was at 0.01s
```

`splitOne` refuses (the cut is within `MIN_CLIP` of the start), so the clip is
inserted *after* the one it landed on with no offset. The user aimed at 0.01s and
got 10s. Correct per the stated intent; worth a shake or a snap-back rather than
silence.

---

# Lanes and links

## 5. A group drag left comes apart between the two lanes

**Where:** `src/model/project.ts:416` (`shiftLane`), driven by `moveSelectionTo:389`

The docstring promises a **rigid shift**:

> The selected clips keep their order and their spacing, and each lane is
> repacked around them.

The clamp is `target = Math.max(cursor, desired)`. For the **first** selected
clip in a lane, `cursor` is its *current* start — so a leftward drag is clamped
by where the clip already is, not by `delta`. Two lanes whose first selected
clips sit at different offsets therefore clamp differently.

**Reproduced.** Video clip at 0, audio clip sitting behind a 5s gap:

```
selection: [V1 @0, A1 @10]     drag the block LEFT by 3
→ video moved 0s, audio moved -3s

control, same setup dragged RIGHT by 13 → both +13 (rigid, as documented)
```

Rightward drags stay rigid; leftward drags against absolute zero break the block.
A gesture that started as one movement leaves a linked pair permanently out of
sync, and there is no undo entry distinguishing it from a deliberate edit.

**Fix:** clamp against the *anchor lane's* realised delta so every lane moves by
the same amount, and let the collision constraint push in only one lane at a
time — or accept the asymmetry and say so in the docstring.

## 6. After one split, a linked pair is four clips sharing a `linkId`

**Where:** `src/model/project.ts:739` and `:755`

```ts
const right: Clip  = { ...clip, id: newId('clp'), in: clip.in + local, offset: 0 }
const pRight: Clip = { ...p,     id: newId('clp'), in: p.in + partnerLocal, offset: 0 }
```

Both right halves keep the original `linkId`. After splitting a linked pair once,
**four** clips share one `linkId` — two in each lane.

`linkedPartner` (`:266`) searches both lanes and returns the first other clip
with a matching id, so it now returns a **same-lane** neighbour:

```
before split, partner of v = a1  (lane audio)
after split:  video = v(0-5) clp_x(5-10)
             audio = a1(0-5) clp_y(5-10)
partner of video-right = v  in lane video        ← its own left half
```

`linkedPartner` is what `selectedPartner()` returns, so this is what the UI
offers as the linked partner, and what the context menu acts on.

**Fix:** make `linkedPartner` require the *other* lane explicitly, and give the
right halves their own link group (or model a link as a pair of ids rather than
one shared string).

## 7. Split selection at playhead stops working after one split

**Where:** `src/app/store/edits.ts:150` (and the identical `:187`)

```ts
const key = c.linkId ?? c.id
if (seen.has(key)) return false
seen.add(key)
```

The dedupe exists so a selected pair is split **once** — correct in isolation,
because `splitLinked` cuts both halves. Combined with bug **#6**, after one
split all four halves collapse to a single key and only **one** target survives.

**Reproduced:**

```
pass 1 (selection = the pair), playhead 5s  → video 2, audio 2   ✓
selectAll (4 clips), playhead 8s            → video 2, audio 2   ✗
notify: "Nothing to split — put the playhead inside a selected clip."
```

The playhead is at 8s, inside all four selected clips. The user is told there is
nothing to split, and is right to believe the app.

`trimSelectionToPlayhead:187` has the same dedupe, and there it is worse — see
bug **#8**.

**Fix:** dedupe by *pair*, not by `linkId` string — group the four halves into
two pairs and act on both.

## 8. Trimming a selected linked pair trims only the video

**Where:** `src/app/store/edits.ts:179`

`trimSelectionToPlayhead` copies the dedupe from `splitSelectionAtPlayhead`, but
`trim()` touches **one lane**:

```ts
for (const { clip, lane, index } of usable) {
  if (nearStart) trim(lane, index, at, clip.out)
  else           trim(lane, index, clip.in, at)      // ← no partner handling
}
```

So the dedupe drops the audio half for a reason that does not apply here.

**Reproduced:**

```
selected both halves of the linked pair, playhead at 4s
  video in/out = 4  10
  audio in/out = 0  10      ← never trimmed
```

**Fix:** `trimSelectionToPlayhead` should trim both halves of a selected pair, or
not dedupe at all and let each selected clip take its own nearest edge.

## (lane-adjacent) Overwriting a group never keeps the two lanes consistent

**Where:** `src/app/store/assets.ts:254`

`addAssetAt` calls `placeClipAt` **once per lane**, so a linked pair dropped at
one time can end up placed differently: each lane re-derives its own offsets
independently, and a straddling clip is cut at a different point in each. The
`linkId` is shared, so the UI reports a linked pair that is not aligned.

---

# Playhead and transport

## 3. ✅ Stopping playback with a click does not stop the audio

**Status: fixed** — see [Fixed](#3-✅-stopping-playback-with-a-click-does-not-stop-the-audio).

**Where:** `src/app/store/transport.ts:55` (the raw setter) and
`src/app/view/timeline/use-timeline-drag.ts:189`

`setPlaying` is documented as exposed raw on purpose:

> Exposed raw because scrubbing while playing must halt playback — that is what a
> user dragging the ruler expects, and it is not something `seek` can decide on
> their behalf.

But it is the bare signal setter. **Only `togglePlay` calls `audio.stop()`**
(`transport.ts:130`). So the drag controller's stop path:

```ts
if (state.playing()) state.setPlaying(false)
state.seek(state.xToTime(x))
```

sets the flag to false, which makes `seek` take its non-playing branch, which
means **nothing ever calls `audio.stop()`**. The AudioContext keeps running.

**Reproduced:**

```
playing: true   audio.running: true
after setPlaying(false) + seek:  playing = false   audio.running = true
source.stop() calls: 0
```

The user clicks the timeline to stop. The picture freezes and the sound does not.
`use-playback-clock.ts:58` has the same shape — its end-of-timeline check also
calls `setPlaying(false)` without stopping the engine.

**Fix:** `setPlaying` should stop the engine when it transitions to false. The
raw setter is the right seam; it is doing the wrong thing at it.

## ✅ 4. In a gap the preview keeps the last frame instead of going black

**Where:** `src/app/view/Preview.tsx:173`

```ts
const loc = clipAtLane(state.project.video, t)
if (!loc) {
  explain(`playhead ${t} is past the end of the timeline (${state.duration()}s)`)
  return                       // ← no renderBlank
}
```

Nothing is painted, so the canvas keeps whatever was last drawn. The exporter
does the opposite, for the same timeline, in the same project:

```ts
// exporter.ts:339 — "Walk the whole timeline, not just the clips."
const emitBlankUntil = async (untilFrame) => { … renderBlank(ctx, …) … }
```

and `laneDuration`'s docstring states the rule the preview breaks:

> A gap is part of the timeline: the video holds black for it and the audio holds
> silence.

**This is an [ADR-1](docs/decisions/0001-one-render-function.md) violation.** The
whole reason there is one `renderFrame` is that preview and export cannot drift;
here they have. A user with a gap in the middle of their edit approves a preview
that shows a frozen frame, and gets black in the file.

Two smaller problems in the same three lines:

- The message blames the timeline end for what is usually a mid-timeline gap.
- It is rate-limited to one log line per 2s (`explain:127`), so a playhead
  crossing a gap logs a **warning** that is actually correct behaviour.

**Reproduced by inspection** — jsdom has no 2D canvas, so this cannot be
exercised in the current harness. It needs a component test with a canvas stub
that records `fillRect` calls.

## 9. ✅ The playhead is left past the end when the timeline shrinks

**Status: fixed** — see [Fixed](#9-✅-the-playhead-is-left-past-the-end-when-the-timeline-shrinks).

**Where:** no clamp on project writes. `seek` clamps
(`transport.ts:101`) and `advanceClock` clamps (`:151`), but neither runs when the
*project* changes under a stationary playhead.

**Reproduced:**

```
video clip 0–30s, playhead at 20s, select and delete it
  duration: 0   playhead: 20
```

The playhead marker is then drawn at `timeToX(20)` = 1600px inside a track whose
width is `max(viewport, 600, duration + 200)` = 600px — so it is off the end of
the content, clipped by `overflow-x-hidden`, and unreachable by dragging. It also
makes `state.duration()` and `state.playhead()` disagree, which the export
dialog and `step()` both read.

**Fix:** clamp the playhead in the same place that prunes the selection —
`setProject` in `state.ts:134` already runs after every write for exactly this
class of hazard.

## (playhead-adjacent) Seek during playback can leave an orphaned audio source

**Where:** `src/audio/audio-engine.ts:137` and `:206-250`

`play()` calls `stop()` **synchronously**, but `#schedule` is async — it awaits
`#bufferFor`. Sequence:

1. `seek()` while playing → `restartAt()` → `play()` → `stop()` (no-op) → schedules
2. `#schedule` awaits the decode
3. another `seek()` → `play()` → `stop()` — but `#active` is still empty, so
   nothing is stopped
4. run 1's `#schedule` resumes, creates a source, pushes it to `#active`, and
   starts it at **run 2's** `#runStart`

The result is a source playing at the wrong time that no later `stop()` was in a
position to cancel. Dragging the playhead along the ruler during playback is
enough to hit it. **Not reproduced** — see the last section.

---

# Snapping

## ✅ 12. Drop snapping ignores the clip and lane toggles

**Where:** `src/app/store/assets.ts:278`

```ts
const targets = collectTargets(unwrap(project), {
  playhead: playhead(),
  includePlayhead: true,
  // no `lanes` → defaults to BOTH
})
const hit = nearestTarget(raw, targets, threshold)
```

The drag controller gates its targets through `enabledLanes(lane)`
(`use-timeline-drag.ts:143`), so the `G` / `⇧G` toggles work there. `dropTimeFor`
asks only `snapping()` — "is *either* on" — and then always collects both lanes.

**Reproduced:**

```
clipSnap = false   laneSnap = true   snapping() = true
dropTimeFor(9.95) = 10          ← snapped to a SAME-lane clip edge
both off → 9.95                  ← correct
```

So with clip snap visibly switched off in the toolbar, a dropped file still
snaps to same-lane clip edges. The toggle is a lie for drops.

## ✅ 13. Turning clip snap off also kills butt-forward snapping

**Where:** `src/app/view/timeline/use-timeline-drag.ts:143` and `:219`

`endSnapTargets` is the one useful downstream target — the next clip's start, so
a clip can butt forward against it. It is built by filtering:

```ts
const butt = next ? all.filter((t) => t.lane === lane && t.kind === 'clip-start' && t.clipId === next.id) : []
```

But `all` comes from `targets(lane)` → `enabledLanes(lane)`, which with clip snap
off and lane snap on returns `['audio']`. The filter requires `t.lane === lane`.
**The filter can never match**, so `endSnapTargets` is permanently `[]`.

```
clipSnap off, laneSnap on → enabledLanes('video') = ['audio']
→ butt filter finds nothing → endSnapTargets is always []
```

This one is defensible — the butt target *is* a same-lane edge, so respecting the
same-lane toggle is arguably correct. It is listed because the code reads as
"butt snapping exists" and silently does not.

## 15. The ruler prints invalid timecode

**Where:** `src/app/view/timeline/ticks.ts:35`

```ts
const m = Math.floor(t / 60)
const s = Math.round(t % 60)          // ← can be 60
return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
```

`Math.round` can push the seconds to 60 without carrying into the minutes.

**Reproduced:**

```
formatTick(59.5)  = "60s"
formatTick(119.5) = "1:60"      ← not a timecode
formatTick(179.5) = "2:60"
```

**Reachable, not theoretical.** `tickInterval(400) === 0.5`, so zooming to 400
px/s on a timeline longer than two minutes puts 0.5s ticks under the minute
labels:

```
ticks(130s, zoom 400): 261 ticks, invalid labels: ["1:60"]
```

**Fix:** derive the seconds from the rounded total, or carry the remainder.

---

## ✅ 15. The ruler prints invalid timecode

**Cause** — `ticks.ts:37`:

```ts
const m = Math.floor(t / 60)
const s = Math.round(t % 60)     // ← can be 60, and never carries
```

`Math.round(59.5)` is 60, so `t = 119.5` gave `m = 1, s = 60` and the ruler printed
`1:60`, which is not a timecode.

**Reachable, not theoretical.** `tickInterval(400)` is `0.5`, so zooming to 400 px/s
on a timeline over two minutes puts half-second ticks under the minute labels:
`ticks(130, 400)` contains exactly one `1:60`.

**Fix** — round the *total*, then derive both parts, so they cannot disagree:

```ts
const total = Math.round(t)
const m = Math.floor(total / 60)
const s = total % 60
```

**Known and left: adjacent duplicate labels.** At a 0.5s grid labelled in whole
seconds, `58.5` and `59.0` both read `59s`. That is inherent to showing
second-resolution on a finer grid, it predates this fix, and fixing it means
`tickInterval` has to know the duration. Recorded rather than quietly left.

**Pinned by** `test/timeline.test.ts`: *no tick label is ever an invalid timecode*
sweeps five zooms against five durations and asserts the seconds are always under
60, and *the seconds and the minutes always agree* re-reads the label back and
checks it round-trips to the tick it came from.

## ✅ 18. Arrow keys always step 1/30 s

**Cause** — `transport.ts:30`:

```ts
const OUTPUT_FPS = 30   // "Fixed, because the export muxer wants a constant rate"
function step(frames) { seek(playhead() + frames / outputFps()) }
```

The comment is true and irrelevant here. The muxer wants a constant rate;
stepping a playhead does not.

**Fix** — `frameRateFor(asset)`, exported and pure, and `step` asks for the **source's**
rate: the frames under the playhead are the frames being stepped through. **A VFR
asset falls back to the output rate**, because its average is meaningless —
3.75 fps for a screen recording — which `settingsFor` already declines to export
at. So does an empty timeline.

`step` falls back through clip-under-playhead → selected clip → output rate, so
stepping through something not yet reached still works.

**Pinned by** `test/state.test.ts`: *the frame rate playback steps by is the
source's* covers the four cases including the VFR and nonsense ones, and *the arrow
keys step whole source frames* drives the real store on a 24 fps asset and checks
that one step is `1/24` and ten steps are `10/24` — i.e. the error does not compound.

## ✅ 19. An insert drop near an edge lands at the end of the clip it landed on

**Cause** — `insertClipAt` inserted *after* the covering clip whenever `splitOne`
refused, which it does within `MIN_CLIP` of either end:

```
dropped at 0.01s inside a clip starting at 0:
  v[0] x   0-10  @0.00
  v[1] new 0-4   @10.00     ← the pointer was at 0.01s
```

**The fix needed two rules, not one**, and finding that out was most of the work.
A first attempt nudged *every* near-edge drop forward to the nearest legal cut.
That broke an existing test, correctly: a drop at **exactly** a clip's start is not
a hair inside it, it is *on the boundary*, and cutting there would split off a
40 ms fragment of somebody's footage.

So:

- **within `MIN_CLIP` of the clip's start → in front of it, flush.** The user aimed
  before it. No cut, no fragment.
- **mid-clip → nudge to the nearest legal cut.** 40 ms of movement, invisible, and
  the edit that was meant.
- **a clip shorter than `2 × MIN_CLIP`** has no legal interior at all, so it takes
  the first rule rather than the far end of the clip.

**Measured across the whole range**, dropping at 5 ms resolution into a 10s clip:
the shortest fragment produced is `0.040000000000s` — `MIN_CLIP`, short by
`8.5e-16 s`, which is float representation noise at one part in 10^16.

**Pinned by** `test/model.test.ts`: *an insert drop lands where it was aimed, not at
the far end of the clip* (five positions including both near-edge cases), *no drop
can leave a clip shorter than `MIN_CLIP`* (the 2001-point sweep), and *a drop at a
clip boundary does not split it*.

# Performance

## ✅ 16. Position math is O(n²) everywhere

**Cause** — `clipStart` sums the lane from zero, which is free once and quadratic
inside a loop, and the loops were everywhere:

| caller | called from | was |
|---|---|---|
| `clipAtLane` | `Preview.draw()`, **per frame** | per index |
| `collectTargets` | every trim `pointermove` | per index |
| `state.clipRect` | `Clip`, **per clip, per repaint** | per clip |
| `survivorsInRange`, `indexCovering`, `firstIndexAtOrAfter` | every drop | per index |
| `duplicateClips` | every ⌘D, twice over | per index |
| `export-audio`'s mix build | every export | per clip |

**The invariant is untouched.** Position is still derived from array order and
still stored nowhere — this is the same arithmetic with the running total hoisted
out of the inner loop. `shiftLane` already did it this way and its comment said
why; the rest of the file had not caught up.

**Fix** — one exported bulk answer, `clipStarts(clips)`, used by every caller that
wants more than one position. `clipAtLane` became a single accumulating pass.
`Clip` now takes its `start` as a prop from a per-lane `createMemo`, and
`clipRect` is gone rather than left as an O(n) footgun in the render path.

**Measured, before → after:**

```
clipAtLane, 1600 clips      1.201 ms  →  0.013 ms     (~90x)
per second of playback      72    ms  →  0.1  ms
one repaint, 800 clips      0.45  ms  →  0.01 ms     (~44x)
```

**A regression I introduced, caught by the test I wrote for it.** The rewrite
first dropped the `t >= start` bound from `clipAtLane`, which made a position
inside a **gap** return the clip *after* it — so silence decoded whatever
followed. That is bug #4 wearing a different hat, and no timing test would have
seen it. The equivalence sweep did.

**Also removed:** an early exit I added for a playhead *before* the lane. `seek`
clamps that away before it can happen, so it was a branch and a comment for an
unreachable case. A test claimed it helped; the test was wrong, and the honest
version of it now documents why the walk to the end of a lane is necessary.

**Pinned by** (`test/positions.test.ts`, 10 tests) — deliberately **not** by
timing. A stopwatch is flaky on shared CI and stops catching the bug on a fast
machine, so the shape is asserted instead: a counting proxy measures how many
times clips are *touched*, and doubling the lane must not much more than double
it. Against the quadratic code: `1683 → 6435 touches. That is quadratic.` The
correctness half asserts **exact** equality with `clipStart`, and compares
`clipAtLane` against the definition it replaced at every 17 ms of a lane built
from the shapes that break hand-rolled accumulators — offsets, a leading gap, and
a zero-length clip.

## ✅ 17. The peaks effect re-enters `computePeaks` on every audio-lane write

**Two faults compounding, neither visible in a screenshot.**

**The trigger** — `Timeline.tsx:71` iterated the audio *lane*:

```ts
createEffect(() => {
  for (const clip of state.project.audio) void state.peaksFor(clip.assetId)
})
```

A drag rewrites the lane, so this re-ran on every `pointermove`.

**The amplifier** — `peaksFor` short-circuited only on `peaksBy[assetId]`, which
is set when a pass *finishes*. So every caller arriving during a decode started
its own, and `computePeaks` walks the **entire decoded buffer**. Measured: 60
entries during a one-second drag.

**Fix, both halves:**

- Keyed on `state.assetIds()` instead of the lane. **Peaks belong to a file, not
  to a clip** — a clip's trim says nothing about its waveform, so the work has to
  hang off something a trim cannot move. `assetIds()` is backed by the asset
  revision counter, which is exactly that granularity.
- `peaksPending`, a map of in-flight promises, so concurrent callers *join* the
  run already in flight. Same shape as `AudioEngine.#bufferFor`, for the same
  reason: the promise is the cache, because the work is already happening. Cleared
  in a `finally`, so a failed pass cannot wedge the waveform off permanently.

**Pinned by** (`test/peaks-once.test.ts`, 4 tests) — drives the real
`createAssets` with fakes, which is the only place the two halves meet. *Concurrent
callers share one pass over the buffer* asserts all three callers receive the
**same array**, which is only possible if they shared the work — and it fails if
the map is removed. Plus a failed decode is not cached forever.

And in `test/dom.test.ts`, because the *trigger* half is a property of an effect's
dependency and nothing else can see it: the effect must name `assetIds()` and must
**not** mention `project.audio`, and the in-flight map must be read, awaited and
cleared.

# Found by inspection, not reproduced

## `AudioEngine.play()` re-entrancy can orphan an audio source

Described at the end of the playhead section above: `stop()` is synchronous,
`#schedule` is not, so a scrub during playback can leave a source that no later
`stop()` reaches (`audio-engine.ts:137`, `:206-250`).

I could not execute this one — it needs a real `AudioBufferSink` over a real
track, and the stub library returns no entry, so every schedule bails out at
`audio-engine.ts:203` before the race window opens. It is a code-reading
conclusion and should be treated as unproven.

**How to prove it:** a `MediaLibrary` test double whose `get()` returns a real
`audioTrack`, plus an `AudioBufferSink` stub whose `buffers()` resolves on a
deferred promise — start playback, seek twice before the deferred resolves, then
assert `audio.describe().active`.

---

# What is left, and in what order

Not ordered by severity. Ordered by **how much confidence the fix carries**,
because a wrong fix to a load-bearing path is worse than a bug that stays for a
week — and by how much of the remaining work shares one root cause.

**All twenty are done.** The list below is kept as the record of the order they
were closed in.

| Step | Bugs | Why here |
|---|---|---|
| ~~1~~ | ~~3, 9~~ | ✅ Done. |
| ~~2~~ | ~~1, 10~~ | ✅ Done. |
| ~~3~~ | ~~**2, 14**~~ | ✅ **Done.** The last two pieces of "dragging feels wrong", both in the swap branch. The decision moved into a pure `moveIntent`, which is what made either of them testable at all. |
| ~~4~~ | ~~**6, 7, 8**~~ | ✅ **Done.** One root cause: *a linked pair stops being a pair*. Fixed in the model — right halves get their own link group, `linkedPartner` requires the other lane, and trim stops copying split's dedupe. See [Fixed](#-the-last-four-a-linked-pair-must-stay-a-pair). |
| ~~5~~ | ~~**5**~~ | ✅ **Done.** The docstring already promised the decision: clamp the desired delta once, to the most-constrained lane, and apply it to both. See [Fixed](#-the-last-four-a-linked-pair-must-stay-a-pair). |
| ~~6~~ | ~~**4**~~ | ✅ **Done.** The three lines were easy; the work was that "black is a decision" was being made inline in three places that disagreed, so it had to be extracted to be testable at all. |
| ~~7~~ | ~~**16, 17**~~ | ✅ **Done.** Both linear now. The rewrite briefly *introduced* a gap-decodes-the-next-clip bug, which is why the equivalence sweep mattered more than the timings. |
| ~~8~~ | ~~**11, 12, 13**~~ | ✅ **Done.** 11 was one `state.seek`; 12 needed the lane policy shared with the drag; 13 turned out to be dead code and is now deleted rather than documented. |
| ~~9~~ | ~~**15, 18, 19**~~ | ✅ **Done.** A carry, a frame rate, and a drop that needed *two* rules rather than one — see below. |
| — | *inspection* | The `AudioEngine.play()` re-entrancy race. Leave it until there is a `MediaLibrary` test double, or it stays unproven. |

### The two decisions, as settled

1. **What is a link after a split?** A `linkId` now identifies **one pair: one
   video clip and one audio clip**. The left halves keep the original id; the
   right halves get one fresh id between them. This was chosen over storing a pair
   of clip ids because it needs no new field and no migration — a project written
   by the old build still loads, and `linkedPartner` ignores any same-lane
   leftovers. The consequences the old note worried about do not arise: the right
   halves *do* edit together (with each other), which is the correct reading of
   "one split makes two pairs."
2. **What should a rigid group drag do at a lane wall?** Clamp once, on the
   **most-constrained lane**, and apply that delta to both. The block stays
   rigid; it may stop short of the pointer. That is the first option, and it is
   what the `moveSelectionTo` docstring already promised.

## What would have caught these

The repo already has the answer in `docs/README.md` under *conventions*:

> Behaviour that cannot be seen is tested at the source level.

- **A gesture harness.** Every bug in `use-timeline-drag.ts` needs a
  `PointerEvent`, a `getBoundingClientRect` and a store. jsdom can fake the
  first and third; the second is one `getBoundingClientRect` stub. There are
  five component suites today and none of them touch the timeline.
- **Model/store agreement tests.** Bugs 6, 7 and 8 are all one invariant —
  *a linked pair stays a pair* — asserted in three places. One test asserting it
  after a split would have caught all three.
- **Cross-file agreement tests.** Bug 4 is the preview disagreeing with the
  exporter. Both call `renderFrame`; neither test asserts they call it with the
  same answers. `render.ts` already exports the blank path as a shared function —
  it just is not shared.

## Related

- [docs/risks.md](docs/risks.md) — R1 (A/V sync) and R6 ("the moment the render
  pass grows a second code path, ADR-1 is dead"). Bug 4 is a live instance of
  exactly that.
- [docs/decisions/0001-one-render-function.md](docs/decisions/0001-one-render-function.md)
- [docs/data-model.md](docs/data-model.md) — the position-is-derived rule whose
  O(n²) cost bug 16 is about.