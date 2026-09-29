# Trace 03 — why there are three audio files

`src/audio/` contains 710 lines across three files, and the most common
misunderstanding about this codebase is that they do the same job. They do not.

| File | Lines | Question it answers |
| --- | --- | --- |
| `audio.ts` | 167 | *What shape must audio be in, and how do clips become one buffer?* |
| `export-audio.ts` | 158 | *What is the single audio track of the exported file?* |
| `audio-engine.ts` | 385 | *What do I hear right now, during preview?* |

Short version: **only `audio-engine.ts` is preview.** The other two are export.
Conflating them is how people end up trying to use a Web Audio graph to build
the export, which `export-audio.ts`'s docblock explicitly warns against.

## `audio.ts` — conform, then mix

Two jobs, and the docblock is honest about why they are not the same job as
mixing.

### Conforming: `conformAudioBuffer` (`:28`)

> 1. **Resample to 48 kHz.** AAC via WebCodecs only accepts 44.1 and 48 kHz.
>    Camera and screen-capture files are frequently 96 kHz, and some are 192 kHz.
>    Feeding the source rate straight to `AudioBufferSource` throws "not supported
>    in this environment" and kills the export.
> 2. **Downmix to stereo.** AAC will take 5.1 in theory, but support is patchy
>    and the result is needlessly large.

This is a *capability negotiation with the encoder*, not a quality decision. 48 kHz
is not better than 96 kHz; it is the only rate that reliably encodes. The
function returns the input unchanged when it is already conformant, so the
common case is free.

### Mixing: `mixTimeline` (`:139`)

25 lines of `Float32Array` arithmetic, and the whole export's sound:

```ts
for (const segment of segments) {
  const startSample = Math.round(segment.start * OUTPUT_SAMPLE_RATE)
  if (startSample >= totalFrames) continue

  const gain = segment.gain ?? 1
  const count = Math.min(src.length, totalFrames - startSample)

  for (let i = 0; i < count; i++) {
    left[startSample + i]! += srcLeft[i]! * gain
    right[startSample + i]! += srcRight[i]! * gain
  }
}
```

Two things to notice, and they are the whole design:

1. **`startSample` is computed once, at the boundary, from an integer.** The mix
   loop never does float maths. `src/audio/export-audio.ts:9` states the consequence
   plainly: "Accumulating float seconds across clips is how A/V drift is born — a
   five-line bug that costs a day and is invisible in a 5-second test."
2. **Gaps are silence, not holes.** The output buffer is allocated to the full
   `duration` and gaps simply stay zero. A gap in the timeline is a gap in the
   audio, and skipping it would shift everything after it.

The output is one stereo `AudioBuffer` covering the entire timeline. No Web
Audio graph, because a graph is stateful and its output depends on construction
order — for trim-and-concatenate that is enormous overkill that buys
non-determinism. [ADR-4](../decisions/0004-deterministic-audio-mixing.md) is
three paragraphs on this and is worth reading.

`chunkAudioBuffer` (`:73`) and `concatAudioBuffers` (`:94`) exist only because
WebCodecs wants audio in bounded pieces; they are the seams between "one buffer"
and "the encoder's call signature".

## `export-audio.ts` — assemble the track

`buildExportAudio` (`:36`) is the conductor: for each audio clip, find its
timeline position with `clipStart`, read its decoded audio from the
`MediaLibrary`, trim it to the clip, conform it, and hand the result to
`mixTimeline` as a `MixSegment`.

The key architectural point is that it **decodes each clip independently and mixes
at the end**, rather than building one continuous decode per source file. That
is what makes arbitrary overlapping clips possible — a second clip of the same
asset is just another segment, and the mix is additive.

`verifyAudioTrack` (`:101`) is the cheap post-check: is there audio where there
should be, and is it actually non-silent? A file that exports "successfully"
with a silent track is a real failure mode, and this catches it without decoding
the muxed result.

## `audio-engine.ts` — preview only

385 lines, and the docblock is the clearest statement of preview-vs-export
anywhere in the repo:

> Deliberately minimal: per-clip gain and mute, no master bus, no waveform, no
> speed control. A mixer is a different feature.

Its job is to make noise *agree with the playhead*, and it does so by inverting
the usual causality: the AudioContext clock is the master, and the playhead is
derived from it. [Trace 02](02-playback.md) walks that in full; the parts that
belong here are the scheduling ones.

- `play(project, position)` (`:133`) walks **the audio lane only** — the comment
  says "The picture is the exporter's business" — and for each clip computes
  `sourceFrom = clip.in + offsetIntoClip` and a `delay` for future clips.
- `#runStart = ctx.currentTime + START_LEAD` (`:149`, constant at `:349`) is deliberately in the
  future, so sources are ready before the timeline says they start.
- `now()` (`:121`) reads that clock back and clamps at zero, because during the
  lead the elapsed time is negative. The comment records the resulting hang.

Why not reuse `mixTimeline` for preview? Because preview needs to start *now*,
from an arbitrary point, and stop instantly. A pre-mixed buffer cannot do that
without mixing the whole timeline on every play. The graph is the right tool for
"start and stop arbitrarily"; the arithmetic is the right tool for "produce one
file". Same audio, genuinely different problems.

## The contract between them

This is the part worth understanding deeply, because it is the actual A/V sync
guarantee:

| | Preview | Export |
| --- | --- | --- |
| Where a clip starts | `clipStart(project.audio, i)` | `clipStart(project.audio, i)` |
| Where a clip's audio begins | `clip.in + offsetIntoClip` | `clip.in`, then trim to the clip |
| Gains | live `GainNode` per clip | `segment.gain`, multiplied in the mix |
| Gaps | scheduled silence via `delay` | zero-filled buffer |
| Rounding | none (real-time) | `Math.round(start * 48000)`, once |
| Muting | `GainNode` to 0 | gain 0 |

**Both sides derive a clip's timeline position from `clipStart`.** That shared
function is the actual contract. If preview computed positions one way and
export another, the app would be self-consistent and the file would still be
wrong — and it would look perfect while being wrong, which is the worst kind of
bug.

Note the rounding row. Preview does no rounding because it is real-time and
continuous. Export rounds once, at the boundary. That asymmetry is safe only
because both sides start from the same float and convert at the same point.

## Where the export's audio meets the export's video

`src/output/exporter.ts` builds the video track frame by frame and the audio
track in one pass, and the two are written into the same `Output` in one
`start()`/`finalize()`. The two tracks have independent timelines that must
describe the same instant, which brings back the distinction from
[trace 02](02-playback.md):

- **video frame k**: source time `clip.in + k / fps`, output time `cursor / fps`
- **audio sample i**: source offset `i / 48000`, output index `cursor * 48000 / fps`

Two different notions of time, and mixing them up is what turned a 15-second
clip into a 445-second export. `test/exporter.test.ts` is largely about
protecting that separation.

## What to do next

Read `mixTimeline` (`:139`) twice, then change `OUTPUT_SAMPLE_RATE` to 44100 and
run the tests. Nothing fails, because 44100 is a perfectly reasonable sample
rate — the tests do not encode *which* rate is correct. The constraint is
documented in the docblock and nowhere else. Knowing that is part of knowing this
codebase.
