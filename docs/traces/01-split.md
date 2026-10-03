# Trace 01 — pressing `S` to split

One keypress, nine files, and a complete tour of how an edit actually reaches
the model. This is the single most useful path in the codebase to know, because
it touches every layer without any of them being about video.

## The whole path at a glance

```
keydown
  └─ app/commands/keyboard.ts        match the key
      └─ app/commands/shortcuts.ts   the `s` descriptor
          └─ app/store/edits.ts      splitAt / splitSelectionAtPlayhead
              ├─ app/store/history.ts    commit() — snapshot before the change
              └─ model/project.ts        splitLinked() — the pure edit
                  └─ app/store/state.ts  setProject() — the only write path
                      ├─ model/project-store.ts   applyLanes() — plain set
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

`src/app/commands/shortcuts.ts:32` is the `s` descriptor:

```ts
{
  keys: ['s'],
  hint: 'S',
  label: 'split',
  enabled: hasClips,
  // Several clips selected means split all of them; one (or none) keeps the
  // older behaviour of splitting whatever is under the playhead.
  run: () =>
    state.selectionCount() > 1
      ? state.splitSelectionAtPlayhead()
      : state.splitAt(state.playhead()),
},
```

Note what this is *not*: it is not a key handler. It is a descriptor holding a
closure, and the branch is a plain ternary. Both behaviours are reachable, and
the decision is made from state at the moment the key is pressed.

The nearest interesting neighbour is `m` (`:72`), which mutes the selection
when there is one and the master otherwise — with a comment explaining that
otherwise there would be no way to mute the whole project mid-edit.

## 3. The store commits *before* changing anything

`src/app/store/edits.ts:96`:

```ts
function splitAt(time: number, lane?: Lane): void {
  history.commit()
  ...
```

`commit()` first, before the edit. This is the whole undo strategy: undo is a
stack of *values*, not a stack of inverse operations. `src/app/store/history.ts:5`
is explicit that there is no undo engine here and there should not be one —
because the alternative is writing an inverse for every edit, and an inverse that
disagrees with its forward operation is a worse bug than no undo at all.

So the order is always the same: snapshot, edit, write.

## 4. The edit itself, in the pure model

`splitAt` resolves *which* clip to split, then delegates:

- an explicit `lane` argument, if given
- otherwise the primary selection
- otherwise every lane independently at the playhead

All three paths converge on `splitLinked` in `src/model/project.ts:446`:

```ts
export function splitLinked(project: Project, lane: Lane, index: number, timelineT: number): Project {
  const clips = laneOf(project, lane)
  const clip = clips[index]
  if (!clip) return project

  const local = timelineT - clipStart(clips, index)
  if (local < MIN_CLIP || local > clipDuration(clip) - MIN_CLIP) return project

  const left: Clip = { ...clip, out: clip.in + local }
  // The right half starts where the left ends, so it carries no offset — its
  // position comes from being next in the array.
  const right: Clip = { ...clip, id: newId('clp'), in: clip.in + local, offset: 0 }
  ...
```

Three things in 15 lines that are worth the whole file:

1. **`local` is measured against this lane's own start.** A linked video/audio
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

`MIN_CLIP` (`:436`) is 0.04s, and the comment is the reason: "Below this, a clip
divides by zero somewhere."

## 5. The batch path is not a loop

`splitSelectionAtPlayhead` (`src/app/store/edits.ts:138`) is the multi-select
case, and its docblock names the two things that make it more than a loop:

- **A linked pair is split by `splitLinked`, which cuts both halves.** So a
  selected pair must be counted once, or the second call targets a clip that no
  longer exists at that index.
- **A clip whose edge is already at the playhead is skipped**, because splitting
  there produces a zero-length clip — a corrupt clip, not an edit.

Which is also why it iterates **back-to-front per lane**: each split inserts a
clip and shifts every later index down. Iterate forwards and the second
iteration targets the wrong clip. This is the classic insertion-into-an-array
bug, and it is invisible until the indices happen to coincide.

`MIN_SPLIT` (`:49`) is 0.01 here, a different constant from `MIN_CLIP` in the
model. The store is *more* conservative than the model, because the model has to
accept a hand-edited call while the store has to answer a keystroke.

## 6. One write path, and a prune

Back in `src/app/store/state.ts:147`, every edit goes through `setProject`, which
is deliberately overloaded to distinguish the three kinds of write:

```ts
function setProject(a: unknown, b?: unknown, c?: unknown): void {
  // Asset writes cannot orphan a clip selection, or move a clip, so they skip
  // both — there is nothing for either to do.
  if (a === 'assets') applyProject(a as 'assets', b as string, c as Asset)
  else if (typeof a === 'string') applyProject(a as Lane, b as Clip[])
  // A plain two-key set, never `reconcile` — see model/project-store.ts for
  // the media library that reconcile deleted.
  else applyLanes((lanes) => applyProject(lanes), a as Lanes, sel.prune)
}
```

`sel.prune` runs *after* the write, because it reads the project and must see the
new one. The reason it exists at all is at `:75`: a selection outliving the clip
it names is a live hazard, because every batch action resolves its targets
through the selection. One deleted clip staying selected would silently swallow
the next `Delete`. Pruning centrally means no call site can forget.

## 7. The write that must stay a plain set

`src/model/project-store.ts:40` is four lines of code and twenty lines of
warning:

```ts
export function applyLanes(
  setter: (value: Lanes) => void,
  lanes: Lanes,
  onWritten: () => void,
): void {
  setter({ video: lanes.video, audio: lanes.audio })
  // Run after the write: pruning reads the project, so it must see the new one.
  onWritten()
}
```

Solid's `reconcile` sets every key the target does not mention to `undefined`.
Since `replace()` returns only `{ video, audio }`, every edit deleted
`project.assets` and `project.version` — the media library was not deleted, only
the reference to it, and the next `project.assets[id]` threw.

It is worth reading this file just to see what a performance micro-optimisation
cost. It is the strongest argument in the repository against optimising Solid
store writes without reading what the setter does.

## 8. Nobody re-renders by hand

There is no call to a render function, and nothing invalidates a cache. The
timeline re-renders because `src/app/store/edits.ts:96` produced a *new array* and the store
setter signalled. Solid tracks that, and `src/app/view/timeline/Lane.tsx` re-runs
its `For` over the changed array.

This is the payoff of the derived-position model. Because a split is expressed
as a new array rather than a mutation, the framework knows what changed. An
imperative editor that moved a clip by writing `clip.start = 12` would have had
to tell the framework, and would eventually get it wrong.

## What to do next

Press `S` with nothing selected and with two clips selected, and watch the
difference. Then read `test/model.test.ts` — the split cases there are the
clearest statement of intent in the repository, and several of them exist purely
to pin a bug that was found the hard way.
