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
logic testable without a browser. `app/selection.ts` and `app/history.ts` are
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
| `audio/export-audio.ts` | The whole timeline as one mixed `Float32Array` ([ADR-4](decisions/0004-deterministic-audio-mixing.md)). |
| `audio/audio.ts` | Audio preparation for export: conform sample rate, downmix channels, trim. |
| `output/codecs.ts` | Codec negotiation. See [export.md](export.md#codec-negotiation). |

### State

| Module | Responsibility |
|---|---|
| `app/state.ts` | **Composition root.** Builds the slices, wires them, exposes one flat surface. |
| `app/selection.ts` | Clip selection. Multi-select policy; testable with no store. |
| `app/history.ts` | Undo. A stack of lane snapshots. |
| `app/assets.ts` | Import, remove, and getting files onto the timeline. |
| `app/edits.ts` | Every clip operation. Intent here, meaning in `model/project.ts`. |
| `app/transport.ts` | Playhead, playback, and what is derived from them. |
| `app/shortcuts.ts` | The shortcut list — the single source for handler and legend. |
| `app/keyboard.ts` | Matching and legend derivation. Pure, no browser. |
| `app/menu-items.ts` | The context menu, as a pure function of (state, target). |
| `app/layout.ts` | Panel geometry. A *preference*, not project data. |
| `model/project-store.ts` | The single point the project is written. See the warning inside. |
| `dev/debug.ts` | Logging that also streams to the dev-server terminal at `/__debug`. |

### UI

SolidJS components, no VDOM.

| Component | Responsibility |
|---|---|
| `app/app.tsx` | The shell. Wiring and markup only. |
| `ui/Timeline.tsx` | Lanes, clips, drag state machine, snapping, ruler, toolbar, waveform. |
| `ui/Preview.tsx` | The canvas, playhead-driven rendering, playback. |
| `ui/ExportDialog.tsx` | The export modal. Plays its own output before offering the download. |
| `ui/AssetBin.tsx` | Imported files. Select, double-click to append, drag onto a lane. |
| `ui/ContextMenu.tsx` | The application context menu. |
| `ui/Resizer.tsx` | The draggable panel dividers. |

### Not part of the app

`src/phase0.ts` + `phase0.html` are a **separate Vite entry point** serving a raw
encode/decode/mux benchmark at `/phase0`. No editor, no model, no Solid. It
exists because the answer to "can a browser close the loop, and how fast?"
settled [ADR-3](decisions/0003-re-encode-only.md) and should be re-runnable when
that is in doubt. It is dev-only and does not ship in the production build.

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
3. UI components may read anything and write only through `app/state.ts`.
4. `app/state.ts` holds no behaviour of its own. It builds slices and wires
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
