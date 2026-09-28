# Architecture

## The shape of it

A file goes in, becomes decodable frames, gets drawn on a canvas, and comes out
as an encoded file. Everything else is editing a list of pointers.

```
File ──▶ probe.ts ──▶ Asset ──▶ library.ts ──▶ CanvasSink
                            │                      │
                            ▼                      ▼
                     project.ts (the edit)   frame-cache.ts
                            │                      │
                            ▼                      ▼
                       render.ts ◀─────────────────┘
                       (one render pass)
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
          Preview.tsx                 exporter.ts
        (scrub/play, ~seek)         (exact, every frame)
              │                           │
              └────────▶ export-audio.ts ◀┘
                          (one mixed Float32Array)
                                │
                                ▼
                        codecs.ts ──▶ MP4 / WebM
```

## The modules

### Pure — no Web APIs, no imports from the app

These run in Node. That is not an accident; it is what makes the interesting
logic testable without a browser. `app/store/selection.ts` and `app/store/history.ts` are
pure for the same reason, and are the pattern to follow when adding a slice.

| Module | Responsibility |
|---|---|
| `model/project.ts` | The editing model. Types, derived positions, and every edit operation. Zero Web APIs. |
| `model/snapping.ts` | Magnetic snapping. One exported function: `snapTrimEdge`. |
| `output/codecs.ts` | Which output format this browser can actually produce. |
| `media/frame-cache.ts` | Frame reuse for scrubbing. No mediabunny dependency. |

`model/project.ts` having no imports from anywhere else is load-bearing: it makes the
model trivially testable and makes undo a non-problem.

### Media

| Module | Responsibility |
|---|---|
| `media/library.ts` | Owns every `File`, `Input` and decoder sink. Deliberately dumb: loads, probes, hands out decoders. |
| `media/probe.ts` | File → `Asset`. Detects VFR, rotation, pixel aspect ratio. See [media.md](media.md). |
| `media/frame-cache.ts` | Holds recently decoded frames so scrubbing is not a re-decode. |
| `media/peaks.ts` | Waveform peaks, and `findSilence()` for a future dead-air pass. |
| `audio/audio-engine.ts` | **Preview** audio playback. Scheduling, not mixing. |

Note the split: `audio.ts` mixes for export, `audio-engine.ts` plays for
preview, `export-audio.ts` produces the export track. Three files because they
have three genuinely different jobs, and merging them is how a preview ends up
audible during an export.

### Rendering and export

| Module | Responsibility |
|---|---|
| `render/render.ts` | **One** function, `renderFrame`. Preview and export both call it ([ADR-1](decisions/0001-one-render-function.md)). |
| `output/exporter.ts` | The frame loop: walk the timeline, fetch each frame, render, encode, mux. |
| `output/self-check.ts` | Play the exported file and report what it actually contains. |
| `audio/export-audio.ts` | The whole timeline as one mixed `Float32Array` ([ADR-4](decisions/0004-deterministic-audio-mixing.md)). |
| `audio/audio.ts` | Audio preparation for export: conform sample rate, downmix channels, trim. |
| `output/codecs.ts` | Codec negotiation. See [export.md](export.md#codec-negotiation). |

### State

`app/` is three layers, and the file extension is a reliable signal for which:
`.tsx` renders, `.ts` does not.

| Module | Responsibility |
|---|---|
| `app/store/state.ts` | **Composition root.** Builds the slices, wires them, exposes one flat surface. |
| `app/store/selection.ts` | Clip selection. Multi-select policy; testable with no store. |
| `app/store/history.ts` | Undo. A stack of lane snapshots. |
| `app/store/assets.ts` | Import, remove, and getting files onto the timeline. |
| `app/store/edits.ts` | Every clip operation. Intent here, meaning in `model/project.ts`. |
| `app/store/transport.ts` | Playhead, playback, and what is derived from them. |
| `app/commands/shortcuts.ts` | The shortcut list — the single source for handler and legend. |
| `app/commands/keyboard.ts` | Matching and legend derivation. Pure, no browser. |
| `app/commands/menu-items.ts` | The context menu, as a pure function of (state, target). |
| `app/store/layout.ts` | Panel geometry. A *preference*, not project data. |
| `model/project-store.ts` | The single point the project is written. See the warning inside. |
| `dev/debug.ts` | Logging that also streams to the dev-server terminal at `/__debug`. |
| `dev/preview-diagnostics.ts` | Luma sampling and the health/overlay readouts. Pure. |

### UI

SolidJS components, no VDOM.

| Component | Responsibility |
|---|---|
| `app/view/App.tsx` | The shell. Wiring and markup only. |
| `app/view/Timeline.tsx` | Layout and composition. No decisions. |
| `app/view/timeline/use-timeline-drag.ts` | Every pointer and wheel gesture: seek, move, trim, right-click, zoom. |
| `app/view/timeline/ticks.ts` | Ruler spacing and labels. Pure, in a `.ts` so it is testable. |
| `app/view/timeline/Ruler.tsx` | The ruler's markup. |
| `app/view/timeline/Lane.tsx` | One lane, and the drop target for dragged-in files. |
| `app/view/timeline/Clip.tsx` | One clip: body, trim handles, badges. |
| `app/view/timeline/Waveform.tsx` | The peaks canvas. |
| `app/view/timeline/Toolbar.tsx` | The toolbar. |
| `app/view/Preview.tsx` | The canvas and the render loop. Cohesive on purpose. |
| `app/view/preview/Transport.tsx` | The transport bar: play, stepping, mute, time, zoom. |
| `app/view/preview/use-playback-clock.ts` | The playback clock. Polls the audio clock; never owns it. |
| `app/view/ExportDialog.tsx` | The export modal. Plays its own output before offering the download. |
| `app/view/AssetBin.tsx` | Imported files. Select, double-click to append, drag onto a lane. |
| `app/view/ContextMenu.tsx` | The application context menu. |
| `app/view/Resizer.tsx` | The draggable panel dividers. |

### Not part of the app

`src/phase0.ts` + `phase0.html` are a **separate Vite entry point** serving a raw
encode/decode/mux benchmark at `/phase0`. No editor, no model, no Solid. It
exists because the answer to "can a browser close the loop, and how fast?"
settled [ADR-3](decisions/0003-re-encode-only.md) and should be re-runnable when
that is in doubt. It is dev-only and does not ship in the production build.

## Split by coupling, not by line count

`Timeline.tsx` was 755 lines and `Preview.tsx` was 558. Only the first wanted
splitting.

- **Timeline had breadth, low coupling.** Six unrelated regions at one indent
  level, none touching another's locals. Every piece had an obvious name, so it
  became seven files.
- **Preview has depth, high coupling.** Its top ~300 lines are one render loop.
  `draw()` reaches into eight component locals (`explain`, `canvas`,
  `requestedAt`, `paintedAt`, `inFlight`, `paint`, `showDiag`, `lastError`).
  Extracting it means a ten-parameter function — which is exactly the trap that
  made the *first* diagnostics attempt make the file longer instead of shorter.

So Preview got two extractions and a `ticks.ts`, and kept its render loop intact.
Two files where Timeline has seven is the correct outcome, not a half-measure.

## Two rules the view layer follows

**Pure logic goes in `.ts`, even when it belongs next to a component.** The test
runner strips types with Node's own loader, which **cannot load `.tsx` at all** —
so pure logic parked in a component file is untested by construction. That is
why `timeline/ticks.ts` is separate from `Ruler.tsx`.

**The gesture contract is checked across files.** `use-timeline-drag` finds
clips, lanes and trim handles by `data-*` attribute, and `Clip`/`Lane` render
them from *different files*. `closest('[data-lane]')` and `dataset.handle` are
strings, so a rename on either side breaks dragging at runtime with no compile
error and no unit test. `test/dom.test.ts` therefore reads both halves and
asserts every attribute the controller queries is actually rendered.

## Where diagnostic code lives

Two modules exist purely to keep dev instrumentation out of the view, and both
followed the same rule: **extract the pure part, keep the DOM call.**

- `dev/preview-diagnostics.ts` samples luma and formats every readout. The
  preview keeps only `getImageData` and `fillText`, because those genuinely need
  a canvas. It takes the store whole and six accessors, rather than being handed
  twenty copied fields.
- `output/self-check.ts` judges the exported file. It reads the `<video>`
  element once and everything else is a pure function of the facts.

The rule matters: the first attempt at the preview extraction passed twenty
individual values across and made the component *longer* than before. A wide
behavioural interface is not a refactor, it is the coupling moved somewhere less
obvious.

## Data flow

**Import.** `addFiles` → `library.add` opens a `File` and an `Input` →
`probe.ts` measures it → an `Asset` lands in `project.assets` → the bin shows it.
Importing does *not* touch the timeline.

**Edit.** Every operation in `model/project.ts` takes a `Project` and returns a new
one. The store writes it through `project-store.ts` and pushes the previous
lanes onto the undo stack. Nothing re-encodes, ever.

**Preview.** The playhead moves → `clipAtLane` finds the clip → `sourceTimeAt`
converts timeline time to source time → the frame cache returns a frame, decoding
if needed → `renderFrame` draws it.

**Export.** `output/exporter.ts` walks the *whole timeline*, not just the clips, because
a gap is still timeline and must hold black. For each frame it asks the sink for
the canvas at a **source** timestamp, renders it, and adds it to the encoder at an
**output** timestamp. Those are two different numbers and must not share an
array — see [export.md](export.md#source-time-vs-output-time).

## Layering rules

These are not enforced by anything, so they are worth stating:

1. `model/project.ts` must not import from any other module in the app.
2. `render/render.ts` must not know what a playhead is. It draws one image.
3. UI components may read anything and write only through `app/store/state.ts`.
4. `app/store/state.ts` holds no behaviour of its own. It builds slices and wires
   them; a `project.ts` call that appears there is a bug, because it would
   bypass the slice that owns the policy around it.
4. No module may hardcode an output codec. See
   [ADR-8](decisions/0008-negotiate-never-hardcode-a-codec.md).

Rule 2 is what makes [ADR-1](decisions/0001-one-render-function.md) hold. If
`render.ts` needed the playhead, preview and export would start passing
different things to it, and the guarantee would quietly become a convention.

## Testing strategy

Pure logic is unit-tested directly. Everything else is covered by reading the
source or the built output, because the failures that matter are invisible to
both a type checker and a DOM-free test:

- `test/dom.test.ts` — singleton panels rendered once, context menus bound to
  right-click only, no invalid CSS in the build, no `reconcile` on the project store
- `test/snapping.test.ts` — asserts there is exactly one exported snapping
  function, so a move-path helper cannot be quietly re-added
- `test/model.test.ts` — links, gaps, duplication, the audio-only mute rule
