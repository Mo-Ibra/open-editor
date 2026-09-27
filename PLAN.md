# open-editor — Project Plan

> A video cutter for the web. Drop files, cut them, export. Nothing to install, nothing uploaded.

**Status:** planning. Nothing built yet.
**Written:** 2026-09-27 · **Rewritten:** 2026-09-28 — from scratch. No borrowed engine. See §1.

---

## 1. What changed, and why

An earlier draft of this plan proposed vendoring a 15,000-line editor engine from another project. **That was the wrong call** and this plan replaces it.

A compositor's value is effects, blend modes, masks, shaders, motion graphics. A cutter needs almost none of that. Vendoring it would have meant inheriting an ECS, a reconciler, a compile step, a desktop shell, and thousands of lines to delete — to end up with something smaller than what we write directly.

**What we build ourselves:** every line of the editing model, the render pass, the export loop, and the audio mixer. Those are the parts that must match our product anyway.

**What we still use libraries for:** demuxing and muxing containers. Nobody should hand-roll MP4 atom parsing. That is a year of work and buys nothing.

**What we learned from the abandoned plan and kept:**

1. **One render function.** Preview and export call the same code to draw the same frame. WYSIWYG is structural, not aspirational.
2. **The project is data.** An array of clips, not source code. Undo is a snapshot.
3. **Don't inherit a bare spin loop.** The old engine's export used `while (Atomics.load(...))` with no timeout. It deadlocks. We use the `dequeue` event.

**What we dropped:** the ECS, the reconciler, the JSX document, the desktop shell, keyframe animation, audio mixing graphs, 9 effect types, 16 blend modes, masks, gradients, WGSL shaders, three.js, a plugin API, and the entire AI subsystem. None of it is a cutter.

---

## 2. The product

### Who it's for
YouTubers, streamers, course creators. Someone with a 40-minute screen recording or a folder of camera clips who needs it to be 6 minutes, and who currently pays for that in Premiere or Resolve.

### The promise
**Drop files. Cut them. Export.**

Not "edit." Cut. Trim the ends, cut out the dead air, drop the mistake, fix the camera card.

### Non-negotiables
1. **No account, ever.** Not a trial, not an email gate.
2. **Nothing leaves the device.** There is no upload path in this codebase and there will never be one.
3. **Preview == export.** The same function draws both. If the preview looks right, the file is right.
4. **No install.** It runs in a tab.
5. **The source file is never modified.** Cutting is a change to a list, not to bytes on disk.
6. **Every action is instant.** Drop → playable. Split → done.

### Explicitly not
An Adobe replacement. A motion-graphics tool. A plugin host. A collaborative editor. A clip library. Anything with a plugin API.

---

## 3. The editing model

This is the whole product. It is small, and that is the point.

```ts
type Project = {
  version: 1
  assets: Record<string, Asset>
  clips:  Clip[]              // array order IS timeline order
  captions?: CaptionTrack
}

type Asset = {
  id: string
  name: string
  duration: number            // seconds
  width: number
  height: number
  rotation: 0 | 90 | 180 | 270
  frameRate: number           // nominal, for CFR assets
  variableFrameRate: boolean  // detected at probe — see §6.3
  hasAudio: boolean
  audioSampleRate: number
  videoCodec: string
  audioCodec: string
  size: number
}

type Clip = {
  id: string
  assetId: string
  in: number                  // source in-point, seconds
  out: number                 // source out-point, seconds
  transform?: { scale: number; x: number; y: number }
}

type CaptionTrack = {
  src: string                 // the imported .srt
  style: { font: string; size: number; color: string; background: string; position: 'top'|'center'|'bottom' }
}
```

### Three rules that keep this honest

**1. No `start` field.** Timeline position is *derived* — sum the durations of all preceding clips. A stored position and an array index can disagree; a derived one cannot. This deletes an entire bug class.

**2. Durations are derived, never stored.** `duration(clip) = out - in`. `start(clip) = Σ duration(clips[0..i-1])`. Two functions, used everywhere.

**3. Only integers at the boundaries.** `in` and `out` are floats in seconds because that's what a human drags. They are converted **once** to integer frames and integer audio samples at export time, and the export loop never does float math. See §6.1.

### Every edit is one of five operations

| Action | Operation | Cost |
|---|---|---|
| Trim a clip | change `in` or `out` | zero |
| Split a clip at t | insert a new clip, adjust both `in`/`out` | zero |
| Delete a clip | splice the array | zero |
| Reorder | move in the array | zero |
| Zoom / position | set `transform` | zero |

**Nothing re-encodes during editing.** Ever. The source is immutable and every edit is O(1) on a small array. This is why editing can be instant, and it's structural rather than a performance goal.

### Undo
A snapshot of the `clips` array. Structured clone, a few KB, push on every edit, cap at 100 entries. There is no undo engine to build. Do not build one.

---

## 4. Architecture

### Six modules, and that's all

```
src/
  project.ts     the model above. Pure data. Zero Web APIs.
  demux.ts       mediabunny → tracks, samples, keyframe index, codec config
  decode.ts      WebCodecs VideoDecoder + keyframe-accurate seek
  render.ts      ONE function: (state) → pixels on a Canvas2D context
  text.ts        Canvas2D text layout + caption rendering
  audio.ts       decode → trim → mix into one Float32Array
  export.ts      the frame loop, the audio loop, the encode queue, the mux
  preview.ts     playhead → clip → source time → frame → render.ts
  ui/            SolidJS components
```

`project.ts` has no imports from anything else in the codebase. It is pure, which makes it trivially testable and makes undo/redo a non-problem.

### ADR-1: One render function

`render.ts` exports a single function:

```ts
renderFrame(ctx: CanvasRenderingContext2D, frame: VideoFrame, clip: Clip, t: number, project: Project): void
```

Preview calls it. Export calls it. There is no second implementation, so there is nothing to drift. Text layout, transforms, and caption rendering all live inside it.

**This is the most important decision in the project.** Two renderers is how editors end up with "the preview doesn't match the export," and that bug is unfixable at scale.

Preview and export *do* differ in one way: preview decodes approximately (from the nearest keyframe, possibly late), export decodes exactly. The **pixels drawn are identical**; only which source frame is fetched differs.

### ADR-2: The source file is immutable

Cutting never writes to the media. There is no "save the project over your file," no destructive trim, no in-place edit. A project is a JSON file of pointers.

**Consequence:** undo is free, sharing a project is a 4 KB file, and a bug can never destroy someone's footage. This is the single most important safety property in the product and it costs nothing.

### ADR-3: Re-encode only, for now

Every export re-encodes. Stream copying (remuxing without re-encoding) is deferred to v1.1.

**Why.** Concatenating clips from two different files with different codecs or resolutions *must* re-encode. Stream copy only survives the narrow case of one source file, cuts only, no zoom, no text. That is not a headline feature.

**Revisit if the FPS measurement in Phase 0 is bad.** If 1080p re-encodes at 30+ FPS in a worker, this decision is settled for good and stream-copy is never needed. If it's under 5 FPS, build the fast path immediately — it would need keyframe snapping in the timeline, which is a visible UX cost.

### ADR-4: Deterministic audio mixing, not Web Audio graphs

`audio.ts` builds the whole mix as a plain `Float32Array`, sample by sample, and then encodes it. It does **not** use `OfflineAudioContext` with `GainNode`s.

**Why.** A graph is stateful, hard to reason about, and its output depends on graph construction order. Float32 arithmetic is exact, order-independent, and testable with a three-line assertion. For a cutter that only needs trim-and-concatenate, a graph is enormous overkill.

### ADR-5: Backpressure via the `dequeue` event, never a spin loop

The export loop must not enqueue frames faster than the encoder drains them. A 3-minute 1080p export is 5,400 frames; unconstrained, that is 5,400 live `VideoFrame` objects holding GPU memory.

```ts
// WRONG — allocates unbounded, OOMs, and a spin loop deadlocks the tab
while (encoder.encodeQueueSize > 0) { /* busy-wait */ }

// RIGHT — await an event, and it cannot deadlock
if (encoder.encodeQueueSize > 16) {
  await new Promise(r => encoder.addEventListener('dequeue', r, { once: true }))
}
```

**This is the number one crash cause in browser video export.** It is not optional and it is not a performance optimisation.

---

## 5. Stack

Deliberately thin. Every dependency here is load-bearing.

| Package | Version | Why |
|---|---|---|
| `vite` | latest | Build |
| `typescript` | 5.x | — |
| `solid-js` | 1.9.x | UI. Fine-grained reactivity with no VDOM — ideal for a timeline that derives everything from the playhead |
| `mediabunny` | latest | Demux, mux, WebCodecs wrapper, probe. **The only substantial dependency** |
| `idb` | 8.x | Optional. Project persistence only |

**Not used, deliberately:** no ECS library. No animation library — easing is 20 lines. No component library — `<dialog>` and `<input>` are enough. No schema library — validate on load with a hand-written guard. No state manager — Solid signals.

**Licenses:** SolidJS MIT, Vite MIT, idb ISC, mediabunny MPL-2.0. All compatible with shipping this as MPL-2.0 or MIT. No GPL anywhere. No ffmpeg.

### No ffmpeg, and that is a decision

A previous draft of this plan used ffmpeg.wasm for exotic formats. **Dropped.** It was a 30 MB lazy download, single-threaded, and its stock builds ship GPL components that would poison the bundle.

**Consequence, stated honestly:** this tool handles what a browser can decode. H.264 and VP9 everywhere; HEVC and AV1 on Safari and recent Chromium; ProRes, DNxHD, AC-3, and 10-bit HEVC **not at all**.

That is a real limitation and it is the main reason ProRes users will not use this. It is also why the project is a day-one prototype rather than a venture: ship it, see who shows up, and only then decide whether codec breadth is worth a GPL fight.

---

## 6. The hard parts

This section is the project. Everything in §7 is assembly.

### 6.1 A/V sync on export — the thing that decides whether this works

A correct export aligns two independent streams: video cut at **frame** boundaries, audio cut at **sample** boundaries. They must line up to the sample.

**Where it goes wrong:**

- **B-frames make decode order ≠ presentation order.** An H.264 frame with PTS 3 may be decoded before PTS 2. `VideoDecoder` outputs in presentation order, but you must supply timestamps in decode order or the encoder's reorder buffer desyncs.
- **Negative first timestamp.** ProRes and Avid exports carry edit lists; the first frame often has PTS < 0. WebCodecs is unhappy with negative timestamps. Normalise to 0 and hold the offset.
- **Float seconds accumulate.** `start += (out - in)` over 200 clips drifts. Convert to integer units once:
  ```ts
  const startSample = Math.round(start(clip) * SAMPLE_RATE)
  const lengthSample = Math.round((clip.out - clip.in) * SAMPLE_RATE)
  ```
  Never accumulate. One rounding, at the boundary.
- **AAC encoder delay.** The encoder emits ~1024 samples of priming. The muxer must record it, or playback starts with a click or a truncated first second.
- **Duration mismatch at the tail.** Video ends at `ceil(duration × fps)` frames; audio at `ceil(duration × sampleRate)` samples. They will not agree. Pad the shorter one.

**The tests to write before exporting anything:**

- Output frame count == `ceil(duration × outputFps)`, exactly
- Output sample count == `ceil(duration × 48000)`
- A/V drift over a 10-minute export < 1 ms
- First and last audible sample are not silent (catches AAC priming)
- A clip cut at a fractional time lands on the right source frame

If those five pass, sync is right. If any fails, no other work matters.

### 6.2 Frame-accurate seeking

Files are stored in groups of pictures. To get the frame at time *T*:

1. Binary-search the keyframe index for the last sync sample with DTS ≤ T
2. Seek the demuxer to that keyframe
3. `decoder.flush()`, then `decoder.configure()` — **a stale decoder holds frames from the previous seek**
4. Feed samples forward, discarding output frames with PTS ≤ T
5. Return the first frame with PTS > T

**Why this is a real bug and not a detail:** the naive approach — set `currentTime`, read the next frame — can return a frame up to a second away from what the user clicked. Preview only, so it feels like lag. In export, the same code cuts in the wrong place and nobody notices until they watch the result.

Add a small ring buffer of the last ~30 decoded frames. Scrubbing is then free, and dragging a trim handle stays smooth.

### 6.3 Variable frame rate

Screen recordings from OBS, QuickTime, and most screen capture tools are **VFR** — frames arrive at irregular intervals because the encoder only emitted a frame when the screen changed.

Any `frameIndex = round(t × fps)` is **wrong** for these, and wrong silently: the video plays at the right speed but drifts against the audio, or the last frame never appears.

At probe time, compare the sum of sample deltas against the container duration. If they disagree by more than ~1%, set `variableFrameRate: true`.

- **CFR asset:** the sample table is uniform. Index it directly. `frame = round(t × fps)`.
- **VFR asset:** build a sorted PTS array once. `frame = upperBound(pts, t) - 1` — the last frame that started at or before *t*.

Handle both. Screen recordings are exactly the files a cutter's audience has.

### 6.4 Rotation and aspect ratio

Phone video is stored landscape with a 90° rotation flag in the MP4 `tkhd` matrix. Ignore it and every portrait clip exports sideways — the single most common "why is this broken" bug in browser video tools.

Read the matrix at probe, normalise to `0 | 90 | 180 | 270`, and apply it as a canvas transform in `render.ts` for both preview and export.

Also handle **pixel aspect ratio**. Anamorphic DV is rare but appears in archives, and the fix is two lines.

### 6.5 Text and captions

Canvas2D text layout from scratch, because preview and export must agree (§ADR-1) and the preview is a canvas too.

- Wrap on measured width via `ctx.measureText`. Note that `TextMetrics.actualBoundingBoxAscent/Descent` is fragile across engines — prefer `fontBoundingBox*` with a fallback, and measure once per string, never per frame.
- **Cache layout.** Measure on change, key by `(text, font, size, maxWidth)`. Re-measuring per frame is the classic way to make a canvas app feel slow.
- `.srt` parsing is trivial: a timestamp line, a text line, blank line between cues. Handle `\r\n`, BOM, and multi-line cues. That is the whole format.
- Cue lookup is a binary search on start time. Do not scan linearly.

Ship `.srt` import before any text-overlay UI. It is 80% of the value for 5% of the work — most people already have captions from somewhere.

### 6.6 Export loop

The shape of it:

```ts
const outFps = 30
const totalFrames = Math.ceil(duration * outFps)

for (let i = 0; i < totalFrames; i++) {
  const t = i / outFps
  const clip = clipAt(t)                       // or null → black frame
  if (clip) {
    const sourceT = clip.in + (t - start(clip))
    const frame = await getFrame(clip.assetId, sourceT)
    renderFrame(ctx, frame, clip, t, project)
  } else {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H)
  }

  const vf = new VideoFrame(canvas, {
    timestamp: Math.round(i * 1_000_000 / outFps),
    duration:  Math.round(1_000_000 / outFps),
  })
  encoder.encode(vf, { keyFrame: i % (outFps * 2) === 0 })   // GOP of 2s
  vf.close()                                                  // mandatory, or you leak GPU memory

  if (encoder.encodeQueueSize > 16) await waitForDequeue(encoder)
  if (i % 10 === 0) onProgress(i / totalFrames)
}
await encoder.flush()
```

Note the `vf.close()`. It is not optional and forgetting it leaks a `VideoFrame` per frame — the tab dies around frame 2,000 with no error message.

Run the whole loop in a **Web Worker** with an `OffscreenCanvas`, or the tab freezes and the user cannot even hit cancel. Post progress back to the main thread.

Audio runs in parallel: build the full mix, chunk into 1024-sample `AudioData`, encode. Mux both streams at the end.

### 6.7 Export output

```ts
new VideoEncoder({ output, error }, {
  codec: 'avc1.42001f',       // baseline — maximum device support
  width, height,
  bitrate: 8_000_000,         // ~5 Mbps for 1080p30, tune later
  framerate: outFps,
  avc: { format: 'avc' },     // needed for MP4, not Annex-B
})
```

- `avc: { format: 'avc' }` is mandatory for MP4 output. The default Annex-B will not mux.
- `avc1.42001f` (Baseline 3.1) encodes everywhere. Try High (`avc1.4d0028`) as a preference with a fallback — better compression, near-universal support.
- **Feature-detect, do not assume.** `await VideoEncoder.isConfigSupported(cfg)`. Safari and older Chromium lack some codecs; fall back to VP9/WebM or tell the user honestly.
- AAC at 128 kbps, 48 kHz. Not 44.1 kHz — it avoids a resample.

---

## 7. Build phases

### Phase 0 — Prove the loop closes (2–3 days)

**No UI. One hardcoded file. Prove you can get a playable mp4 out of the browser.**

- Demux one file with mediabunny
- Decode a frame, draw it to a canvas
- Encode 300 frames
- Mux with a silent audio track
- Download it and verify it plays in QuickShot

**Then measure:** 1080p30 encode FPS, in a worker, on a real file. Write the number in this plan. It settles ADR-3.

**Exit:** a correct, playable 10-second 1080p mp4, generated in the browser, and a recorded FPS number.

If this phase fails, nothing else matters and you find out in three days instead of three weeks.

### Phase 1 — Project model + preview (1–2 weeks)
- `project.ts` and the three derived-duration functions
- Probe on drop, show real metadata
- Multi-file asset bin, drag onto a timeline
- Scrub, play, pause
- Frame-accurate seek (§6.2) with a frame ring buffer
- VFR detection (§6.3) and both frame-index paths
- Trim handles, split, delete, reorder

**Exit:** drop four clips, arrange them, scrub the whole thing smoothly, and the preview matches the source pixel for pixel.

### Phase 2 — Export (1–2 weeks)
- The frame loop, backpressure, `OffscreenCanvas` worker (§6.6)
- Deterministic audio mixing (§ADR-4)
- A/V sync, and the five tests in §6.1
- Rotation and PAR (§6.4)
- Progress with ETA, cancel
- Feature-detected codec fallback

**Exit:** the four-clip arrangement exports to an mp4 that is frame-accurate and does not drift. Run the sync tests before believing it.

### Phase 3 — Zoom, text, captions (1 week)
- `transform` on clips, drag handles on the canvas
- `.srt` import, caption rendering with layout cache (§6.5)
- One-tap presets: push in, pull out
- Caption styling: font, size, colour, position

**Exit:** a 2-minute edit with a zoom on a moment and burned-in captions, exported correctly.

### Phase 4 — Ship (1 week)
- Export presets: 1080p / 4K / 1080×1920. No settings panel
- Save / load `project.json` (a few KB of pointers, §ADR-2)
- PWA, offline shell
- Honest errors: unsupported codec, quota, encoder failure
- README that states the limitations in §5 out loud

### Later
Stream-copy export · version history · proxy editing for 4K · waveform display · speed ramps · snapping · keyboard shortcuts · template presets · drag-to-reorder from the OS

---

## 8. Risk register

### R1 — A/V sync
**The project fails here or it doesn't ship.** §6.1 lists six ways it breaks. The sync tests are written before the export code, not after.

### R2 — Encode speed
Unknown until Phase 0. Mitigations in order: measure, then progress-with-ETA (cheap, buys a lot of patience), then a decode worker pool. Do not build the worker pool before you have a number.

### R3 — Browser fragmentation
WebCodecs support is uneven. Safari has had it since 16.4 but is less battle-tested for encoding. Feature-detect everything and degrade loudly, not silently. Decide explicitly whether this is Chromium-first.

### R4 — Format coverage
This tool cannot open ProRes, DNxHD, AC-3, or 10-bit HEVC, and never will without a GPL fight (§5). This is a permanent scope limit, not a phase. Say it on the README.

### R5 — Scope creep toward Premiere
The failure mode for a "simple editor" is shipping a slightly worse Adobe. Keep §2's out-of-scope list visible and check every idea against it.

### R6 — "Cutter" turns into "NLE"
Multi-track compositing, transitions, and an effects pipeline are each a week and none are a cutter. The moment the render pass grows a second code path, ADR-1 is dead.

---

## 9. Open questions

- [ ] **What is the measured 1080p30 encode FPS?** (Phase 0. Settles ADR-3.)
- [ ] **Does export work in Safari and Firefox?** (R3. Spike it in week one.)
- [ ] Which browsers do we actually claim to support — and do we say so on the README?
- [ ] Is a canvas zoom (`transform.scale`) good enough, or do users want crop-to-zoom where the framing is fixed?
- [ ] Do we need frame-accurate cutting at all, or is snapping to the nearest second good enough? Frame accuracy is most of R1's cost.
- [ ] What's the non-negotiable floor — the one feature that, if missing, makes this useless?
- [ ] Do users want to keep a project across sessions, or is one sitting session the whole product? (If the latter, persistence drops off entirely.)
- [ ] Is the moat anything, or is this a weekend project? Be honest before investing a month.

---

## Appendix: notes

- The previous plan (2026-09-27) proposed vendoring `diffusionstudio/editor`'s engine under MPL-2.0. Abandoned 2026-09-28. The engine was a compositor, not a cutter, and the useful ideas (one render function, data-not-code, backpressure) are documented in §1 and kept in §4.
- No third-party engine code is vendored in this project. The only runtime dependencies are SolidJS, mediabunny, and idb.
