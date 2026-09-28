# Export

How a timeline becomes a playable file, and the ways that goes wrong.

## The pipeline

```
project ──▶ duration = projectDuration()
              │
              ├──▶ export-audio.ts  ──▶ one mixed Float32Array   (built FIRST)
              │        └─ verifyAudioTrack() against the §sync assertions
              │
              └──▶ exporter.ts.run()
                     ├─ codecs.ts.negotiate()  ──▶ MP4 or WebM
                     ├─ walk the WHOLE timeline, not just the clips
                     ├─ for each frame:
                     │    source time  = clip.in + k/fps
                     │    output time  = (cursor + k) / fps
                     │    frame        = sink.canvasesAtTimestamps(source)
                     │    renderFrame(ctx, frame, clip)        ← the ONE renderer
                     │    await canvasSource.add(output, 1/fps)
                     └─ mux
```

Audio is built **first** and checked before a single video frame is encoded. A
broken audio track is reported in a second, rather than after a minute of
encoding.

## Walking the whole timeline

The loop iterates the timeline, not the clips. **A gap is still timeline**: the
video must hold black for its duration, or the export comes out shorter than the
timeline and every frame after the gap is wrong.

`renderBlank()` fills those frames. The alternative — skipping gaps — produces a
file whose A/V drifts by the total gap duration, which is precisely the class of
bug in [A/V sync](#av-sync) below.

## Source time vs output time

**These are two different numbers and must never share an array.**

| | Formula | Used for |
|---|---|---|
| **Source time** | `clip.in + k / fps` | Seeking into the media file |
| **Output time** | `(cursor + k) / fps` | The timestamp in the muxed file |

A clip trimmed to 10s–25s of a seven-minute source starts reading at source 10s,
not source 0s. Conflating the two exports the entire source from its beginning,
so a 15-second cut comes out seven minutes long.

> This is not hypothetical. The loop once built its timestamps as
> `((cursor + i) * totalFrames) / totalFrames`, which cancels to `cursor + i` — a
> frame index handed to the muxer as if it were seconds. A 450-frame timeline
> produced timestamps running to 449 **seconds**, and decoded the whole source
> because `clip.in` was never applied. `test/exporter.test.ts` now pins both
> halves independently.

## Integers at the boundaries

`in` and `out` are floats in seconds, because that is what a human drags. They
become integers **once**, at the boundary:

```ts
const startFrame = Math.round(clipStart(clips, index) * fps)
const count      = Math.min(endFrame - startFrame, budget)
```

The tempting alternative:

```ts
for (let t = start; t < end; t += 1 / fps)   // WRONG
```

`1/30` is not representable, so the running sum drifts and the last clip emits one
frame too many. A 32-second timeline at 30fps produced **961 frames instead of
960**. Boundaries are rounded to whole frames once, then derived by division.

Never accumulate. One rounding, at the boundary.

## A/V sync

The thing that decides whether this works. A correct export aligns two independent
streams: video cut at **frame** boundaries, audio cut at **sample** boundaries.
They must line up to the sample.

**Where it goes wrong:**

- **B-frames make decode order ≠ presentation order.** An H.264 frame with PTS 3
  may be decoded before PTS 2. Supply timestamps in decode order or the encoder's
  reorder buffer desyncs.
- **Negative first timestamp.** ProRes and Avid exports carry edit lists; the
  first frame often has PTS < 0, and WebCodecs is unhappy with that. Normalise to
  0 and hold the offset.
- **Float seconds accumulate.** `start += (out - in)` over 200 clips drifts.
  Convert to integer units once.
- **Sample rate and channel count must be conformed.** See the
  [sample rate trap](media.md#the-sample-rate-trap).
- **Chunk pacing is not the video clock's problem.** The audio encoder places each
  buffer directly after the previous one. Pacing chunks by hand against the frame
  loop accumulates a rate mismatch and the audio runs short.
- **AAC encoder delay.** The encoder emits ~1024 samples of priming. The muxer
  must record it, or playback starts with a click.
- **Duration mismatch at the tail.** Video ends at `ceil(duration × fps)` frames,
  audio at `ceil(duration × sampleRate)` samples. They will not agree. Pad the
  shorter one.

`verifyAudioTrack()` in `audio/export-audio.ts` holds the mix to these assertions, and
is called before encoding starts.

> Note its limit: it checks the audio against the duration the audio was *built
> from*, so it is self-consistent by construction and structurally blind to a
> video-length error. That is why the video timestamps have their own test.

## Codec negotiation

**Never hardcode a codec.** See
[ADR-8](decisions/0008-negotiate-never-hardcode-a-codec.md) for the full
reasoning; the short version is that **Chrome has no AAC encoder on Linux**, and
a tool that hardcodes AAC works on the developer's Mac and fails for everyone
else.

`negotiate()` intersects three things and keeps everything that survives:

1. The container can hold the codec
2. The browser can encode it
3. The user actually has audio to encode

The whole viable list is returned, not just the first hit, so the dialog can
offer a real choice. On a typical Linux browser:

| Offered | Why |
|---|---|
| MP4 · H.264 + MP3 | Plays everywhere. The default, because AAC does not exist here. |
| WebM · VP9 + Opus | Smaller files, good quality. Not accepted by Instagram. |
| WebM · VP8 + Opus | Older, widely supported. |

A rejected combination is **never** silently swapped for a worse one — the reason
is recorded and shown under "Why not the other formats?".

Asking for something impossible **degrades rather than throwing**: the 4K probe
can fail where 1080p passed, and losing the whole export to that would be
absurd.

## Resolution and frame rate: default to the source, always

> The Phase 0 harness hardcoded 1280×720 and silently downscaled a 1920×1080
> source. The reaction — *"I don't want it to lose any frames or drop the quality
> like that"* — is the correct reaction, and it should never be possible to
> trigger.

A cutter's input is the user's own footage. The overwhelmingly correct output is
that same footage, trimmed. **Any deviation must be something the user chose**,
never a default the product made on their behalf. A tool that quietly re-encodes
someone's wedding video at half resolution is worse than a tool that fails.

- **Resolution = source resolution.** Presets exist and preserve the source aspect
  ratio, so choosing 720p for a 21:9 clip letterboxes rather than crops.
- **Dimensions are rounded to even integers** — odd widths fail
  `isConfigSupported` on most encoders.
- **Frame rate = source rate** for CFR. For VFR the average is meaningless
  (3.75 fps for a screen recording) and emitting at it produces a slideshow, so
  target 30 and hold frames.
- **Bitrate derived from resolution × fps.** A fixed bitrate is simultaneously
  wasteful at 4K and visibly blocky at 480p.

## Proving no frames were dropped

Frame accounting is a first-class output, not a debug log. Track the gap between
every pair of consecutive **distinct** source frames: the median is the source
frame interval, and the worst gap is the number to watch. A worst case far above
the median means a frame was skipped.

Duplicated output frames — a held frame, because the source is slow — are **not**
dropped frames and must not be reported as such. The distinction is source-side,
and conflating them makes the check useless.

**Always play the tool's own output before offering the download.** "It
downloaded but won't play" is the worst class of bug, because it looks like
success until someone tries to watch it. This is why the export dialog has a
`<video>` element in it.
