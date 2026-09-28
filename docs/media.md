# Media handling

How a dropped file becomes decodable frames, and the four things about media
files that are not what you would guess.

## Import

```
addFiles(files)                     state.ts
  └─▶ library.add(file)             opens a File and a mediabunny Input
        └─▶ probe.ts               File → Asset
              └─▶ project.assets   the bin renders it
```

Importing deliberately does **not** touch the timeline. Adding a file to the
project and adding it to the edit are separate acts, because a stray double-click
should never be able to mutate an edit.

`media/library.ts` is kept deliberately dumb: it loads, probes, and hands out decoders.
It does not know what a project is.

## Probing: `media/probe.ts`

`File → Asset`. This is where the awkward facts get discovered, and it is the
single most important function for compatibility.

### Variable frame rate

Screen recordings from OBS, QuickTime and most capture tools are **VFR** — frames
arrive at irregular intervals, because the encoder only emitted a frame when the
screen changed.

Any `frameIndex = round(t × fps)` is **wrong** for these, and wrong *silently*: the
video plays at the right speed but drifts against the audio, or the last frame
never appears.

At probe time, the sum of sample deltas is compared against the container
duration. If they disagree by more than about 1%, the asset is marked
`variableFrameRate: true`.

| | Handling |
|---|---|
| **CFR** | The sample table is uniform. Index directly: `frame = round(t × fps)`. |
| **VFR** | Build a sorted PTS array once: `frame = upperBound(pts, t) - 1` — the last frame that started at or before *t*. |

Screen recordings are exactly the files a cutter's audience has, so this is not an
edge case.

> Observed on a real capture: `bestGuess 3.75 fps`, `min 1.94`, `max 60`,
> `average 3.94`. A `round(t × 3.75)` mapping is meaningless there.

### Rotation and aspect ratio

Phone video is stored landscape with a 90° rotation flag in the MP4 `tkhd` matrix.
**Ignore it and every portrait clip exports sideways** — the single most common
"why is this broken" bug in browser video tools.

The matrix is read at probe, normalised to `0 | 90 | 180 | 270`, and applied as a
canvas transform in `render.ts` — so it is applied identically in preview and
export, which is only possible because there is one renderer
([ADR-1](decisions/0001-one-render-function.md)).

Pixel aspect ratio is handled too. Anamorphic DV is rare but appears in archives,
and the fix is two lines.

## Frame cache: `media/frame-cache.ts`

Split out from `media/library.ts` specifically so it has **no mediabunny dependency**.
Pure logic, so it is testable in Node.

Scrubbing the playhead backwards and forwards should not re-decode. The cache
holds recently decoded frames and reuses one when the requested time falls inside
it. A stale frame is discarded explicitly and logged, because a frame from the
wrong timestamp is the kind of bug that looks like lag and gets tolerated.

## Waveforms: `media/peaks.ts`

The point of a waveform is to answer one question at a glance: *where is the dead
air?*

- Peaks at 200/second, computed **once per asset** during the audio decode that
  already happens, then cached and reused.
- Redrawn only on zoom or trim — never per frame.
- **Extremes are preserved when downsampling to pixels**, so a transient is never
  lost to a bucket boundary. A waveform that quietly deletes peaks is worse than
  no waveform, because people cut on it.

`findSilence()` already exists for a future "shade the dead air" pass.

## Preview audio vs export audio

Three separate files, because they are three different jobs, and merging them is
how preview ends up audible during an export.

| Module | Job |
|---|---|
| `audio/audio-engine.ts` | **Preview** playback. Scheduling, caching of decoded buffers, gain. |
| `audio/audio.ts` | **Export** preparation. Conform sample rate, downmix channels, trim. |
| `audio/export-audio.ts` | The **export track**. One mixed `Float32Array`. |

The hard part of preview audio is not making noise, it is making the noise agree
with the picture. Mixing, for export, is deliberately deterministic
([ADR-4](decisions/0004-deterministic-audio-mixing.md)).

## The sample rate trap

AAC via WebCodecs only accepts **44.1 and 48 kHz**. Camera and screen-capture
files are frequently 96 kHz. Feeding the source rate straight to the encoder
throws `This specific encoder configuration is not supported in this environment`
and kills the export.

`audio/audio.ts` resamples to 48 kHz and downmixes anything above stereo. This is
invisible in a 5-second test with a phone recording, and costs a day to find the
first time a microphone interface shows up.

See [export.md](export.md#av-sync) for the full list of things that break A/V
sync.
