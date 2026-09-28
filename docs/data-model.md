# The editing model

This is the whole product. It is small, and that is the point.

```ts
type Project = {
  version: 2
  assets: Record<AssetId, Asset>
  video: Clip[]                  // array order IS timeline order
  audio: Clip[]                  // a second, independent lane
  captions?: CaptionTrack
}

type Clip = {
  id: ClipId
  lane: Lane                     // 'video' | 'audio' — a clip is in exactly one
  assetId: AssetId
  in: number                     // source in-point, seconds
  out: number                    // source out-point, seconds
  linkId?: LinkId                // shared by a video/audio pair
  offset?: number                // deliberate silence BEFORE this clip
  transform?: ClipTransform
  gain?: number
  muted?: boolean
}
```

## Three rules that keep this honest

### 1. Position is derived, never stored

A clip has **no `start` field**. Its timeline position is the sum of what
precedes it:

```ts
clipStart(clips, i) = Σ(offset[j] + duration[j]) for j < i, + offset[i]
duration(clip) = max(0, out - in)
```

A stored position and an array index can disagree — an import bug, a bad
reorder, a concurrent write, and the timeline lies. A derived one cannot
disagree, because there is nothing to disagree with. This deletes an entire bug
class rather than fixing instances of it.

The cost is O(n) per lookup. For a cutter's timeline length that is free, and
memoising it would be trading a bug class for a performance problem that does not
exist.

### 2. Durations are derived, never stored

`duration = out - in`. Nothing caches it. Two functions, used everywhere, so
there is no second definition to drift.

### 3. Only integers at the boundaries

`in` and `out` are floats in seconds, because that is what a human drags. They
are converted **once** to integer frames and integer audio samples at export
time, and the export loop never does float math. Accumulating `t += 1/30` drifts;
`1/30` is not representable, and over 900 frames it is a whole frame of error.
Boundaries are rounded to whole frames once, then divided. See
[export.md](export.md#integers-at-the-boundaries).

## Two lanes, linked by default

```
┌─ video ────────────────────────  trim, zoom
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
├─ audio ────────────────────────  waveform, level, mute
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
```

A file with picture and sound becomes a **linked pair**: two clips sharing one
`linkId`. Splitting cuts both. Deleting one leaves the other.

That independence is the entire point. Trimming the picture while keeping the
sound is a normal thing to want, and it is inexpressible if a clip carries its
audio implicitly. `Break link` severs both directions; thereafter they are
independent, permanently.

**Link rules, each pinned by a test:**

- A file with both → a linked pair. Audio-only → one unlinked audio clip.
  Silent → one unlinked video clip.
- Splitting a linked clip splits the partner **against its own timeline**, not
  the partner's source time. A pair can legitimately be out of alignment if you
  slid the audio, and splitting at the video's source time would land in the
  wrong place.
- A partner too short to split is **left alone**, rather than halved into a 10 ms
  clip.
- Breaking the link severs both directions.

## Gaps: `offset`

An offset is silence **before** a clip. It is an *edit* — a gap someone
deliberately left — not a position. That distinction is the whole safety argument
of rule 1, and a gap does not weaken it:

- A clip may move anywhere **right** of its predecessor, and the gap is stored.
- It may **never overlap** its predecessor. Moving left past a neighbour is a
  reorder, not an overlap.
- A reorder lands the clip **flush**. An old offset does not follow it to a new
  slot, because a gap is placed deliberately and a reorder is a rearrangement.
- A gap is real timeline. The video holds **black** and the audio holds
  **silence**. Summing only clip durations would report a timeline shorter than
  the one on screen, and the export would come out short to match.

### Three places that silently ignore offsets

Each of these was a real bug, and each is now covered by a test:

1. `clipStart` must include the clip's **own** offset. A gap sits *before* a
   clip, so the term belongs to it; without it `placeClip` sets an offset that
   does nothing.
2. `laneDuration` must include offsets, or the timeline under-reports its own
   length.
3. `clipAtLane` must use the derived `clipStart` rather than accumulating
   durations, or a position inside a gap resolves to the previous clip and the
   preview shows a frame where the timeline is empty.

## Project length

```ts
projectDuration = max(laneDuration(video), laneDuration(audio))
```

The **video** lane does not define output length. Audio that outlasts the picture
is not something to pad the video with black for; the excess is simply not heard.

## Snapping: trimming only

[`model/snapping.ts`](../src/model/snapping.ts). Toggle in the timeline toolbar or `G`.

**Snapping is a property of cutting, not of moving.** A trim handle is placed by
eye, so a small magnetic zone around each cut lets you return to a previous cut
without pixel-hunting. Moving a whole clip must follow the pointer exactly: a
clip that leaps sideways as it passes a boundary is not magnetic, it is broken,
and it makes fine positioning impossible.

The separation is structural, not a convention:

- `model/snapping.ts` exports **exactly one** snapping function, `snapTrimEdge`.
  `snapClipMove` was **deleted** — the move path must not snap, so the helper has
  no caller, and keeping it would be an invitation to re-wire it.
- The `Drag` type carries `locked` on the **trim variants only**, so a move is
  not physically capable of latching onto a target, and the compiler rejects one
  that tries.
- The move arm references no snapping symbol, builds no target list, and never
  sets a guide line.
- The **playhead is not a target**. Dragging it to check what is at 1:14 should
  give 1:14, not 1:14 snapped to a boundary. `collectTargets` still supports
  including it; the timeline opts out, and a test pins that refusal.

Three things do the work:

1. **The threshold is in pixels, not seconds.** A 10-pixel pull is 0.5 s at
   20 px/s and 25 ms at 400 px/s. Converting at the current zoom is what makes
   the magnet feel identical at every zoom level.
2. **A snap is sticky.** Once latched, the drag keeps that target until the
   pointer drifts 1.6× the threshold away. Re-deciding every frame makes a clip
   flicker as the hand jitters, which reads as broken.
3. **A clip never snaps to itself**, but the timeline origin is still a target for
   every clip.

A snap shows an amber guide line labelled with what it caught. **A snap you
cannot see is a snap you cannot trust.**

The pixel threshold is why zoom has to be anchored properly: the magnet is
measured in pixels, so it must convert at the zoom the user is actually looking
at, or it weakens as they zoom in and feels broken.

## Zoom

`app/zoom.ts`. `Ctrl`+wheel over the timeline, about the pointer. A trackpad
pinch arrives as a ctrl+wheel event, so that works with no special case; a
plain wheel still scrolls.

- **Ratio, not pixels.** One notch is 1.15× at every zoom level. A fixed pixel
  step feels progressively more sluggish as you zoom in, and the user cannot
  tell whether the wheel broke or the app did.
- **Anchored to the pointer.** The instant under the cursor stays under the
  cursor. Zooming about the origin also changes the zoom — and moves whatever
  you were looking at, which reads as the app ignoring you.
- **Bounded to 10–400 px/s**, the same range the preview's slider offers, and
  clamped in the store so the two can never disagree.
- Registered as a **native non-passive** listener, because `preventDefault` is
  the only thing stopping the browser's own page zoom, and a passive listener
  cannot call it.

`test/zoom.test.ts` pins the geometry, including a test that the naive
scale-the-scroll implementation really does drift — otherwise "it zooms" would
be indistinguishable from "it zooms correctly".

Crossing a neighbour is a **swap**, not a magnet: a clip may never overlap its
predecessor, so dragging left far enough reorders — the clip passes through
rather than sticking on the boundary and refusing to go further.

## Every edit is one of five operations

| Action | Operation | Cost |
|---|---|---|
| Trim a clip | change `in` or `out` | zero |
| Split at t | insert a clip, adjust both `in`/`out` | zero |
| Delete | splice the array | zero |
| Reorder | move in the array | zero |
| Zoom / position | set `transform` | zero |

**Nothing re-encodes during editing.** Ever. The source is immutable and every
edit is O(1) on a small array. Editing is instant because it is structural, not
because it was optimised.

## Mute is an audio-lane thing

`toggleMute` **refuses a video clip**. This is enforced in the model rather than
in each caller, because a video clip carrying `muted: true` is a flag that means
nothing and renders anyway: it shows a mute badge on a clip with no sound, and
changes the audio mixer's gain for a clip that was never in it.

## Undo

A snapshot of the two lane arrays. Structured clone, a few KB, push on every
edit, capped at 100. There is no undo engine to build. Do not build one.
