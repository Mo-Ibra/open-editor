# Reading order

How to learn this codebase without reading all 8,000 lines.

## Why order matters

The source has a dependency direction, and it never bends:

```
model/   pure data + pure edits        no dependencies on anything else
   ↑
media/   files, decoders, frame cache   depends on model
   ↑
audio/   preview + export audio         depends on model, media
   ↑
render/  the one draw call              depends on nothing but geometry
   ↑
output/  codecs, exporter, self-check   depends on all of the above
   ↑
app/store/     the store: slices        wires model + media + audio together
app/commands/  shortcuts, menus         reads the store, calls slices
app/view/      Solid components         reads the store, renders
```

Nothing points back down. That is the single most useful thing about the layout:
once you have read a tier, everything below it is reachable by grep, and nothing
above it can surprise you with a hidden dependency.

So read **downward**. Starting at `Preview.tsx` — the natural choice, since it is
the first thing you see — means tracing backwards through five layers to find out
what a signal means.

## Tier 0 — orient (about 30 minutes)

Read these before any source. They are short and they are the map.

| Document | What it settles |
| --- | --- |
| [data-model.md](data-model.md) | What a `Clip` is, and why position is derived rather than stored. |
| [architecture.md](architecture.md) | The dependency direction above, and the split rules. |
| [decisions/](decisions/) | Eight short ADRs. Each records a choice *and* what it cost. |
| [risks.md](risks.md) | The five things most likely to bite. |

Read the ADRs properly. They are the highest-value 20 pages in the repository,
because they capture reasoning that is otherwise only visible as scar tissue in
the code. `0008` alone explains the entire MP3-in-MP4 situation.

## Tier 1 — the model

`src/model/project.ts` (564) · `project-store.ts` (48) · `snapping.ts` (179)

**This is the whole product.** Everything else is delivery.

`project.ts` is pure: no DOM, no mediabunny, no timers, no Solid. A `Project` in,
a `Project` out. That is what makes it the right place to put the truth, and it
is why `test/model.test.ts` can be fast and exhaustive.

Read in this order, because each depends on the previous:

1. `clipDuration`, `clipStart` — the two functions that define what time *means*.
   Position is derived by summing the clips before it. This is the single idea
   the rest of the model rests on.
2. `splitLinked` (`:446`) — the clearest non-trivial edit. Watch how each half is
   split against *its own* in-point rather than a shared one.
3. `trimLinked` (`:410`) — the same shape, with clamping.
4. The `laneOf` / `clipAtLane` / `findClip` helpers — the lookup vocabulary the
   rest of the codebase uses constantly.

Read `project-store.ts` and be warned. It is 48 lines, and 20 of them are a
post-mortem: an "improvement" to `reconcile` silently deleted the media library
on every edit. Do not add `reconcile`.

## Tier 2 — the store

`src/app/store/state.ts` (264) then the slices.

`state.ts` is the composition root — the only place that knows every slice
exists. Read it once to see the wiring, then use it as a map. Do not read it to
learn behaviour.

The slices are the real reading, in this order:

| File | Lines | Why here |
| --- | --- | --- |
| `edits.ts` | 370 | The bridge: every clip edit, and the first place you see selection, history and the store setter working together. |
| `selection.ts` | 151 | Multi-select policy. Small, and it explains why batch actions are shaped the way they are. |
| `transport.ts` | 196 | The playhead, playback, and the audio-is-the-clock rule. |
| `history.ts` | 78 | Undo. Read this *after* `edits.ts` so you can see what it is snapshotting. |
| `assets.ts` | 225 | File import, and dropping a file onto a lane. |
| `zoom.ts` | 119 | Pure maths, independently testable. Skim. |
| `layout.ts` | 259 | Panel sizes and `localStorage`. The least interesting file in the repo. |

## Tier 3 — media and render

`src/media/library.ts` (117) · `probe.ts` (130) · `frame-cache.ts` (50) · `src/render/render.ts` (99)

`library.ts` is the owner of every `File`, `Input` and sink. Small enough to
read whole, and the clearest explanation of how mediabunny is used.

`render.ts` is 99 lines and is the highest ratio of importance to length in the
repository. It is *the* render pass — preview and export both call it, so there
is nothing that can drift between what you see and what you get. Read it before
`Preview.tsx`, because then the preview's `paint()` is obviously a five-line
wrapper.

`frame-cache.ts` is 50 lines of pure logic and the most instructive small file
here, because its comment explains the "150 decodes and 3 paints" bug.

## Tier 4 — audio

`src/audio/audio.ts` (167) · `export-audio.ts` (158) · `audio-engine.ts` (385)

Three files, three different jobs. Confusing them is the most common
misunderstanding in this codebase, so [traces/03-audio.md](traces/03-audio.md)
exists. Short version: `audio.ts` conforms and mixes, `export-audio.ts` builds
the export's single track, `audio-engine.ts` is *preview only*.

`audio.ts` is the one to read first — `mixTimeline` (`:139`) is 25 lines of
`Float32Array` arithmetic that is entirely deterministic, and understanding why
determinism matters is understanding [ADR-4](decisions/0004-deterministic-audio-mixing.md).

## Tier 5 — the view layer

`src/app/view/App.tsx` (224) · `Timeline.tsx` (138) · `Preview.tsx` (421) ·
`ExportDialog.tsx` (458) · the `timeline/` and `preview/` subdirectories

The view reads the store and renders it. It contains **no** rules — if you find
yourself writing an `if` about clip semantics in a component, it belongs in the
model instead.

Read in this order: `App.tsx` (the shell), then `Timeline.tsx` (small, and a good
tour of how a view composes slices), then the `timeline/` subdirectory.

`Preview.tsx` is the largest file and the one most people want to start with.
**Do not.** Its top 300 lines are one render loop, and half of them are error
reporting. Start with `preview/use-playback-clock.ts` and `render.ts` instead, and
come back to `Preview.tsx` when you already understand the pieces.

## Tier 6 — export

`src/output/exporter.ts` (458) · `codecs.ts` (306) · `self-check.ts` (112)

Last, because export depends on everything above it. `exporter.ts` is where the
source-time versus output-time distinction becomes unavoidable, and that
distinction is the whole ballgame for a video editor.

`codecs.ts` is worth reading even if you never export anything, because
`0008` is a genuinely good lesson in runtime capability detection.

## What to skip, and why

This is the more valuable half of the document.

| Skip | Why |
| --- | --- |
| `app/store/layout.ts` (259) | Panel drag maths. Nothing about media. |
| `app/view/Resizer.tsx` (69) | A draggable divider. Read it once, in ten minutes, then never again. |
| `dev/debug.ts` (159) | A logging facade that also streams to the dev-server terminal. Useful, not instructive. |
| `dev/preview-diagnostics.ts` (274) | 274 lines of luma sampling and overlay formatting. It exists so `Preview.tsx` does not. |
| `app/commands/keyboard.ts` (95) | A 40-line key-matching loop. Read the docblock; skip the body. |
| `app/commands/shortcuts.ts` (116) | A literal list. Skim for the interesting entries — the `m` mute shortcut (`:71`) has a real design note. |
| `main.tsx` (12) | Twelve lines. Read it last, as a curiosity. |
| `phase0.ts` | The performance harness. Not part of the app. |

## Don't read linearly. Trace.

The most efficient way to learn this codebase is to pick one user action and
follow it all the way through, writing down what you find. Three are written up:

| Trace | Action | What it teaches |
| --- | --- | --- |
| [traces/01-split.md](traces/01-split.md) | Press `S` | The model, the store, the selection policy, history, and reactivity. |
| [traces/02-playback.md](traces/02-playback.md) | Press play | Why preview is approximate and export is exact. The A/V contract. |
| [traces/03-audio.md](traces/03-audio.md) | Read the audio | Why there are three audio files and not one. |

## Then break something on purpose

Reading tells you what the code does. Breaking it tells you why the guardrails
exist, and the guardrails are the design.

Try each of these, then check out the file afterwards and read the comment
explaining what caught it:

| Try this | What catches it |
| --- | --- |
| Add `snapClipMove` and snap a move | `test/dom.test.ts` — the guards are explicit about this. |
| Let `toggleMute` accept a video clip | `test/model.test.ts` |
| Replace the plain set in `applyLanes` with `reconcile` | The media library vanishes. The 48-line file warns you. |
| Discard the frame when the playhead moved | The `test/frame-cache.test.ts` assertion, and the comment at `src/app/view/preview/Preview.tsx:197`. |
| Add a second drawing path in `render.ts` | Nothing catches it. That is why [ADR-1](decisions/0001-one-render-function.md) exists — read it before you finish this tier. |
| Hardcode `video: 'avc1'` in the exporter | `test/codecs.test.ts` |

The last two are the interesting ones: the tests that do not exist are the
reason the ADRs do. Knowing which guardrail is automated and which is a
comment is the actual skill of maintaining this codebase.

## If you are coming back after a break

Read [risks.md](risks.md) and the most recent entries in
[decisions/](decisions/), then do one trace. An hour, and you are back.
