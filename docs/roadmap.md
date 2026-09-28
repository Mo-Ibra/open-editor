# Roadmap

## Done

| Phase | Outcome |
|---|---|
| **0** — Prove the loop closes | Demux → decode → draw → encode → mux → download, all in a browser. Settled [ADR-3](decisions/0003-re-encode-only.md) and exposed [ADR-8](decisions/0008-negotiate-never-hardcode-a-codec.md). Still re-runnable at `/phase0`. |
| **1** — The model | Two linked lanes, derived positions, deliberate gaps, breakable links. |
| **2** — Editing | Trim, split, reorder, delete, duplicate, multi-select, undo/redo. |
| **3** — Preview | Playhead scrubbing, waveform, approximate decode with a frame cache. |
| **4** — Export | MP4/WebM with negotiation, A/V sync assertions, the output played back before download. |
| **5** — UX | Resizable panels, custom context menus, media bin drag-and-drop, format picker. |

## Next, in rough order of value

1. **Group drag for multi-selections.** Ctrl-click selects several clips, and
   every action applies to all of them — except dragging, which still moves only
   the clip under the pointer. Moving the whole selection is the obvious next
   thing, and it changes drag semantics that the snapping acceptance tests pin
   down, so it needs its own pass.
2. **Re-measure encode speed on a real 30 fps CFR clip** ([R2](risks.md#r2--encode-speed)).
   Everything about the export architecture depends on whether 154 fps was real.
3. **Spike Firefox and Safari export** ([R3](risks.md#r3--browser-fragmentation)).
4. **Project persistence**, if the answer to the open question below is that
   sessions need to survive.
5. **Ripple delete** — close the gap when a clip is removed. Currently a delete
   leaves the gap, which is correct for a cutter but not what people expect.
6. **Shade the dead air** using the `findSilence()` that already exists in
   `peaks.ts`.

## Explicitly not planned

Multi-track compositing, transitions, an effects pipeline, a plugin API, a
collaborative editor, a clip library. See
[risks.md](risks.md#r5--scope-creep-toward-premiere).

## Open questions

- [ ] **Which browsers do we claim to support — and do we say so on the README?**
      Currently untested anywhere but Chromium.
- [ ] **Do users want to keep a project across sessions, or is one sitting
      session the whole product?** If the latter, persistence drops off entirely
      and `idb` should be removed.
- [ ] **What is the non-negotiable floor** — the one feature that, if missing,
      makes this useless?
- [ ] **Is canvas zoom (`transform.scale`) good enough,** or do users want
      crop-to-zoom with fixed framing?
- [ ] **Is the moat anything,** or is this a weekend project? Worth answering
      before investing a month.

## Resolved

- ~~What is the measured 1080p30 encode FPS?~~ — 154 fps, 5.13× realtime.
  [ADR-3](decisions/0003-re-encode-only.md) settled; no stream-copy. ([R2](risks.md#r2--encode-speed))
- ~~Does export need a stream-copy fast path?~~ — No. Measured, and frame
  accuracy is worth more.
- ~~Should the codec be hardcoded?~~ — No. [ADR-8](decisions/0008-negotiate-never-hardcode-a-codec.md).

## Superseded

An earlier plan proposed vendoring a 15,000-line compositor engine from another
project. **That was the wrong call and it was abandoned.** A compositor's value
is effects, blend modes, masks, shaders and motion graphics; a cutter needs almost
none of it. Vendoring would have meant inheriting an ECS, a reconciler, a compile
step and a desktop shell, in order to end up with something smaller than what we
write directly.

Three ideas from it were kept, and they are load-bearing here:
[ADR-1](decisions/0001-one-render-function.md) (one renderer),
[ADR-2](decisions/0002-source-is-immutable.md) (the project is data), and
[ADR-5](decisions/0005-backpressure.md) (never spin on an encoder queue).

**No third-party engine code is vendored.** The only runtime dependencies are
SolidJS, mediabunny and idb.
