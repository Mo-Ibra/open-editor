# Trace 01 — pressing `S` to split

One keypress, nine files, and a complete tour of how an edit actually reaches
the model. This is the single most useful path in the codebase to know, because
it touches every layer without any of them being about video.

## The whole path at a glance

```
keydown
  └─ app/commands/keyboard.ts        match the key
      └─ app/commands/shortcuts.ts   the `s` descriptor (:67)
          └─ app/store/edits.ts      splitAt (:131)
              ├─ splitCore (:87)         pick the track(s) to cut
              │   └─ model/project.ts    splitClip / splitLinked — the pure edit
              ├─ app/store/history.ts    commit() — snapshot before the change
              └─ model/project-store.ts  applyTracks() — plain set (:40)
                  ├─ app/store/state.ts  setProject() — the only write path (:91)
                  └─ app/store/selection.ts   prune() — drop dead ids
  └─ Solid re-renders the timeline
```

## 1. The key is matched

`src/app/commands/keyboard.ts` listens on `window` and matches a pressed key
against the descriptor list. It handles the boring parts: input fields swallow
the event, the platform accel is detected, and `preventDefault` is called only
when something actually matched.

The important structural point: **there is no key handling anywhere else.** If a
shortcut exists, it exists in exactly one place, which is also what draws the
legend in the footer and populates the context menu. One source, three
consumers. `test/keyboard.test.ts` exists mostly to keep it that way.

## 2. The shortcut decides which behaviour

`src/app/commands/shortcuts.ts:69` is the `s` descriptor:

```ts
{
  keys: ['s'],
  hint: 'S',
  label: 'split',
  enabled: hasClips,
  // The selection names the tracks to cut: video only, audio only, or both
  // (also both when nothing is selected). The playhead is the cut point.
  run: () => state.splitAt(state.playhead()),
},
```

Note what this is *not*: it is not a key handler. It is a descriptor holding a
closure. The choice of *what* to cut is no longer made here — it reads the
selection, which is store state, so the branch lives in the store (see `splitCore`
below). The descriptor only says "split at the playhead".

The nearest interesting neighbour is `m` (`:119`), which mutes the selection when
there is one and the master otherwise — with a comment explaining that otherwise
there would be no way to mute the whole project mid-edit.

## 3. The store commits *before* changing anything

`src/app/store/edits.ts:131`:

```ts
function splitAt(time: number, trackId?: TrackId): void {
  const { next, split } = splitCore(time, trackId)
  if (split === 0) {
    notify('info', 'Nothing to split — put the playhead inside a clip.')
    return
  }
  history.commit()
  setProject(replace(next))
}
```

The model work (`splitCore`) runs first, but it is **pure** — it returns a new
`Project` and touches nothing. `history.commit()` runs only once something will
actually change, so a cut that the model refuses leaves no undo step behind. The
order that matters is still: compute, snapshot, write. `src/app/store/history.ts:5`
is explicit that there is no undo engine here and there should not be one —
because the alternative is writing an inverse for every edit, and an inverse that
disagrees with its forward operation is a worse bug than no undo at all.

## 4. The edit itself, in the pure model

`splitCore` (`src/app/store/edits.ts:87`) resolves *which* track(s) to cut, then
delegates:

- an explicit `trackId`, when a drag named its track;
- otherwise the primary selection, when it lands on **exactly one** track;
- otherwise **every** track — which is also the nothing-selected case.

The single-track case is `splitClip` (`src/model/project.ts:1181`): cut one side
of a linked pair, leave the partner whole — "cut the picture and keep the sound".
The pair case is `splitLinked` (`src/model/project.ts:1211`):

```ts
export function splitLinked(project: Project, trackId: TrackId, index: number, timelineT: number): Project {
  let next = project
  const track = project.tracks.find((t) => t.id === trackId)
  if (!track) return project
  const clips = track.clips
  const clip = clips[index]
  if (!clip) return project

  const local = timelineT - clipStart(clips, index)
  if (local < MIN_CLIP || local > clipDuration(clip) - MIN_CLIP) return project

  const left: Clip = { ...clip, out: clip.in + local }
  // The right half starts where the left ends, so it carries no offset — its
  // position comes from being next in the array.
  const right: Clip = { ...clip, id: newId('clp'), in: clip.in + local, offset: 0, linkId: rightLink }
  ...
```

Three things in 15 lines that are worth the whole file:

1. **`local` is measured against this track's own start.** A linked video/audio
   pair can legitimately be out of alignment — you may have slid the audio — so
   splitting the audio at the video's *source* time would land in the wrong
   place. Each half is split against its own in-point.
2. **The right half has `offset: 0`.** This is the derived-position model in
   action: a clip's timeline position is the sum of the durations before it, so
   inserting a clip next to its left half is what places it. There is no
   "position" field to keep in sync because there is no position field.
3. **The partner is split too, with the same `MIN_CLIP` guard.** A split that is
   valid for video but yields a 10 ms audio clip is not a split anyone wanted,
   so the partner is allowed to decline independently.

`MIN_CLIP` (`src/model/project.ts:1093`) is 0.04s, and the comment is the reason:
"Below this, a clip divides by zero somewhere."

## 5. The pair path, and why it does not cut twice

`splitCore`'s pair branch walks **every** track in a plain forward loop, calling
`splitLinked` on each. That looks like it should cut the partner twice — once when
the loop reaches the video track, once when it reaches the audio track — and it
does not, for a reason worth seeing:

- When the loop reaches a track, `clipAtTrack(clips, time)` returns the clip whose
  derived start is at or before the playhead. A cut leaves a **right half** that
  starts exactly at the playhead, so the next visit resolves to that right half.
- `splitLinked` then measures `local = time - clipStart(...)` — which is `0`, well
  under `MIN_CLIP` — and returns the project unchanged.

So the `MIN_CLIP` floor that guards against slivers is also what makes the visit
idempotent at the seam. The loop needs no back-to-front iteration and no
seen-set: a second visit is a legal but refused cut, and a refused cut does not
increment the counter that decides whether history is committed.

The single-track path (`splitClip`) is used whenever the cut is aimed at one
track, which is the gesture "cut the picture and keep the sound".

## 6. One write path, and a prune

Back in `src/app/store/state.ts:91`, every edit goes through `setProject`, which
is deliberately overloaded to distinguish three kinds of write:

```ts
function setProject(a: unknown, b?: unknown, c?: unknown): void {
  if (a === 'assets') applyProject(a as 'assets', b as string, c as Asset)
  else if (typeof a === 'string') {
    const trackId = a as TrackId
    applyProject('tracks', (prev: Project['tracks']) =>
      prev.map((t) => (t.id === trackId ? { ...t, clips: b as Clip[] } : t)),
    )
  } else applyTracks((tracks) => applyProject('tracks', tracks), a as Tracks, sel.prune)
  projects.markDirty()
  transport.clampPlayhead()
}
```

`sel.prune` runs *after* the write, because it reads the project and must see the
new one. The reason it exists at all is at `:75`: a selection outliving the clip
it names is a live hazard, because every batch action resolves its targets
through the selection. One deleted clip staying selected would silently swallow
the next `Delete`. Pruning centrally means no call site can forget.

The same function is also the one place the project is marked dirty and the
playhead is clamped back inside it, so those never have to be remembered
separately either.

## 7. The write that must stay a plain set

`src/model/project-store.ts:40` is four lines of code and twenty lines of
warning:

```ts
export function applyTracks(
  setter: (value: Tracks) => void,
  tracks: Tracks,
  onWritten: () => void,
): void {
  setter(tracks)
  // Run after the write: pruning reads the project, so it must see the new one.
  onWritten()
}
```

Solid's `reconcile` sets every key the target does not mention to `undefined`.
Since an edit returns only the `tracks`, every edit deleted `project.assets` and
`project.version` — the media library was not deleted, only the reference to it,
and the next `project.assets[id]` threw.

It is worth reading this file just to see what a performance micro-optimisation
cost. It is the strongest argument in the repository against optimising Solid
store writes without reading what the setter does.

## 8. Nobody re-renders by hand

There is no call to a render function, and nothing invalidates a cache. The
timeline re-renders because `src/app/store/edits.ts:131` produced a *new array* and
the store setter signalled. Solid tracks that, and
`src/app/view/timeline/Lane.tsx` re-runs its `For` over the changed array.

This is the payoff of the derived-position model. Because a split is expressed
as a new array rather than a mutation, the framework knows what changed. An
imperative editor that moved a clip by writing `clip.start = 12` would have had
to tell the framework, and would eventually get it wrong.

## What to do next

Press `S` with nothing selected and with two clips selected, and watch the
difference. Then read `test/model.test.ts` — the split cases there are the
clearest statement of intent in the repository, and several of them exist purely
to pin a bug that was found the hard way.
