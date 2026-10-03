# Risk register

What is known to be fragile, and what is being done about it. A risk that is not
written down is a risk that gets rediscovered at the worst moment.

## R1 — A/V sync

**The project fails here or it doesn't ship.**

Aligning two independent streams — video at frame boundaries, audio at sample
boundaries — has six distinct ways to go wrong, listed in
[export.md](export.md#av-sync). The sync assertions are written before the export
code, not after.

*Status:* the assertions exist and run (`test/export-audio.test.ts`).
**Remaining gap:** `verifyAudioTrack` checks the audio against the duration it
was built from, so it is self-consistent by construction and **cannot** detect a
video-length error. The video timestamps have their own test; nothing yet
verifies the *muxed result* end to end.

## R2 — Encode speed

**Largely resolved. [ADR-3](decisions/0003-re-encode-only.md)
settled — no stream-copy fast path.**

The first measurement, and the fix:

| | Before | After (720p) | After (1080p) |
|---|---|---|---|
| Throughput | 15.8 fps | 218 fps | **154 fps** |
| Realtime factor | 0.53× (slower than realtime) | 7.27× | **5.13×** |
| 10-minute edit | ~6.3 min | ~1m 23s | **~1m 57s** |
| Decode share | 99% of wall clock | ~0% | ~0% |
| Trend | degrading 22.5 → 13.6 fps | stable | **stable** |

**The lesson worth keeping:** a 13× miss on the critical path came from not
reading the library's docs for a function that was right there in the type
definitions. `CanvasSink.getCanvas(t)` per frame re-seeks and re-decodes from the
preceding keyframe; `canvasesAtTimestamps()` over sorted timestamps decodes each
packet once. Separately, skipping the redraw when `WrappedCanvas.timestamp` is
unchanged cut 84% of draws.

**⚠️ This benchmark is the easy case. Do not treat 154 fps as the product number.**

| Flattering factor | Reality |
|---|---|
| Source is 3.75 fps VFR | A real 30 fps camera video is 8× the frames |
| Content is near-static | Screen recordings compress to almost nothing; motion does not |
| Output 720p VP9 | 1080p is 2.25× the pixels; 4K is 9× |
| Main thread | Not the shipping configuration |

A realistic estimate for 1080p30 with real motion is well below 154 fps,
plausibly 40–80×.

**Outstanding:** re-measure on a genuine 30 fps CFR clip at 1080p. Only then is
this closed for good. If it lands above 30 fps, stream-copy is definitively dead
and a worker pool is unnecessary. If under, the next lever is a parallel decode
pool — but not before the measurement.

**Not a speed fix:** an `OffscreenCanvas` worker pool would stop the tab freezing
during a long export. It **buys no throughput**, it is a UX fix, and it must not
be confused with one.

## R3 — Browser fragmentation

**Confirmed real, not theoretical.**

Phase 0 could not encode AAC on Linux at all, which turned codec negotiation from
a nice-to-have into load-bearing product code. Safari has had WebCodecs since
16.4 but is less battle-tested for encoding.

**Untested:** Firefox and Safari export. This is the first thing to spike.

**Consequence:** the output format cannot be fixed at build time. "MP4" is a
preference, not a guarantee. The dialog probes and shows what is actually
available.

*Open decision:* whether this project is explicitly Chromium-first, and whether to
say so on the README. See [roadmap.md](roadmap.md#open-questions).

## R4 — Format coverage

ProRes, DNxHD, AC-3 and 10-bit HEVC cannot be opened, and never will without a
GPL fight ([ADR-7](decisions/0007-no-ffmpeg.md)). A permanent scope limit, not a
phase. Stated on the README.

## R5 — Scope creep toward Premiere

The failure mode for a "simple editor" is shipping a slightly worse Adobe. The
out-of-scope list is the defence; check every idea against it.

## R6 — "Cutter" turns into "NLE"

Multi-track compositing, transitions and an effects pipeline are each about a
week, and none are a cutter. **The moment the render pass grows a second code
path, [ADR-1](decisions/0001-one-render-function.md) is dead** — which is the
single most load-bearing invariant in the project.

## R7 — A project costs as much disk as its media

Solved, with a bill attached. Projects are saved, and the source files are
**copied into browser storage**, because a `File` is an OS handle and nothing can
recover it after a reload — a stored path would be worthless, because the web
platform cannot reopen a file by path.

So the trade is:

- A 2 GB project uses ~2 GB of browser storage, and the bytes are written **once**,
  at import. Only the few-KB edit is rewritten on every autosave, which is what
  makes autosaving affordable at all.
- `navigator.storage.persisted()` is checked, and a project living in evictable
  storage is reported. The browser may reclaim the origin under disk pressure, and
  a project that silently vanishes is worse than one that was never saved.
- **Projects are tied to one browser profile.** They are not portable and not
  shareable. Writing a real folder to disk is a separate feature, and it is
  Chromium-only today (File System Access API).

Media is deliberately *not* deduplicated by content hash. Sharing one blob
between projects would save space when the same file is used twice, but it needs
reference counting, and a wrong reference count silently deletes somebody's
footage. Per-project keys are boring and correct.

## R8 — Reopening must never destroy the edit

A saved project whose media has gone — evicted, or copied between browsers —
**still opens**. The clips and the timeline are intact, the assets that could not
be rebuilt are listed in the store as `missing`, and the user is told what to
re-import.

Refusing to open would have been simpler and would have thrown away the one
irreplaceable part. Media can be re-imported; a mangled timeline cannot. The
same reasoning is why the file format has a migration chain from the start:
`[docs/app/store/project-format.ts]` walks v2 forward a version at a time, and
refuses anything it cannot read *with a message that says the file is fine and
only the app is behind**.
