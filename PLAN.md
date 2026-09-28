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

> **Revised 2026-09-28 — two lanes.** The model below is now `video: Clip[]`
> and `audio: Clip[]` rather than one fused `clips: Clip[]`, and project
> version is **2**. The three rules are unchanged; see §3.1 for the lanes and
> links.

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

### 3.1 Two lanes, linked by default

```
┌─ video ────────────────────────  trim, zoom
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
├─ audio ────────────────────────  waveform, level, mute
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
```

Adding a file with picture and sound produces a **linked pair**: two clips
sharing one `linkId`. Splitting cuts both. Deleting one leaves the other, which
is the entire point — trimming the picture while keeping the sound is a normal
thing to want, and it is inexpressible if a clip carries its audio implicitly.

**Link rules, each pinned by a test:**
- A file with both → a linked pair. Audio-only → one unlinked audio clip. Silent → one unlinked video clip.
- Splitting a linked clip splits the partner **against its own timeline**, not the partner's source time. A linked pair can legitimately be out of alignment if you slid the audio, and splitting at the video's source time would land in the wrong place.
- A partner too short to split is **left alone**, rather than halved into a 10 ms clip.
- `Break link` severs both directions. Thereafter they are independent.

**Waveform.** Peaks at 200/sec, computed once per asset during the audio decode
we already do, cached, and redrawn only on zoom or trim — never per frame.
Extremes are preserved when downsampling to pixels, so a transient is never
lost to a bucket boundary: a waveform that quietly deletes peaks is worse than
no waveform, because people cut on it. `findSilence()` already exists in
`src/peaks.ts` for a later "shade the dead air" pass.

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
  audio.ts       conform (48k/stereo) → trim → mix into one Float32Array
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

**Revisit if the FPS measurement in Phase 0 is bad.** ~~If 1080p re-encodes at 30+ FPS...~~

**Settled by measurement (2026-09-28):** 7.27× realtime at 720p on the Phase 0 benchmark. Even discounting heavily for that being the easy case (§R2), re-encoding is comfortably faster than realtime, so the fast path is not needed and **stream-copy is not going to be built.** The timeline stays frame-accurate and the user never sees a cut snap to a keyframe — which is worth more than the speed would have been.

### ADR-4: Deterministic audio mixing, not Web Audio graphs

`audio.ts` builds the whole mix as a plain `Float32Array`, sample by sample, and then encodes it. It does **not** use `OfflineAudioContext` with `GainNode`s.

**Why.** A graph is stateful, hard to reason about, and its output depends on graph construction order. Float32 arithmetic is exact, order-independent, and testable with a three-line assertion. For a cutter that only needs trim-and-concatenate, a graph is enormous overkill.

### ADR-5: Backpressure — *handled by mediabunny, keep the rule anyway*

> **Correction (2026-09-28).** This ADR was written assuming we would drive a
> raw `VideoEncoder`. mediabunny's `CanvasSource.add()` / `AudioBufferSource.add()`
> return a promise that resolves when the source can accept more, so the
> library owns the queue and its backpressure. The rule below is now a
> constraint on how we *call* it, not something we implement.

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

## 4a. UI

Tailwind v4 (`@tailwindcss/vite`, no config file), design tokens declared in
`src/index.css` under `@theme`. Four custom utilities: `btn`, `btn-primary`,
`btn-ghost`, `panel-label`, `timecode`.

**The one rule the visual design follows: the picture is the only thing that
gets colour and space.** Every surface is a low-chroma near-neutral, clip tints
are dark washes rather than saturated blocks, and the only strong colours in
the app are the video, the playhead, and the primary button. An editor that
decorates its own chrome is competing with the thing the user is looking at.

Layout: top bar (44px) · media bin (236px) + preview · timeline (236px) ·
status strip. Export is a **modal**, not a permanent bar — it is a task with a
beginning and an end, and keeping it off the main surface gives the timeline
its pixels back.

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
- **Sample rate and channel count must be conformed.** AAC via WebCodecs only accepts 44.1 and 48 kHz. Camera and screen-capture files are frequently 96 kHz, and feeding the source rate straight to the encoder throws `This specific encoder configuration is not supported in this environment` and kills the export. Resample to 48 kHz and downmix anything above stereo. See `src/audio.ts`.
- **Chunk pacing is not the video clock's problem.** The audio encoder places each buffer directly after the previous one. Pacing chunks by hand against the frame loop accumulates a rate mismatch and the audio runs short. Assemble the decoded range first, then hand the encoder one correctly-sized chunk per interval.
- **AAC encoder delay.** The encoder emits ~1024 samples of priming. The muxer must record it, or playback starts with a click or a truncated first second.
- **Duration mismatch at the tail.** Video ends at `ceil(duration × fps)` frames; audio at `ceil(duration × sampleRate)` samples. They will not agree. Pad the shorter one.

**The tests to write before exporting anything:**

- Output frame count == `ceil(duration × outputFps)`, exactly
- Output sample count == `ceil(duration × 48000)`
- A/V drift over a 10-minute export < 1 ms
- First and last audible sample are not silent (catches AAC priming)
- A clip cut at a fractional time lands on the right source frame

If those five pass, sync is right. If any fails, no other work matters.

### 6.2 Frame-accurate seeking — *solved by mediabunny, not by us*

> **Correction (2026-09-28).** This section originally specified hand-rolling
> a keyframe index and a decode-forward loop. mediabunny 1.60 does both inside
> `CanvasSink.getCanvas(t)`, including flushing and reconfiguring the decoder
> between seeks. The only thing we own is a frame ring buffer for scrubbing.
> The reference implementation below is kept because it explains *why* the
> library call is trustworthy, and because the A/V drift risks in §6.1 are the
> same class of problem.

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

  // mediabunny takes SECONDS, not microseconds, and captures the canvas itself:
  await canvasSource.add(i / outFps, 1 / outFps, { keyFrame: i % (outFps * 2) === 0 })

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
const source = new CanvasSource(canvas, {
  codec: 'avc',               // mediabunny resolves the full codec string for us
  bitrate: 8_000_000,         // ~5 Mbps for 1080p30, tune later
  keyFrameInterval: outFps * 2,   // a keyframe every 2 s
})
```

- mediabunny takes friendly codec names (`'avc' | 'hevc' | 'vp9' | 'av1' | 'vp8' | 'prores'`) and builds the `avc1.*` string, MP4 `avcC` box, and annex-B handling itself.
- Codec capability lives on the *format*, not the `Output`, and is **synchronous**: `format.getSupportedVideoCodecs()` / `format.getSupportedAudioCodecs()`.
- Audio: `new AudioBufferSource({ codec: 'aac', bitrate: 128_000 })` — but see the sample-rate trap in §6.1 before you feed it anything.

### 6.9 Output resolution and frame rate — **default to the source, always**

> **Finding (2026-09-28).** The Phase 0 harness hardcoded 1280×720 and silently
> downscaled a 1920×1080 source. The user's reaction — *"I don't want it to lose
> any frames or drop the quality like that"* — is the correct reaction, and it
> should never be possible to trigger.

A cutter's input is the user's own footage. The overwhelmingly correct output
is the same footage, trimmed. **Any deviation must be something the user chose**,
never a default the product made on their behalf. A tool that quietly re-encodes
someone's wedding video at half resolution is worse than a tool that fails.

**Defaults:**
- **Resolution = source resolution.** Presets ("1080p", "720p", …) are available and are scaled to preserve the source aspect ratio, so choosing 720p for a 21:9 clip letterboxes rather than crops.
- **Dimensions are rounded to even integers** — odd widths fail `isConfigSupported` on most encoders.
- **Frame rate = source frame rate** for CFR. For VFR, the average rate is meaningless (3.75 fps for a screen recording) and emitting at it produces a slideshow, so target 30 and hold frames.
- **Bitrate derived from resolution × fps**, not a fixed constant. A fixed bitrate is simultaneously wasteful at 4K and visibly blocky at 480p.

**Proving no frames were dropped.** Frame accounting is a first-class output, not a debug log. Track the gap between every pair of consecutive *distinct* source frames; the median is the source frame interval and the worst gap is the number to watch. A worst case far above the median means a frame was skipped, and that is a bug worth failing loudly over. Duplicated output frames (a held frame, because the source is slow) are not dropped frames and must not be reported as such — the distinction is source-side, and conflating them makes the check useless.

**Always play the tool's own output before offering the download.** "It downloaded but won't play" is the worst class of bug, because it looks like success until someone tries to watch the result.

### 6.8 Codec negotiation — *not optional, and it bit us in Phase 0*

> **Finding (2026-09-28).** The Phase 0 export failed twice on a valid-looking AAC config. The second failure was not a parameter problem at all.

**AAC encoding is not universally available.** Chrome and Edge only encode AAC on **macOS, iOS and Windows**, via the platform encoder. On **Linux** there is no AAC encoder, so `AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })` returns `supported: false` and the encoder throws:

```
This specific encoder configuration (mp4a.40.2, 128000 bps, 2 channels, 48000 Hz)
is not supported in this environment.
```

Every parameter is valid. The encoder simply does not exist. Firefox has the same gap. A tool that hardcodes AAC works on the developer's Mac and fails for everyone on Linux — which is most of the people who would install it.

**Therefore: never hardcode a codec.** Negotiate at export time, taking the first combination that survives all three filters:

1. The container can hold it — `format.getSupportedCodecs()`
2. The browser can encode it — `VideoEncoder.isConfigSupported` / `AudioEncoder.isConfigSupported`
3. The user actually has audio to encode

```ts
const COMBINATIONS = [
  { format: 'mp4',  video: 'avc', audio: 'aac'  },  // the target, near-universal
  { format: 'mp4',  video: 'avc', audio: 'opus' },
  { format: 'webm', video: 'vp9', audio: 'opus' },  // what Linux actually gets
  { format: 'webm', video: 'vp8', audio: 'opus' },
  { format: 'webm', video: 'vp9', audio: null   },  // video-only, last resort
]
```

**Note the container switch is not optional either.** Opus-in-MP4 will not open in QuickShot. Falling back to Opus while still muxing MP4 produces a file that looks fine and silently fails for the user. Switch to WebM with it, and say so in the UI.

**Never put Opus in MP4.** Measured in Phase 0: `mp4 / avc + opus` muxes without complaint and produces a file that **will not play** — Firefox refuses it, QuickShot certainly will. A valid container holding a codec nobody's player opens is the worst possible failure, because it looks like success until someone tries to watch it. If AAC is unavailable, switch the *container*, not just the codec.

**Log every rejected combination and show it.** A user who gets a `.webm` instead of the `.mp4` they expected deserves to know why, and a developer needs it to debug. Never fail silently to a worse format.

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

**Result: complete.** 300 frames muxed, downloaded, and **played back successfully in-browser** at 1920×1080 / 10.02 s. **154 fps — 5.13× realtime** — after fixing a 13× miss caused by using mediabunny's per-frame seek path in a loop instead of its single-pass iterator.

Delivered along the way, all of which are product code rather than throwaway harness:
- Codec negotiation across container + encoder capability (§6.8)
- Source-derived output resolution and frame rate, with loud warnings on downscale or fps loss (§6.9)
- Frame accounting that distinguishes *held* frames from *dropped* frames (§6.9)
- A self-playback check so "downloaded but won't play" can't ship
- `src/audio.ts`: 48 kHz conform + stereo downmix + deterministic mixing (ADR-4)
- `src/project.ts`: the editing model, with 25 assertions pinning the derived-position rules
- `test/dom.test.ts`: every `$('id')` in the script exists in the HTML

**Still outstanding, and it is the one honest gap in this result:** the benchmark file is a 3.75 fps VFR screen recording with near-static content — the cheapest possible input. A 30 fps camera clip with real motion is ~8× the frames and far more bitrate. Headroom at 5.13× is large enough that this is unlikely to bite, but it has not been measured. Re-run on a genuine camera file before quoting any speed number to a user.

### Phase 1 — Project model + preview — **BUILT (2026-09-28)**, needs hands-on review

| File | What |
|---|---|
| `src/render.ts` | `renderFrame` — the single render pass (ADR-1), plus `fitRect` so overlays share the video's geometry |
| `src/library.ts` | `MediaLibrary` — owns every File, Input and sink. No opinion about the project model |
| `src/frame-cache.ts` | Ring buffer for scrubbing. No mediabunny dependency, so it is unit-testable |
| `src/state.ts` | The one store. Undo is a snapshot of the clips array |
| `src/ui/AssetBin.tsx` | Drop, probe, real metadata, append on click |
| `src/ui/Preview.tsx` | Canvas + transport + rAF playback |
| `src/ui/Timeline.tsx` | Arrange, reorder, trim, split, playhead |

- `space` play · `S` split · `⌫` delete · `←`/`→` step frame (`shift` = 10) · `⌘Z` undo
- Playhead seeks by scrubbing anywhere on the preview canvas
- `src/project.ts` knows nothing about mediabunny; `src/library.ts` knows nothing about clips

**Exit criteria — met, pending verification by hand:** drop four clips, arrange them, scrub smoothly, preview matches the source pixel for pixel.

**Audio (built 2026-09-28) — `src/audio-engine.ts`**

The hard part is not making noise, it is making the noise agree with the playhead.

1. **The AudioContext clock is the master.** It is a sound card clock and does not drift the way `performance.now()` and `setInterval` do. The transport's 120 Hz interval only *polls* it; the playhead is derived from audio time. A JS timer drifts into A/V desync within minutes on a long edit.
2. **A seek is sample-accurate.** Starting mid-clip begins audio at the matching source offset, not at the head of the clip. Getting this wrong is the classic "sound is out by a bit" bug — invisible in a 5-second test, obvious in a 10-minute edit.
3. **Silence is scheduled, not skipped.** A gap in the timeline is a gap in the audio. Skipping the gap compresses the sound and desyncs everything after it.
4. Assets are decoded **once** and cached; each asset is conformed to 48 kHz via the existing `conformAudioBuffer` (§6.1), so 96 kHz camera files work.

- `M` mutes, per-clip level + mute in the timeline bar
- Any edit that invalidates the schedule (seek, split) rebuilds it from the new position
- Falls back to a wall clock if the browser refuses to start audio, so video still plays

**Not yet done in Phase 1:**
- **No export.** The `renderFrame` path is shared, so Phase 2 is wiring, not re-architecting — but there is no export button yet.
- No thumbnails in the bin (a `CanvasSink` at t=0 would do it; deferred as mechanical).
- No snapping, no keyboard reordering, no scrub-audio (dragging the playhead is silent by design).
- No master bus, no waveform, no per-clip fades, no speed control. Per-clip gain and mute only; a mixer is a different feature.
- Preview decode is not in a worker, so a long seek can still jank the tab.

### Phase 2 — Export — **video path BUILT (2026-09-28), audio pending**

| File | What |
|---|---|
| `src/codecs.ts` | Container + encoder negotiation, shared with the Phase 0 harness (§6.8) |
| `src/exporter.ts` | The frame loop, one sequential decode pass per clip |
| `src/ui/ExportPanel.tsx` | Presets, progress + ETA, cancel, **and a self-playback check** |

- Output resolution and frame rate default to the **source** (§6.9). Three presets, no settings panel.
- Reuses `renderFrame` — preview and export share one draw path (ADR-1).
- Per clip, output timestamps go through **one** `canvasesAtTimestamps` pass, so every packet is decoded at most once (§R2).
- Audio-only clips emit their own black frames, so the video cannot come out shorter than the timeline.
- The result is **played in the page** before the download link appears.

**Two bugs the tests caught on the first run — both worth recording:**

1. **961 frames instead of 960.** `for (let t = start; t < end; t += 1 / fps)` looks equivalent to counting frames and is not: `1/30` is not representable, the running sum drifts, and the final clip emits a spare frame. This is the float accumulation §6.1 warns about, committed in the one place the plan explicitly says not to. Fixed by rounding clip boundaries to whole frames once and deriving by division. **`test/exporter.test.ts` now pins the invariant at 24/25/30/50/60 fps.**
2. **An out-of-range clip index threw** instead of yielding no frames. An empty timeline is an empty export, not a crash.

**Audio on export (built 2026-09-28) — `src/export-audio.ts`**

- The whole timeline becomes **one** mixed buffer via the deterministic `Float32Array` mixer (ADR-4). No Web Audio graph.
- **Every position is an integer sample index computed once, at the boundary.** The mix loop never does float math. This is the §6.1 drift rule and the reason the sync checks pass.
- A gap in the timeline is **silence, not a skip** — skipping would compress the sound to the front and desync everything after it.
- The preview's decoded-audio cache is shared, so a 7-minute file is decoded once, not twice.
- `verifyAudioTrack()` holds the mix to the §6.1 assertions *before* a minute of video is encoded: duration matches the video within one frame, channel count, and not silent. Tolerance is one video frame — a frame of slack is correct, a sample of slack is not.

**`test/export-audio.test.ts` — the §6.1 tests, written before the mixing code,** on purpose. The plan says tests come first for A/V sync, and the float-accumulation bug in `frameTimesForClip` was found exactly this way. Seven suites, ~20 assertions: exact duration, gaps as silence, overlapping segments sum, gain and mute, short-audio detection, one frame of slack tolerated, silent mix reported rather than shipped.

**A reporting bug worth recording.** The first audio export worked, and the panel announced *"no audio — but we added one. MUXER AND PANEL DISAGREE."* It was a false positive from the check, not a fault in the file. Chrome leaves `video.audioTracks` empty until tracks are *enabled*, and `webkitAudioDecodedByteCount` is 0 until something has decoded — so at `loadedmetadata` both mean "not yet", not "absent". The detector now reports three states (`present` / `absent` / `not yet confirmed`) and re-checks on `timeupdate`, once the decoder has actually run. **A check that cries disagreement on inconclusive evidence is worse than no check.**

**Still to do in Phase 2:**
- No worker yet, so a long export blocks the tab between awaits. Cancel stays alive, but a 10-minute render is a long wait.
- Frame accounting (§6.9) is not reported in the export panel.
- No fps preset, no bitrate control, no progress detail during the audio-encode stage.

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

### R2 — Encode speed — **RESOLVED. 13× faster. ADR-3 settled.**

**Phase 0 result (2026-09-28).** Linux laptop, 1280×720 output, single-threaded, on the main thread, source = 3.75 fps VFR screen recording.

| Metric | Value |
|---|---|
| Throughput | **15.8 fps** against a 30 fps output |
| Realtime factor | **0.53×** — *slower than realtime* |
| 1-minute edit | ~3.8 s |
| 10-minute edit | ~6.3 min |
| Trend | **degrading**: 27.9 → 18.7 → 16.2 fps across the run |
| Container | mp4 / avc + opus (no AAC encoder on Linux, §6.8) |

Video encoding itself worked; only the audio codec had to fall back.

**Before / after the fix:**

| | Before | After (720p) | After (1080p, final) |
|---|---|---|---|
| Throughput | 15.8 fps | 218 fps | **154 fps** |
| Realtime factor | 0.53× | 7.27× | **5.13×** |
| 300 frames | 17.84 s | 1.38 s | **1.95 s** |
| 10-minute edit | ~6.3 min | ~1m 23s | **~1m 57s** |
| Decode | 99% of wall clock | ~0% | ~0% |
| Encode | 1% | 100% | 100% |
| Trend | degrading 22.5 → 13.6 fps | stable | **stable** |
| Draws | 300 | 49 | **49** (84% skipped) |
| Output size | 0.78 MB | 2.24 MB | 4.44 MB |

Frame accounting at 1080p: 49 distinct source frames used, 251 output frames held, median gap 183 ms, worst 500 ms against a ~267 ms source interval — **no dropped frames.** Note the "83,565 fps" decode figure is the frame-reuse path being timed, not real decoding; the metric is only meaningful on frames that actually decoded.

Output verified: the page plays its own result via a `<video>` element — `OK — 1920x1080, duration 10.02s`. Do this every time (§6.9).

**Instrumented result that found it — where the time actually went:**

```
decode  17.66s  99%   (sink.getCanvas + draw)
encode  0.13s   1%   (canvasSource.add)
decode rate  first half 22.5 fps -> second half 13.6 fps   (degrading)
```

**The encoder is not the problem. Decoding is, entirely.** Lowering the output resolution would buy almost nothing.

**Root cause found.** The loop called `CanvasSink.getCanvas(t)` once per output frame. mediabunny's docs are explicit that this is the slow path and that there is a fast one:

> `canvasesAtTimestamps`: *"uses an optimized decoding pipeline if these timestamps are monotonically sorted, **decoding each packet at most once**, and is therefore more efficient than manually getting the canvas for every timestamp."*

Each individual `getCanvas()` re-seeks and re-decodes from the preceding keyframe. On a sparse-keyframe VFR source that cost grows with `t` — which is precisely the degradation measured. Switching to a single `canvasesAtTimestamps()` pass over monotonically increasing timestamps decodes each packet once.

**Second, independent win.** `WrappedCanvas` exposes `.timestamp` and `.duration`. On a 3.75 fps source producing 30 fps, the same source frame is correct for ~8 consecutive output frames, so the redraw is pure waste. Skip the draw when the timestamp is unchanged.

**The lesson worth keeping:** a 13× miss on the critical path came from not reading the library's docs for a function that was right there in the type definitions. Check the API surface before optimising around it.

**⚠️ This benchmark is the easy case. Do not treat 218 fps as the product number.**

| Flattering factor | Reality |
|---|---|
| Source is 3.75 fps VFR | A real 30 fps camera video is 8× the frames |
| Content is near-static | Screen recording compresses to almost nothing; motion does not |
| Output is 720p VP9 | 1080p is 2.25× the pixels; 4K is 9× |
| Single-threaded, main thread | Not the shipping configuration, but it doesn't matter now |

A realistic estimate for 1080p30 with real motion is somewhere well below 218 fps, plausibly 40–80×. **Re-run on a genuine 30 fps camera clip at 1080p before treating R2 as closed for good.** If it lands above 30 fps, stream-copy is definitively dead and a worker pool is unnecessary. If it lands under, the next lever is a parallel decode pool — but not before the measurement.

**Mitigations, in order of cost:**
1. ~~Split decode from encode time~~ — **done.** 99% decode, 1% encode. Points squarely at the decode path, not the encoder.
2. ~~Use `canvasesAtTimestamps` instead of per-frame `getCanvas`~~ — **done.** Expect a large jump; re-measure before deciding anything else.
3. **Re-test on a normal CFR 30 fps file** to separate the VFR pathology from a real ceiling. Still outstanding.
4. **Re-measure.** If decode is still dominant after the iterator fix, a parallel decode worker pool is the next real option — but do not build it before seeing the new number.
3. Honest progress + ETA. Cheap, buys patience. Not a fix, and not optional either.
4. Offload **decode only** to a parallel worker pool. Much easier than parallel compositing, and seeking is the expensive part (§6.2).
5. `OffscreenCanvas` worker pool for decode + composite. Stops the tab freezing during a 6-minute export. **Buys no throughput** — it is a UX fix and must not be confused with a speed fix.
6. Default exports to 1080p and make 4K an explicit choice, rather than assuming it.

### R3 — Browser fragmentation — **confirmed real, in Phase 0**
This is not theoretical. Phase 0 could not encode AAC on Linux at all (§6.8), and the fallback chain is now load-bearing product code rather than a nice-to-have.

Safari has had WebCodecs since 16.4 but is less battle-tested for encoding. Feature-detect everything and degrade loudly, with the reason shown. Decide explicitly whether this is Chromium-first.

Corollary: **the output format cannot be fixed at build time.** `export.mp4` is a *preference*, not a guarantee, and the schema's `format` field in §3 is aspirational until negotiation runs.

### R4 — Format coverage
This tool cannot open ProRes, DNxHD, AC-3, or 10-bit HEVC, and never will without a GPL fight (§5). This is a permanent scope limit, not a phase. Say it on the README.

### R5 — Scope creep toward Premiere
The failure mode for a "simple editor" is shipping a slightly worse Adobe. Keep §2's out-of-scope list visible and check every idea against it.

### R6 — "Cutter" turns into "NLE"
Multi-track compositing, transitions, and an effects pipeline are each a week and none are a cutter. The moment the render pass grows a second code path, ADR-1 is dead.

---

## 9. Open questions

- [x] **What is the measured 1080p30 encode FPS?** — 154 fps, 5.13× realtime. ADR-3 settled; no stream-copy. (R2)
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
